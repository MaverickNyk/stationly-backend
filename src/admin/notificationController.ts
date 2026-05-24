import { Request, Response } from 'express';
import { NotificationService, Audience, NotificationPayload } from './notificationService';

/**
 * Admin-only controller for fanning out notifications to users.
 *
 * Intentionally NOT decorated with `@swagger` annotations — this
 * endpoint stays off the OpenAPI docs (one less thing surfaced to
 * automated scanners) and is only reachable via the `X-Stationly-
 * Admin-Key` header guarded by [AdminAuthMiddleware].
 *
 * Request shape:
 * ```
 * POST /admin/notifications/send
 * X-Stationly-Admin-Key: <secret>
 * Content-Type: application/json
 *
 * {
 *   "audience": { "type": "token" | "tokens" | "topic", "value": ... },
 *   "payload":  { ...NotificationPayload }
 * }
 * ```
 *
 * Response: 200 with delivery counts; 400 on malformed body; 401/403
 * from the middleware on bad / missing auth.
 */
export class NotificationController {
    static async send(req: Request, res: Response) {
        const body = req.body ?? {};
        const audience = body.audience as Audience | undefined;
        const payload  = body.payload  as NotificationPayload | undefined;

        if (!audience || !audience.type) {
            return res.status(400).json({
                error: 'Bad Request',
                message: "Missing 'audience' { type, value }",
            });
        }
        if (!payload) {
            return res.status(400).json({
                error: 'Bad Request',
                message: "Missing 'payload' NotificationPayload object",
            });
        }

        try {
            const result = await NotificationService.send(audience, payload);
            console.log(
                `ADMIN_NOTIF: 📤 type=${payload.type} audience=${audience.type} ` +
                `ok=${result.successCount} fail=${result.failureCount}`
            );
            return res.json(result);
        } catch (e: any) {
            console.warn('ADMIN_NOTIF: send failed', e?.message);
            return res.status(400).json({
                error: 'Bad Request',
                message: e?.message ?? 'Failed to send notification',
            });
        }
    }
}
