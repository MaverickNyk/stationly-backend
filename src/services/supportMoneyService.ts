import { LocalDbService } from './localDbService';
import { SupportMoneyConfigService } from './supportMoneyConfigService';
import { UserService } from './userService';
import { isStaging } from '../utils/formatters';

/**
 * Contributions — the money half of the "support Stationly" feature.
 *
 * ## Boundary
 * This service OWNS: Stripe event interpretation, idempotency, and deciding
 * whether an event credits an account. It owns no badge maths at all any more:
 * a contribution is a row with a timestamp, and how long that keeps the badge is
 * decided at READ time from the configured window. See [SupportMoneyEntry]. It does NOT write
 * the user document — that goes through {UserService.recordSupportMoney}, because
 * the §2 invariant of `DESIGN_SESSIONS_AND_SYNC.md` is that every `users/{uid}`
 * write flows through `UserService` (so the `stateRev` bump and the `user.sync`
 * fan-out happen exactly once, in one place).
 *
 * ## Guarantees the webhook route relies on
 *  - **Idempotent.** Stripe redelivers events (at-least-once). Every event id
 *    is recorded in SQLite the moment it is applied; a redelivery is a no-op
 *    that still returns a 2xx-worthy result. {UserService.recordSupportMoney} keeps
 *    a second guard (every `txnId` already on the document) at the document
 *    layer.
 *  - **Total.** Every input maps to one of {SupportMoneyOutcome} — it never throws
 *    for a shape it does not recognise. An event we cannot attribute to an
 *    account is logged loudly and returned as `unattributed` (the money still
 *    arrived; a human has to reconcile it), never dropped silently and never a
 *    500 that makes Stripe retry forever.
 *
 * ## Scope right now
 * One-off contributions only. `customer.subscription.*` is acknowledged and
 * ignored, and there is no longer a tier distinction to get wrong: a
 * subscription checkout, if one were ever enabled, would record exactly the row
 * a one-off does. That is a genuine simplification rather than a shortcut —
 * under the ledger model a renewal is just another row, so a recurring supporter
 * would keep the badge by paying rather than by a subscription-shaped special
 * case. What is still missing for Phase 2 is only the renewal event itself
 * (`invoice.payment_succeeded`), never wired.
 */

export type SupportMoneyOutcome =
    | { status: 'recorded'; uid: string; amountMinor: number; txnId: string; count: number }
    | { status: 'duplicate'; eventId: string }
    | { status: 'ignored'; reason: string }
    | { status: 'unattributed'; eventId: string; amountMinor: number };

// ─── pure helpers (exported for the regression suite) ────────────────────────

/**
 * The Stripe id that identifies this transaction for the rest of its life.
 *
 * The Checkout Session, not the event. See [SupportMoneyEntry.txnId] for the
 * full reasoning; the short version is that one session can emit two crediting
 * events, so the event id is the wrong key for "has this payment landed".
 *
 * Falls back to the event id only when a session somehow carries no id, which
 * keeps the ledger keyed on SOMETHING rather than on the empty string — an
 * empty key would make every unidentifiable payment look like the same one.
 */
export function txnIdFor(session: any, eventId: string): string {
    return typeof session?.id === 'string' && session.id ? session.id : eventId;
}

/**
 * A `client_reference_id` is usable as a uid only if it is a non-empty string
 * within Firebase's uid length bounds (1–128). Anything else means the Payment
 * Link was opened without `?client_reference_id={uid}` and the payment cannot
 * be attributed.
 */
export function isUsableUid(value: unknown): value is string {
    return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

// ─── idempotency ledger (SQLite `stripe_events`) ────────────────────────────

export class StripeEventLedger {
    static async has(eventId: string): Promise<boolean> {
        try {
            const row = await LocalDbService.get<{ event_id: string }>(
                'SELECT event_id FROM stripe_events WHERE event_id = ?',
                [eventId],
            );
            return !!row;
        } catch (err) {
            // Do NOT guess. The old behaviour here was to assume "already seen",
            // which made `processStripeEvent` answer `duplicate` and the route
            // answer 200 — telling Stripe the event was handled when in fact a
            // contribution had just been dropped, with no redelivery to recover
            // it. Rethrow instead: the route turns this into a 500, Stripe
            // retries for ~3 days, and a transient SQLite problem costs a delay
            // rather than someone's money. A permanent one fails loudly.
            console.error('SUPPORT_MONEY: ❌ stripe_events read failed — asking Stripe to retry', err);
            throw err;
        }
    }

    static async mark(eventId: string, type: string): Promise<void> {
        try {
            await LocalDbService.run(
                'INSERT OR IGNORE INTO stripe_events (event_id, type, processed_at) VALUES (?, ?, ?)',
                [eventId, type, Date.now()],
            );
        } catch (err) {
            // The document-layer guard (the `txnId` already on the document)
            // still holds, so a lost mark costs at most one redundant no-op
            // read on redelivery.
            console.warn('SUPPORT_MONEY: ⚠️ stripe_events write failed', err);
        }
    }
}

/**
 * The one log line a human greps when money has arrived that nobody holds.
 *
 * Two different faults land here — a checkout opened without
 * `client_reference_id`, and a uid whose account no longer exists — and both
 * need the same facts in the same shape to be reconciled from the Stripe
 * dashboard. Keeping one formatter means the second cause can never quietly
 * acquire a log line that the first's alert does not match.
 */
function logUnattributed(fault: string, eventId: string, amountMinor: number, currency: string, session: any): void {
    const email = session?.customer_details?.email ?? session?.customer_email ?? '?';
    console.error(
        `SUPPORT_MONEY: ❌ UNATTRIBUTED contribution — ${fault}. ` +
        `event ${eventId}, amount ${amountMinor} ${currency}, ` +
        `session ${session?.id ?? '?'}, customer_email ${email}. ` +
        `Reconcile by hand from the Stripe dashboard.`,
    );
}

/**
 * The Checkout events that can credit an account.
 *
 * `checkout.session.completed` is the card / Apple Pay case: the session
 * completes already `paid`. Delayed methods (bank debits, some wallets) complete
 * `unpaid` and settle later — Stripe then sends
 * `checkout.session.async_payment_succeeded` carrying the same session, now
 * paid. Handling only the first event means that money arrives and the badge
 * never does. Both carry an identical `data.object`, so one code path serves
 * them; the `payment_status` check below is what actually decides, and the
 * unpaid first event is ignored (and ledgered) on its own.
 *
 * `checkout.session.async_payment_failed` and `.expired` need no handler —
 * nothing was ever credited, so there is nothing to undo.
 */
const CREDITING_EVENT_TYPES = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
]);

