import { Request, Response } from 'express';
import { SupportMoneyConfigService } from '../services/supportMoneyConfigService';
import { parseClientIdentity } from '../services/appReleaseService';

export class SupportMoneyController {
    /**
     * @swagger
     * /sdui/app/support-money-config:
     *   get:
     *     summary: Get the support / contributions card config
     *     description: >
     *       The structured Server-Driven UI payload for the "buy me a coffee"
     *       surfaces — heading, body, tiers, amounts, the reward-screen script,
     *       and the Supporter-badge lifecycle. Platform-neutral: iOS renders it
     *       today, Android and Web render the same object later. The identical
     *       content is also folded into `/sdui/app/home-config` under the
     *       `support_money.card.json` key and the `home.promo.support_money.*` keys, so a
     *       client that already fetches home-config needs no extra call.
     *
     *       `enabled` is `false` unless the server has `SUPPORT_MONEY_ENABLED=true`.
     *     tags: [SDUI]
     *     responses:
     *       200:
     *         description: JSON support-card config
     */
    static getConfig(req: Request, res: Response): void {
        const client = parseClientIdentity(req.headers['x-stationly-client'] as string);
        const platform = (req.query.platform as string) || client.platform;
        res.json(SupportMoneyConfigService.getSupportMoneyConfig(platform));
    }

    /**
     * @swagger
     * /support-money/web:
     *   get:
     *     summary: Support config for the stationly.co.uk /support/ page
     *     description: >
     *       Public and read-only (no API key): the amounts, copy and this
     *       environment's Stripe Payment Links for the website. `enabled` is
     *       false, and every `url` empty, until the web switch is on and all
     *       four links are configured.
     *     tags: [SDUI]
     *     responses:
     *       200:
     *         description: JSON web support config
     */
    static getWebConfig(_req: Request, res: Response): void {
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.json(SupportMoneyConfigService.getWebConfig());
    }

    /**
     * Verify a StoreKit 2 in-app purchase JWS transaction from iOS.
     */
    static async verifyIAP(req: Request, res: Response): Promise<void> {
        const user = (req as any).user;
        const uid = user?.uid || req.body.uid;

        if (!uid || typeof uid !== 'string') {
            res.status(401).json({ ok: false, error: 'Unauthorized: missing user uid' });
            return;
        }

        const signedPayload = req.body.signedPayload;
        if (!signedPayload || typeof signedPayload !== 'string') {
            res.status(400).json({ ok: false, error: 'Missing signedPayload' });
            return;
        }

        try {
            const { AppleIAPService } = await import('../services/appleIAPService');
            const result = await AppleIAPService.verifyAndRecord(uid, signedPayload);

            if (!result.ok) {
                res.status(400).json({ ok: false, error: result.reason || 'Verification failed' });
                return;
            }

            res.json(result);
        } catch (err: any) {
            console.error('SUPPORT_MONEY: ❌ verifyIAP route threw', err);
            res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    }

    /**
     * Verify a Google Play Billing purchase from Android and credit it.
     * Body: `{ productId, purchaseToken }`. See GooglePlayIAPService.
     *
     * 200 with `ok: true` means recorded (or already recorded) and consumed.
     * A 400 carries a `reason`; `purchase_pending` is not a failure, just not
     * yet, and the client keeps the purchase to send again when it completes.
     */
    static async verifyPlay(req: Request, res: Response): Promise<void> {
        const uid = (req as any).user?.uid;
        if (!uid || typeof uid !== 'string') {
            res.status(401).json({ ok: false, error: 'Unauthorized: missing user uid' });
            return;
        }
        const { productId, purchaseToken } = req.body ?? {};
        try {
            const { GooglePlayIAPService } = await import('../services/googlePlayIAPService');
            const result = await GooglePlayIAPService.verifyAndRecord(uid, productId, purchaseToken);
            if (!result.ok) {
                res.status(400).json({ ok: false, reason: result.reason, error: result.reason || 'Verification failed' });
                return;
            }
            res.json(result);
        } catch (err: any) {
            // A summary, never the error object: see describePlayError.
            const { describePlayError } = await import('../services/googlePlayIAPService');
            // A Google HTTP failure gets the one-line summary; anything else (a
            // bug, a Firestore failure) keeps its stack, with tokens masked.
            console.error(err?.response
                ? `SUPPORT_MONEY: ❌ verifyPlay route threw: ${describePlayError(err)}`
                : `SUPPORT_MONEY: ❌ verifyPlay route threw: ${String(err?.stack ?? err).replace(/tokens\/[^\s/?]+/g, 'tokens/***')}`);
            res.status(500).json({ ok: false, error: 'Internal server error' });
        }
    }
}
