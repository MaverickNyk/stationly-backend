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
}
