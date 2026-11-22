import crypto from 'crypto';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { UserService } from './userService';
import { SupportMoneyConfigService } from './supportMoneyConfigService';

/**
 * Google Play in-app purchase verification for the Android support tiers.
 *
 * ## Flow
 * The Android app completes a Play Billing purchase and posts its
 * `purchaseToken` and `productId` to `POST /api/v1/support-money/verify-play`,
 * behind the user's Firebase bearer. This service:
 *
 * 1. Asks Google (Android Publisher API, `purchases.products.get`) whether the
 *    token is a real, completed purchase of that product for our package. The
 *    client's word is never taken: the token is just a handle Google resolves.
 * 2. Checks the purchase belongs to THIS account. The client puts
 *    `sha256(uid)` into Play's `obfuscatedAccountId` when it launches the
 *    flow, and Google hands it back here. Without that check anyone holding
 *    someone else's token could credit themselves with their payment, because
 *    the ledger's duplicate check is per account.
 * 3. Records it in the same ledger Apple and Stripe write to, as
 *    `google_<orderId>`, which `recordSupportMoney` dedupes.
 * 4. Consumes it, server-side, so the same tier can be bought again and Google
 *    does not auto-refund it (an unacknowledged purchase is refunded after three
 *    days; consuming acknowledges it). Consuming HERE rather than on the device
 *    means a purchase is never used up before it is recorded: if anything above
 *    fails, it stays unconsumed and the app retries it on its next launch.
 *
 * ## Credentials
 * A Google service account with access to the app in Play Console
 * (Users and permissions: "View financial data" and "Manage orders and
 * subscriptions"). `GOOGLE_PLAY_KEY_PATH` names its key file; unset, the
 * Firebase Admin key is used, so granting that account Play access is enough.
 */

const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.stationly.mobile';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const PRODUCT_PREFIX = 'uk.co.stationly.support.';
/** Real tokens are a few hundred characters; anything far longer is not one. */
const MAX_TOKEN_LENGTH = 4096;

/** Play's `purchaseState`: 0 purchased, 1 cancelled, 2 pending. */
const PURCHASED = 0;
const PENDING = 2;

export interface GooglePlayVerifyResult {
    ok: boolean;
    reason?: string;
    /** True only the first time this purchase is credited; false on a retry. */
    recorded?: boolean;
    orderId?: string;
    productId?: string;
    amountMinor?: number;
    count?: number;
}

/** What `purchases.products.get` returns, narrowed to what is read here. */
export interface PlayProductPurchase {
    purchaseState?: number;
    consumptionState?: number;
    orderId?: string;
    purchaseTimeMillis?: string;
    obfuscatedExternalAccountId?: string;
    purchaseType?: number;
}

/** The two Google calls, behind a seam so the rules can be tested without Google. */
export interface PlayApi {
    getPurchase(productId: string, token: string): Promise<PlayProductPurchase | null>;
    consume(productId: string, token: string): Promise<void>;
}

/** The account binding the Android client puts into `obfuscatedAccountId`. */
export function playAccountId(uid: string): string {
    return crypto.createHash('sha256').update(uid, 'utf8').digest('hex');
}

function googleAuth(): GoogleAuth {
    const keyFile = process.env.GOOGLE_PLAY_KEY_PATH
        || process.env.FIREBASE_KEY_PATH
        || './serviceAccountKey.json';
    return new GoogleAuth({ keyFile: path.resolve(keyFile), scopes: [SCOPE] });
}

class LivePlayApi implements PlayApi {
    private auth: GoogleAuth | null = null;

