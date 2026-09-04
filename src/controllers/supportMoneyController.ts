import { Request, Response } from 'express';
import { SupportMoneyConfigService } from '../services/supportMoneyConfigService';

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
    static getConfig(_req: Request, res: Response): void {
        res.json(SupportMoneyConfigService.getSupportMoneyConfig());
    }
}
