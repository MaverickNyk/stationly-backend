import { Request, Response } from 'express';
import { UserFcmTokenService } from '../services/userFcmTokenService';

/**
 * Admin-only user lookup helpers for the audience-targeting UI.
 *
 * Intentionally NOT decorated with `@swagger` (stays off the OpenAPI docs,
 * same as the rest of src/admin/). Reachable only through the admin-key +
 * (optional) Cloudflare Access gate in [AdminAuthMiddleware].
 *
 * Read-minimal by design: token reads go through UserFcmTokenService's
 * in-memory cache, so resolving the same uid repeatedly in the console
 * costs ~one Firestore read per uid per cache TTL. Pass `?fresh=1` to force
 * a live read when you genuinely need to bypass the cache.
 */
export class AdminUserController {
    /**
     * GET /api/v1/admin/users/:uid/tokens
     *
     * Returns ONLY the registered-device count for a uid — never the raw
     * token strings (sensitive identifiers; kept out of responses just like
     * SendResult.failures). Tells the caller whether the answer was served
     * from cache so the UI can show a live/cached hint.
     */
    static async getTokenStats(req: Request, res: Response) {
        const uid = (req.params.uid || '').trim();
        if (!uid) {
            return res.status(400).json({ error: 'Bad Request', message: 'uid is required' });
        }

        // `?fresh=1` (or true) bypasses the cache for a guaranteed live read.
        const fresh = req.query.fresh === '1' || req.query.fresh === 'true';

        try {
            const { count, cached } = await UserFcmTokenService.countForUid(uid, { bypassCache: fresh });
            return res.json({
                uid,
                tokenCount: count,
                /** Whether this uid can receive a `uid`-audience push at all. */
                deliverable: count > 0,
                cached,
                source: cached ? 'cache' : 'firestore',
            });
        } catch (e: any) {
            console.warn('ADMIN_USER: token lookup failed', e?.message);
            return res.status(500).json({
                error: 'Internal Server Error',
                message: e?.message ?? 'Failed to look up user tokens',
            });
        }
    }
}