// ─── the service ───────────────────────────────────────────────────────────

export class SupportMoneyService {
    /**
     * Interpret one verified Stripe event and, if it credits an account, record
     * the contribution. Caller has ALREADY verified the signature — this method
     * trusts `event` to be authentic Stripe JSON.
     */
    static async processStripeEvent(event: any): Promise<SupportMoneyOutcome> {
        const eventId: string = typeof event?.id === 'string' ? event.id : '';
        const type: string = typeof event?.type === 'string' ? event.type : 'unknown';

        if (!eventId) return { status: 'ignored', reason: 'event has no id' };

        // Subscription lifecycle — acknowledged, deferred to Phase 2.
        if (type.startsWith('customer.subscription.')) {
            console.log(`SUPPORT_MONEY: subscription lifecycle event ${type} acknowledged (Phase 2, not applied)`);
            return { status: 'ignored', reason: `subscription lifecycle (${type}) is Phase 2` };
        }

        if (!CREDITING_EVENT_TYPES.has(type)) {
            return { status: 'ignored', reason: `unhandled event type ${type}` };
        }

        if (await StripeEventLedger.has(eventId)) {
            return { status: 'duplicate', eventId };
        }

        const session = event?.data?.object ?? {};

        // A completed session that was not actually paid (e.g. an async payment
        // still pending). Only `paid` / `no_payment_required` credit an account.
        const payment = session.payment_status;
        if (payment && payment !== 'paid' && payment !== 'no_payment_required') {
            await StripeEventLedger.mark(eventId, type);
            return { status: 'ignored', reason: `payment_status=${payment}` };
        }

        const uid = session.client_reference_id;
        const amountMinor = Number.isFinite(session.amount_total) ? Math.floor(session.amount_total) : 0;
        const currency = typeof session.currency === 'string' ? session.currency.toUpperCase() : 'GBP';
        const txnId = txnIdFor(session, eventId);

        if (!isUsableUid(uid)) {
            logUnattributed('no usable client_reference_id on the checkout', eventId, amountMinor, currency, session);
            await StripeEventLedger.mark(eventId, type);
            return { status: 'unattributed', eventId, amountMinor };
        }

        const now = Date.now();

        try {
            const result = await UserService.recordSupportMoney({
                uid,
                txnId,
                amountMinor,
                currency,
                nowMs: now,
            });
            await StripeEventLedger.mark(eventId, type);

            if (!result.recorded) {
                if (result.reason === 'missing_account') {
                    // Paid, signature-verified, and the uid names no account —
                    // deleted between checkout and webhook, or a hand-edited
                    // link. The money is real and nobody holds it, so this is
                    // reconciliation work, not a benign redelivery.
                    logUnattributed(`uid ${uid} has no account`, eventId, amountMinor, currency, session);
                    return { status: 'unattributed', eventId, amountMinor };
                }
                // The document already carries this txnId — a redelivery the
                // SQLite ledger missed, or the second of the two crediting
                // events one session can emit. Benign either way.
                return { status: 'duplicate', eventId };
            }

            const activeUntil = now + SupportMoneyConfigService.badgeDurationMs();
            console.log(
                `SUPPORT_MONEY: ✅ contribution #${result.count} recorded for ${uid} — ` +
                `${amountMinor} ${currency}, txn ${txnId}, badge until ` +
                `${new Date(activeUntil).toISOString()} ` +
                `(env=${isStaging() ? 'staging' : 'production'}, event=${eventId})`,
            );
            return { status: 'recorded', uid, amountMinor, txnId, count: result.count };
        } catch (err: any) {
            // A genuine Firestore failure. Do NOT mark processed — let Stripe
            // redeliver so it gets applied on a later attempt. The webhook route
            // turns this into a 500 for the same reason.
            console.error(`SUPPORT_MONEY: ❌ recordSupportMoney threw for ${uid} (event ${eventId})`, err);
            throw err;
        }
    }
}
