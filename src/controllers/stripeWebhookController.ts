import { Request, Response } from 'express';
import { verifyStripeSignature } from '../utils/stripeSignature';
import { SupportMoneyService } from '../services/supportMoneyService';
import { isStaging } from '../utils/formatters';

/**
 * `POST /api/v1/webhooks/stripe`
 *
 * The only inbound path for contribution money. Mounted in `server.ts` BEFORE
 * `app.use('/api/v1', apiRoutes)` (so it skips the `X-Stationly-Key` gate —
 * Stripe sends no such header) and BEFORE the global `express.json()` (so the
 * RAW body survives for signature verification — a parse/re-serialise
 * round-trip reorders keys and the HMAC stops matching).
 *
 * ## Guard order — each layer fails closed
 *  1. `express.raw({ limit: '1mb' })` on the route — body is a Buffer or 413.
 *  2. `RateLimitMiddleware.webhook` — bounds unsigned-junk floods.
 *  3. Webhook secret must be configured, or 503 (never process unsigned).
 *  4. `Stripe-Signature` header present, or 400.
 *  5. HMAC-SHA256 signature matches AND timestamp within ±300s (replay), or 400.
 *  6. Body parses as JSON, or 400.
 *  7. `event.livemode` matches the environment, or 400 (test events must not
 *     touch production accounts, and vice versa).
 *
 * Only past all seven does {SupportMoneyService} see the event.
 *
 * ## Response contract (Stripe's, not ours)
 * Stripe retries on any non-2xx for up to ~3 days. So:
 *  - a REJECTED request (bad signature, wrong env, junk) → 400, and we WANT
 *    Stripe to stop retrying it — it will never become valid.
 *  - a HANDLED event (recorded / duplicate / ignored / unattributed) → 200.
 *  - an UNEXPECTED failure (Firestore down mid-write) → 500, so Stripe DOES
 *    retry and the contribution lands on a later attempt.
 * The 400s carry no detail — a probe cannot learn which check it tripped.
 */
export class StripeWebhookController {
    static async handle(req: Request, res: Response): Promise<Response> {
        // 1. Raw body.
        const raw = req.body;
        if (!Buffer.isBuffer(raw)) {
            console.warn('STRIPE_HOOK: ❌ body was not raw (express.raw not applied?)');
            return res.status(400).json({ error: 'bad request' });
        }

        // 3. Secret configured.
        const secret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret) {
            console.error('STRIPE_HOOK: ❌ STRIPE_WEBHOOK_SECRET not set — refusing to process.');
            return res.status(503).json({ error: 'not configured' });
        }

        // 4 + 5. Signature + replay window.
        const sig = req.header('Stripe-Signature');
        const verdict = verifyStripeSignature(raw, sig, secret);
        if (!verdict.ok) {
            console.warn(`STRIPE_HOOK: ❌ signature rejected — ${verdict.reason}`);
            return res.status(400).json({ error: 'bad request' });
        }

        // 6. Parse.
        let event: any;
        try {
            event = JSON.parse(raw.toString('utf8'));
        } catch {
            console.warn('STRIPE_HOOK: ❌ signed body did not parse as JSON');
            return res.status(400).json({ error: 'bad request' });
        }

        // 7. Environment fence. Stripe marks test-mode events `livemode: false`.
        // Staging must only act on test events; production only on live ones.
        // `STRIPE_ALLOW_LIVEMODE_MISMATCH=true` is an escape hatch for a one-off
        // replay during setup.
        const allowMismatch = (process.env.STRIPE_ALLOW_LIVEMODE_MISMATCH ?? '').toLowerCase() === 'true';
        const wantLive = !isStaging();
        if (!allowMismatch && typeof event.livemode === 'boolean' && event.livemode !== wantLive) {
            console.warn(
                `STRIPE_HOOK: ❌ livemode mismatch — event.livemode=${event.livemode}, ` +
                `env wants ${wantLive} (${isStaging() ? 'staging' : 'production'})`,
            );
            return res.status(400).json({ error: 'bad request' });
        }

        // Past the gate — hand it to the service.
        try {
            const outcome = await SupportMoneyService.processStripeEvent(event);

            if (outcome.status === 'recorded') {
                return res.status(200).json({ received: true, status: 'recorded' });
            }
            if (outcome.status === 'duplicate') {
                return res.status(200).json({ received: true, status: 'duplicate' });
            }
            if (outcome.status === 'unattributed') {
                // 200 on purpose: the money arrived, retrying will not attach a
                // uid that was never in the payment. Already logged loudly by
                // the service for manual reconciliation.
                return res.status(200).json({ received: true, status: 'unattributed' });
            }
            // ignored — an event type / state we don't act on.
            return res.status(200).json({ received: true, status: 'ignored', reason: outcome.reason });
        } catch (err: any) {
            // Genuine failure (Firestore transaction threw). 500 so Stripe
            // redelivers; the SQLite ledger was NOT marked, so the retry applies
            // it cleanly.
            console.error('STRIPE_HOOK: ❌ processing threw — asking Stripe to retry', err);
            return res.status(500).json({ error: 'processing failed' });
        }
    }
}
