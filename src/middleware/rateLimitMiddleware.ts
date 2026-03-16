import rateLimit from 'express-rate-limit';

/**
 * RateLimitMiddleware
 * Centralized place for all traffic control policies.
 * Keeps the code modular and easy to adjust per-endpoint.
 */
export class RateLimitMiddleware {
    /**
     * Standard limiter: Protects common data endpoints (Modes, Lines, Stations).
     * Prevents high-volume scraping while allowing normal app usage.
     */
    static standard = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100, // Limit each IP to 100 requests per window
        message: {
            error: "Too Many Requests",
            message: "You've reached the limit for public data. Please contact support for higher limits."
        },
        standardHeaders: true,
        legacyHeaders: false,
    });

    /**
     * Strict limiter: Protects sensitive user sync endpoints.
     * Prevents brute-forcing and saves Firestore write costs.
     */
    static strict = rateLimit({
        windowMs: 15 * 60 * 1000, 
        max: 20, 
        message: {
            error: "Rate Limit Exceeded",
            message: "To protect user data, syncing is limited. Please try again later."
        },
        standardHeaders: true,
        legacyHeaders: false,
    });

    /**
     * Internal limiter: Relaxed limit for our own services (Syncer/Developer Keys).
     * Used in conjunction with X-Stationly-Key.
     */
    static developer = rateLimit({
        windowMs: 1 * 60 * 1000, // 1 minute
        max: 60, // 60 requests per minute
        message: {
            error: "API Quota Exceeded",
            message: "Your developer key has hit its per-minute limit."
        },
        standardHeaders: true,
        legacyHeaders: false,
    });
}
