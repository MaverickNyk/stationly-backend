import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { NotificationService, Audience, NotificationPayload } from './notificationService';
import { LocalDbService } from '../services/localDbService';

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
            // Audit the send to the LOCAL log (zero Firestore cost). Fire-and-
            // forget AFTER computing the result so it never blocks the response.
            logSend(audience, payload, true, result.successCount, result.failureCount, result.messageId);
            return res.json(result);
        } catch (e: any) {
            console.warn('ADMIN_NOTIF: send failed', e?.message);
            logSend(audience, payload, false, 0, 0, undefined);
            return res.status(400).json({
                error: 'Bad Request',
                message: e?.message ?? 'Failed to send notification',
            });
        }
    }

    /**
     * GET /api/v1/admin/notifications/history?limit=50
     *
     * Recent admin sends from the LOCAL audit log (SQLite). Per-instance and
     * Firestore-free by design. Raw tokens are never stored, so never returned.
     */
    static async history(req: Request, res: Response) {
        const limit = Number(req.query.limit ?? 50);
        try {
            const items = await LocalDbService.listAdminNotifications(limit);
            return res.json({ items, count: items.length });
        } catch (e: any) {
            console.warn('ADMIN_NOTIF: history read failed', e?.message);
            return res.status(500).json({
                error: 'Internal Server Error',
                message: e?.message ?? 'Failed to read notification history',
            });
        }
    }
}

/**
 * Redacted, aggregated one-line description of an audience for the audit log.
 * NEVER includes raw FCM token bytes — only types, counts, and the safe
 * identifiers (topic / line / uid) the admin already supplied.
 */
function audienceSummary(a: Audience): string {
    switch (a.type) {
        case 'token':  return 'token (single device)';
        case 'tokens': return `tokens (${Array.isArray(a.value) ? a.value.length : 0} devices)`;
        case 'topic':  return `topic: ${a.value}`;
        case 'uid':    return `uid: ${a.value}`;
        case 'uids':   return `uids (${Array.isArray(a.value) ? a.value.length : 0} users)`;
        case 'all':    return 'all users (broadcast)';
        case 'line':   return `line: ${a.value}`;
        default:       return (a as any).type ?? 'unknown';
    }
}

/** Append one entry to the local send-log. Fire-and-forget; errors are swallowed. */
function logSend(
    audience: Audience,
    payload: NotificationPayload,
    ok: boolean,
    successCount: number,
    failureCount: number,
    messageId: string | undefined,
): void {
    setImmediate(async () => {
        try {
            await LocalDbService.insertAdminNotification({
                id: crypto.randomUUID(),
                createdAt: Date.now(),
                audienceType: audience.type,
                audienceSummary: audienceSummary(audience),
                payloadType: payload.type ?? '',
                title: payload.title ?? '',
                body: payload.body ?? '',
                severity: payload.severity ?? '',
                successCount,
                failureCount,
                messageId: messageId ?? '',
                ok,
            });
            // Bound the log size; cheap, runs off the response path.
            await LocalDbService.purgeAdminNotifications(500);
        } catch (e: any) {
            console.warn('ADMIN_NOTIF: audit log write failed', e?.message);
        }
    });
}