    private url(productId: string, token: string): string {
        return `${API}/${encodeURIComponent(PACKAGE_NAME)}/purchases/products/` +
            `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
    }

    private async client() {
        this.auth = this.auth ?? googleAuth();
        return this.auth.getClient();
    }

    async getPurchase(productId: string, token: string): Promise<PlayProductPurchase | null> {
        const client = await this.client();
        try {
            const res = await client.request<PlayProductPurchase>({ url: this.url(productId, token) });
            return res.data ?? null;
        } catch (err: any) {
            const status = err?.response?.status;
            // 400/404/410: Google does not know this token for this product.
            // That is an answer ("not a purchase"), not an outage.
            if (status === 400 || status === 404 || status === 410) return null;
            // 401/403: OUR credentials, not the purchase. The usual causes are
            // setup steps, so say which, once per failure, instead of a trace.
            if (status === 401 || status === 403) {
                console.error(
                    `GOOGLE_PLAY: ❌ Google refused our credentials (HTTP ${status}): ` +
                    `${err?.response?.data?.error?.message ?? err?.message}. ` +
                    'Check: the Google Play Android Developer API is enabled in the service ' +
                    "account's Cloud project, and that account is invited in Play Console " +
                    'with "View financial data" and "Manage orders and subscriptions".'
                );
            }
            // Thrown, so the route answers 5xx and the app retries later: the
            // purchase stays unconsumed rather than being refused for our fault.
            throw err;
        }
    }

    async consume(productId: string, token: string): Promise<void> {
        const client = await this.client();
        await client.request({ url: `${this.url(productId, token)}:consume`, method: 'POST' });
    }
}

export class GooglePlayIAPService {
    /** Replaced in tests. */
    static api: PlayApi = new LivePlayApi();

    /** Pence for a product id, from the served tier list; 0 when unknown. */
    static amountFor(productId: string): number {
        const tiers = SupportMoneyConfigService.getSupportMoneyConfig('android').tiers;
        return tiers.find(t => t.google_product_id === productId)?.amount_minor ?? 0;
    }

    static async verifyAndRecord(uid: string, productId: string, purchaseToken: string): Promise<GooglePlayVerifyResult> {
        if (!uid || typeof uid !== 'string' || !uid.trim()) return { ok: false, reason: 'missing_uid' };
        if (!purchaseToken || typeof purchaseToken !== 'string' || !purchaseToken.trim()) {
            return { ok: false, reason: 'missing_purchase_token' };
        }
        if (purchaseToken.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'invalid_purchase_token' };
        if (!productId || typeof productId !== 'string' || !productId.startsWith(PRODUCT_PREFIX)) {
            return { ok: false, reason: 'unknown_product_id' };
        }
        // The price comes from OUR tier list, never from the client. A product
        // we do not sell is refused rather than credited at a guessed amount.
        const amountMinor = this.amountFor(productId);
        if (amountMinor <= 0) return { ok: false, reason: 'unknown_product_id' };

        const purchase = await this.api.getPurchase(productId, purchaseToken);
        if (!purchase) return { ok: false, reason: 'purchase_not_found' };
        if (purchase.purchaseState === PENDING) return { ok: false, reason: 'purchase_pending' };
        if (purchase.purchaseState !== PURCHASED) return { ok: false, reason: 'purchase_not_completed' };

        // Required, not best-effort: every purchase this app launches carries
        // it, so a purchase without one did not come from this app's flow.
        if (purchase.obfuscatedExternalAccountId !== playAccountId(uid)) {
            console.error(`GOOGLE_PLAY: ❌ Account mismatch on ${purchase.orderId ?? 'unknown order'} for ${uid}`);
            return { ok: false, reason: 'account_mismatch' };
        }

        const orderId = purchase.orderId || `token_${crypto.createHash('sha256').update(purchaseToken).digest('hex').slice(0, 32)}`;
        const atMs = Number(purchase.purchaseTimeMillis);

        const outcome = await UserService.recordSupportMoney({
            uid,
            txnId: `google_${orderId}`,
            amountMinor,
            currency: 'GBP',
            nowMs: Number.isFinite(atMs) && atMs > 0 ? atMs : Date.now(),
        });
        if (!outcome.recorded && outcome.reason !== 'duplicate_txn') {
            // No account to credit (deleted mid-purchase). Left unconsumed:
            // Google refunds it after three days, which is the right ending
            // for a payment nobody can be credited for.
            return { ok: false, reason: outcome.reason ?? 'not_recorded' };
        }

        // Consumed even on a duplicate: that is the retry after a consume that
        // failed last time, and leaving it would block a repeat purchase.
        if (purchase.consumptionState !== 1) {
            try {
                await this.api.consume(productId, purchaseToken);
            } catch (err) {
                // Recorded already, so the user is credited. The app finds the
                // purchase still unconsumed on its next launch and sends it
                // again, which lands in the duplicate branch and consumes then.
                console.warn(`GOOGLE_PLAY: ⚠️ Consume failed for ${orderId}; will retry from the client`, err);
            }
        }

        if (purchase.purchaseType === 0) {
            console.log(`GOOGLE_PLAY: test purchase ${orderId} (license tester) for ${uid}`);
        }
        console.log(`GOOGLE_PLAY: ✅ ${outcome.recorded ? 'Recorded' : 'Already had'} ${orderId} for ${uid} (count: ${outcome.count})`);

        return {
            ok: true,
            recorded: outcome.recorded,
            orderId,
            productId,
            amountMinor,
            count: outcome.count,
        };
    }
}
