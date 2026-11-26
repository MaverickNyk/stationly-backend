import { db } from '../config/firebase';

/**
 * What supporters have given this month, for the "running costs" line in the
 * app (`support_money.progress.*`).
 *
 * ## One flat row per payment, keyed by its transaction id
 *   support_money_txns/{txnId}
 *     { txnId, month: 'YYYY-MM' (London), atMs, amountMinor, currency, source }
 *
 * Every route that takes money (StoreKit, Play Billing, Stripe in the app,
 * Stripe on the website) already ends in exactly one place per payment:
 * `UserService.recordSupportMoney` for an account, `recordWebDonation` for the
 * website. Both call [recordTxn] after their own write has succeeded.
 *
 * Keyed by the transaction id, so a redelivered webhook or a retried store
 * verification writes the same document again and the total cannot count one
 * payment twice. That is why this is a set of rows that is summed on read and
 * not a running counter: `increment` has no way to know whether this payment
 * was already added.
 *
 * ## Never on the payment path's critical section
 * A failure here is logged and swallowed. The ledger on the account is what
 * the badge and any refund conversation rely on; a missing row here costs a
 * slightly low figure on a progress bar.
 *
 * ## Read: cached, never awaited by home-config
 * `homeConfigKeys` is synchronous and serves every app launch, so it reads
 * [current], which answers from memory and refreshes in the background when
 * the figure is older than [TTL_MS]. Under PM2 cluster each process keeps its
 * own copy; they agree within one TTL.
 *
 * ## What is in the figure
 * Real money only: store test purchases (license testers, Apple sandbox) and
 * unverified Apple receipts are not written here (`countInTotal`). Payments
 * from before this collection existed are not in it (no backfill), and a
 * refund does not remove its row: both are on the backlog.
 */

export interface SupportMoneyTxnRow {
    txnId: string;
    month: string;
    atMs: number;
    amountMinor: number;
    currency: string;
    source: 'apple' | 'google' | 'stripe' | 'web';
}

export interface SupportMoneyMonth {
    /** London calendar month, `YYYY-MM`. */
    month: string;
    /** Sum of this month's GBP payments, in pence. Gross: before any store's cut. */
    raisedMinor: number;
    /** How many payments make up [raisedMinor]. */
    count: number;
}

const COLLECTION = 'support_money_txns';

/** The London calendar month an instant falls in, as `YYYY-MM`. */
export function londonMonth(ms: number): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', year: 'numeric', month: '2-digit',
    }).formatToParts(new Date(ms));
    const y = parts.find(p => p.type === 'year')?.value ?? '1970';
    const m = parts.find(p => p.type === 'month')?.value ?? '01';
    return `${y}-${m}`;
}

/** Which route a ledger id came from. Store ids carry a prefix; Stripe's are `cs_…`. */
export function txnSource(txnId: string, web = false): SupportMoneyTxnRow['source'] {
    if (web) return 'web';
    if (txnId.startsWith('apple_')) return 'apple';
    if (txnId.startsWith('google_')) return 'google';
    return 'stripe';
}

export class SupportMoneyStatsService {

    /** How stale the served figure may get before a background refresh. */
    static readonly TTL_MS = 10 * 60 * 1000;

    private static cache: { at: number; value: SupportMoneyMonth } | null = null;
    private static inflight: Promise<void> | null = null;

    /** Seams for the tests, which must never reach Firestore. */
    static writer: (row: SupportMoneyTxnRow) => Promise<void> = async (row) => {
        await db.collection(COLLECTION).doc(row.txnId).set(row);
    };
    static reader: (month: string) => Promise<Array<{ amountMinor?: unknown; currency?: unknown }>> = async (month) => {
        const snap = await db.collection(COLLECTION).where('month', '==', month).get();
        return snap.docs.map(d => d.data());
    };

    /**
     * Note one payment. Idempotent by [txnId]; never throws, whatever it is given.
     *
     * Afterwards the cached figure is marked stale rather than bumped in place:
     * a bump races with a refresh already in flight (which may or may not have
     * seen this row) and would double count or be overwritten. The next read
     * re-sums.
     */
    static async recordTxn(input: {
        txnId: string;
        amountMinor: number;
        currency: string;
        atMs: number;
        web?: boolean;
    }): Promise<void> {
        try {
            if (!input.txnId) return;
            // A date outside what Date can hold (a forged purchaseDate) would
            // make londonMonth throw; such a row is filed under now instead.
            const at = Number.isFinite(input.atMs) && Math.abs(input.atMs) < 8.64e15 ? input.atMs : Date.now();
            const row: SupportMoneyTxnRow = {
                txnId: input.txnId,
                month: londonMonth(at),
                atMs: Math.floor(at),
                amountMinor: Math.max(0, Math.floor(Number(input.amountMinor) || 0)),
                currency: (input.currency || 'GBP').toUpperCase(),
                source: txnSource(input.txnId, input.web === true),
            };
            await this.writer(row);
            if (this.cache) this.cache = { ...this.cache, at: 0 };
        } catch (err) {
            console.warn(`SUPPORT_MONEY: ⚠️ monthly total row not written for ${input?.txnId}:`, (err as any)?.message ?? err);
        }
    }

    /**
     * This month's figure from memory, refreshing in the background when stale.
     *
     * Null until a refresh has succeeded for this month: right after a restart
     * the process does not know the figure, and serving 0 would tell every app
     * that launches in that moment "nothing given yet", which it then caches.
     * The caller hides the line instead.
     */
    static current(nowMs = Date.now()): SupportMoneyMonth | null {
        const month = londonMonth(nowMs);
        const c = this.cache;
        const fresh = c && c.value.month === month && nowMs - c.at < this.TTL_MS;
        const backingOff = nowMs < this.retryAfter;
        if (!fresh && !backingOff) void this.refresh(nowMs);
        return c && c.value.month === month ? c.value : null;
    }

    /** After a failed refresh, no new attempt before this instant. */
    private static retryAfter = 0;
    private static readonly RETRY_MS = 60 * 1000;

    /** Re-sum this month. Single-flight; failures keep the previous figure and back off. */
    static refresh(nowMs = Date.now()): Promise<void> {
        if (this.inflight) return this.inflight;
        const month = londonMonth(nowMs);
        this.inflight = (async () => {
            try {
                const rows = await this.reader(month);
                let raisedMinor = 0;
                let count = 0;
                for (const r of rows) {
                    if (String(r.currency ?? 'GBP').toUpperCase() !== 'GBP') continue;
                    const amount = Number(r.amountMinor);
                    if (!Number.isFinite(amount) || amount <= 0) continue;
                    raisedMinor += Math.floor(amount);
                    count++;
                }
                this.cache = { at: Date.now(), value: { month, raisedMinor, count } };
                this.retryAfter = 0;
            } catch (err) {
                this.retryAfter = Date.now() + this.RETRY_MS;
                console.warn('SUPPORT_MONEY: ⚠️ monthly total refresh failed:', (err as any)?.message ?? err);
            } finally {
                this.inflight = null;
            }
        })();
        return this.inflight;
    }

    /** Tests only. */
    static resetForTest(): void {
        this.cache = null;
        this.inflight = null;
        this.retryAfter = 0;
    }
}
