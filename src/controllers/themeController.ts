import { Request, Response } from 'express';
import { ThemeService } from '../services/themeService';

/**
 * Theme-tokens endpoint. Mirrors the SduiController pattern — controller
 * is a thin pass-through; all logic lives in the service.
 */
export class ThemeController {
    /**
     * @swagger
     * /sdui/app/theme-tokens:
     *   get:
     *     summary: Get App Theme Tokens
     *     description: |
     *       Returns the canonical Stationly colour palette as a flat overlay
     *       (light bucket, dark bucket, constants bucket). The Android app
     *       caches the response in SharedPrefs and applies it on the next
     *       cold launch; offline / first-install installations fall back
     *       to hardcoded defaults baked into the app binary. Every key is
     *       optional; missing keys preserve the app-side default.
     *     tags: [SDUI, Theme]
     *     responses:
     *       200:
     *         description: ThemeTokensPayload
     */
    static getAppThemeTokens(req: Request, res: Response) {
        res.json(ThemeService.getAppThemeTokens());
    }
}
