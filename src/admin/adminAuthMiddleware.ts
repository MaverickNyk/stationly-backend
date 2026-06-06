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
import { cfAccessEnabled, verifyAccessJwt } from './cfAccess';

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
     *
     * Layer 2 (opt-in): when `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`
     * are set, we ALSO require a valid Cloudflare Access JWT in the
     * `Cf-Access-Jwt-Assertion` header. This means a leaked admin key
     * alone is useless from the public internet — the caller must have
     * passed the Cloudflare Access login wall (human) or hold a valid
     * Service Token (the admin app's server-side proxy). See cfAccess.ts.
     */
    static async validate(req: Request, res: Response, next: NextFunction) {
        const authHeader = req.header('Authorization');
        const expected = process.env.STATIONLY_ADMIN_KEY;

        if (!expected || expected.length < 16) {
            // Misconfiguration. Don't 200/403 either way — be loud.
            console.error('ADMIN_AUTH: STATIONLY_ADMIN_KEY is not configured (or too short). Refusing all admin requests.');
            return res.status(503).json({
                error: 'Service Unavailable',
                message: 'Admin endpoints are disabled on this environment.',
            });
        }

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: "Missing or invalid 'Authorization' header. Use 'Bearer <key>'.",
            });
        }

        // Extract the token after 'Bearer '
        const provided = authHeader.substring(7).trim();

        if (!constantTimeEquals(provided, expected)) {
            console.warn(`ADMIN_AUTH: ❌ Invalid admin key attempt from ${req.ip}`);
            return res.status(403).json({
                error: 'Forbidden',
                message: "Invalid admin authorization token.",
            });
        }

        // Layer 2: Cloudflare Access JWT (only when configured).
        if (cfAccessEnabled()) {
            const assertion = req.header('Cf-Access-Jwt-Assertion');
            if (!assertion) {
                console.warn(`ADMIN_AUTH: ❌ Missing Cf-Access-Jwt-Assertion from ${req.ip}`);
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Cloudflare Access assertion required.',
                });
            }
            try {
                const identity = await verifyAccessJwt(assertion);
                // Surface who/what called for downstream handlers + logs.
                (req as any).accessIdentity = identity;
            } catch (e: any) {
                console.warn(`ADMIN_AUTH: ❌ Invalid CF Access JWT from ${req.ip}: ${e?.message}`);
                return res.status(403).json({
                    error: 'Forbidden',
                    message: 'Invalid Cloudflare Access assertion.',
                });
            }
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
