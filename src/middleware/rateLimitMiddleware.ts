import rateLimit from 'express-rate-limit';
import { Request } from 'express';

// Key by X-Stationly-Key so limits are per client, not per IP.
// Falls back to IP for unauthenticated requests (caught by auth middleware first anyway).
const keyByClient = (req: Request): string =>
    (req.header('X-Stationly-Key') || req.ip || 'unknown');

// Suppress express-rate-limit's IPv6 validation — we key by app client token, not raw IP.
const validate = { ip: false };

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
        keyGenerator: keyByClient,
        validate,
        message: { error: "Too Many Requests", message: "You've reached the limit for public data. Please contact support for higher limits." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    static lines = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyGenerator: keyByClient,
        validate,
        message: { error: "Too Many Requests", message: "You've reached the limit for public data. Please contact support for higher limits." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    static stations = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyGenerator: keyByClient,
        validate,
        message: { error: "Too Many Requests", message: "You've reached the limit for public data. Please contact support for higher limits." },
        standardHeaders: true,
        legacyHeaders: false,
    });

    static sdui = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        keyGenerator: keyByClient,
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
        max: 20,
        keyGenerator: keyByClient,
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
        keyGenerator: keyByClient,
        validate,
        message: { error: "API Quota Exceeded", message: "Your developer key has hit its per-minute limit." },
        standardHeaders: true,
        legacyHeaders: false,
    });
}
