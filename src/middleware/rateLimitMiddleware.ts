import rateLimit from 'express-rate-limit';
import { Request } from 'express';

// Key by the authenticated Firebase UID when available, else by IP.
//
// We deliberately DO NOT key by X-Stationly-Key: every install of the app ships
// the SAME client key, so keying by it makes ONE global bucket shared by all
// users — a single device can then rate-limit everyone (and normal traffic trips
// the strict /user limiter). Per-UID isolates each account; unauthenticated
// public endpoints (no token) fall back to per-IP, which is per-device-ish rather
// than global. Strip the IPv6 ::ffff: prefix to normalise the IP key.
const keyByUidOrIp = (req: Request): string => {
    const uid = (req as any).user?.uid as string | undefined;
    if (uid) return `uid:${uid}`;
    const ip = req.ip?.replace(/^::ffff:/, '') ?? 'unknown';
    return `ip:${ip}`;
};

// Suppress express-rate-limit's IPv6 validation warnings — we normalise the key ourselves.
const validate = { ip: false, keyGeneratorIpFallback: false };

/**
 * RateLimitMiddleware
 * Centralized place for all traffic control policies.
 * Each route group gets its own instance so counters don't bleed across endpoints.
 */
export class RateLimitMiddleware {
    // 300 req / 15 min per client key — enough for normal app usage across all flows
    static modes = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyGenerator: keyByUidOrIp,
        validate,
        message: { error: "Too Many Requests", message: "You've reached the limit for public data. Please contact support for higher limits." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    static lines = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyGenerator: keyByUidOrIp,
        validate,
        message: { error: "Too Many Requests", message: "You've reached the limit for public data. Please contact support for higher limits." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    static stations = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyGenerator: keyByUidOrIp,
        validate,
        message: { error: "Too Many Requests", message: "You've reached the limit for public data. Please contact support for higher limits." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    static sdui = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyGenerator: keyByUidOrIp,
        validate,
        message: { error: "Too Many Requests", message: "You've reached the limit for public data. Please contact support for higher limits." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    /**
     * Strict limiter: Protects sensitive user sync endpoints.
     */
    static strict = rateLimit({
        windowMs: 15 * 60 * 1000,
        // Per-UID now (not the shared key), so this can be generous without one
        // user starving others: covers login sync + reconcile + station edits +
        // FCM (un)register + a few foregrounds comfortably.
        max: 60,
        keyGenerator: keyByUidOrIp,
        validate,
        message: { error: "Rate Limit Exceeded", message: "To protect user data, syncing is limited. Please try again later." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    /**
     * Developer limiter: For internal/subscribed-ids endpoint.
     */
    static developer = rateLimit({
        windowMs: 1 * 60 * 1000,
        max: 60,
        keyGenerator: keyByUidOrIp,
        validate,
        message: { error: "API Quota Exceeded", message: "Your developer key has hit its per-minute limit." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    /**
     * Verify-send limiter — 5 requests per 15 min per Firebase UID.
     * Caller must already be authenticated (validateUserToken populates req.user.uid).
     * Stops a determined user from spamming the verify endpoint past the client-side
     * 60s cooldown (e.g. by force-stopping and reopening the app).
     */
    static verifyEmail = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 5,
        keyGenerator: (req: Request) =>
            ((req as any).user?.uid as string | undefined) || keyByUidOrIp(req),
        validate,
        message: {
            error: "Rate Limit Exceeded",
            message: "Too many verification emails sent. Please wait a few minutes before trying again.",
        },
        standardHeaders: true,
        legacyHeaders: false,
    });

    /**
     * Forgot-password limiter — 3 requests per 15 min per email address (lowercased).
     * Public endpoint, no auth header. Per-email keying prevents an attacker from
     * spamming a single victim's inbox or burning through Firebase's daily quota.
     * Falls back to API key + IP for malformed requests.
     */
    static forgotPassword = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 3,
        keyGenerator: (req: Request) => {
            const email = (req.body?.email as string | undefined)?.trim().toLowerCase();
            return email || keyByUidOrIp(req);
        },
        validate,
        message: {
            error: "Rate Limit Exceeded",
            message: "Too many reset attempts. Please wait a few minutes before trying again.",
        },
        standardHeaders: true,
        legacyHeaders: false,
    });
}
