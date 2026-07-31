import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { StationStreamHub } from '../services/stationStreamHub';

/**
 * Machine-to-machine ingest from the StationlySyncer (same host).
 *
 * This is a WRITE path for board data: whatever it accepts is fanned out
 * verbatim to every connected client. If it were publicly reachable, anyone
 * could inject fake departures into every open app. Three layers guard it:
 *
 *  1. Nginx never proxies `/internal` — the 443 block only forwards `/api/v1/`,
 *     `/docs`, `/openapi.json` and `/icons/`, with NO catch-all `location /`.
 *     So this path is already unreachable from the internet.
 *  2. Loopback-only. Checked via `req.socket.remoteAddress`, NOT `req.ip` —
 *     `app.set('trust proxy', 1)` makes `req.ip` honour a client-supplied
 *     X-Forwarded-For, which is spoofable and would defeat the check.
 *  3. Shared secret, compared in constant time (mirrors AdminAuthMiddleware).
 *
 * Mounted BEFORE `/api/v1` so it bypasses `validateApiKey` and the per-client
 * rate limiters — those exist to police public clients and would throttle our
 * own Syncer. Deliberately carries NO `@swagger` annotation, so it stays out of
 * the published spec.
 */

const router = Router();

function constantTimeEquals(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf-8');
    const bBuf = Buffer.from(b, 'utf-8');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
}

function isLoopback(req: Request): boolean {
    // Raw socket address — immune to X-Forwarded-For spoofing.
    const addr = req.socket.remoteAddress || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function guard(req: Request, res: Response, next: NextFunction) {
    if (!isLoopback(req)) {
        console.warn(`INTERNAL: ❌ Non-loopback request from ${req.socket.remoteAddress}`);
        return res.status(403).json({ error: 'Forbidden' });
    }

    const expected = process.env.LIVESTREAM_INGEST_SECRET;
    // Fail CLOSED when unconfigured — same posture as AdminAuthMiddleware. An
    // unset secret on a fresh deploy must not silently open an injection path.
    if (!expected) {
        console.error('INTERNAL: ❌ LIVESTREAM_INGEST_SECRET is not configured; refusing ingest.');
        return res.status(503).json({ error: 'Service Unavailable', message: 'Ingest not configured.' });
    }

    const provided = req.header('X-Internal-Secret') || '';
    if (!constantTimeEquals(provided, expected)) {
        console.warn('INTERNAL: ❌ Invalid ingest secret.');
        return res.status(403).json({ error: 'Forbidden' });
    }

    next();
}

/**
 * POST /internal/station-updates
 *
 * Body is the Syncer's own changed-stations map, unchanged:
 *   { "Station_940GZZDLTWG": { id, name, lut, lines }, ... }
 *
 * Keys may carry the `Station_` FCM-topic prefix; the hub normalises them.
 * Responds as soon as fan-out is queued — the Syncer must never wait on us.
 */
router.post('/station-updates', guard, (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Expected an object of stationId -> payload' });
    }

    let stations = 0;
    let delivered = 0;
    let skipped = 0;

    for (const [key, payload] of Object.entries(body)) {
        if (!payload || typeof payload !== 'object') continue;

        // broadcast() writes through PredictionCache, which owns ordering and
        // returns -1 when a NEWER payload is already held (a retried or delayed
        // POST). Storing here is what lets a Syncer push spare a later REST
        // caller a TfL fetch — the whole point of the shared cache.
        const sent = StationStreamHub.broadcast(key, payload, 'syncer');
        if (sent < 0) { skipped++; continue; }

        stations++;
        delivered += sent;
    }

    return res.json({ stations, delivered, skipped });
});

/**
 * Liveness + fan-out visibility for ops. Loopback+secret gated like the rest.
 * `StationStreamHub.stats()` already embeds the cache stats under `cache`.
 */
router.get('/stream-stats', guard, (_req: Request, res: Response) => {
    return res.json(StationStreamHub.stats());
});

export default router;
