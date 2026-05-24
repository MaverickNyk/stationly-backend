import { Request, Response, NextFunction } from 'express';

/**
 * Guard for internal-only admin routes (notification push, segment
 * targeting, future ops tooling).
 *
 * Why a SEPARATE key from `X-Stationly-Key`?
 *   - Client API keys live in many production apps + are rotated on a
 *     calendar; they're not designed to gate destructive / privileged
 *     operations.
 *   - An admin key is single-issuer, kept off the OpenAPI docs, and
 *     can be revoked without touching client traffic.
 *   - Layered defence: even if a client key leaks, the leaked key
 *     can't fan-out push notifications to users.
 *
 * Configuration: set `STATIONLY_ADMIN_KEY` in the backend `.env`.
 * Keep it long (32+ chars), random, and rotated periodically. The
 * value is compared via `timingSafeEqual` to avoid byte-by-byte
 * timing attacks (cheap to do, expensive not to).
 *
 * Routes guarded with this middleware should NOT carry a `@swagger`
 * annotation — keeping them out of the public OpenAPI schema reduces
 * the chance an automated scanner stumbles into them.
 */
import * as crypto from 'crypto';

export class AdminAuthMiddleware {
    /**
     * Validate `X-Stationly-Admin-Key` against `STATIONLY_ADMIN_KEY`
     * env var. Returns 401 if missing, 403 if wrong, and uses a
     * constant-time compare so the failure mode doesn't leak length
     * or partial-match information.
     *
     * Also returns 503 if the admin key isn't configured server-side
     * — this is the safe failure mode: a fresh deploy without an
     * admin key set should NOT silently accept all requests; it
     * should refuse them entirely.
     */
    static validate(req: Request, res: Response, next: NextFunction) {
        const provided = req.header('X-Stationly-Admin-Key');
        const expected = process.env.STATIONLY_ADMIN_KEY;

        if (!expected || expected.length < 16) {
            // Misconfiguration. Don't 200/403 either way — be loud.
            console.error('ADMIN_AUTH: STATIONLY_ADMIN_KEY is not configured (or too short). Refusing all admin requests.');
            return res.status(503).json({
                error: 'Service Unavailable',
                message: 'Admin endpoints are disabled on this environment.',
            });
        }

        if (!provided) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: "Missing 'X-Stationly-Admin-Key' header.",
            });
        }

        if (!constantTimeEquals(provided, expected)) {
            console.warn(`ADMIN_AUTH: ❌ Invalid admin key attempt from ${req.ip}`);
            return res.status(403).json({
                error: 'Forbidden',
                message: "Invalid 'X-Stationly-Admin-Key'.",
            });
        }

        return next();
    }
}

/**
 * Constant-time string equality. Falls back to a false comparison on
 * length mismatch (still constant-time per-byte over the shorter input)
 * so callers can't probe the expected length via response timing.
 */
function constantTimeEquals(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf-8');
    const bBuf = Buffer.from(b, 'utf-8');
    if (aBuf.length !== bBuf.length) {
        // Run the compare anyway with a sized buffer so timing stays flat.
        crypto.timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
        return false;
    }
    return crypto.timingSafeEqual(aBuf, bBuf);
}
