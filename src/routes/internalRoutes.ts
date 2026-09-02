import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { StationStreamHub } from '../services/stationStreamHub';
import { StreamPrefetch } from '../services/streamPrefetch';
import { LineStatusStreamHub } from '../services/lineStatusStreamHub';
import { DataCacheService } from '../services/dataCacheService';
import { SessionMaintenanceService } from '../services/sessionMaintenanceService';

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
 * POST /internal/line-status-updates
 *
 * Body is the Syncer's changed-statuses map, keyed by lineId:
 *   { "victoria": { id, name, statusSeverityDescription, reason, mode,
 *                   lastUpdatedTime }, ... }
 *
 * This is now the LIVENESS path for line status, not a convenience. Statuses
 * used to reach us through a Firestore onSnapshot listener; that listener was
 * removed because it billed a document read for every change on every instance,
 * forever. Without this endpoint the backend only learns of a change when it
 * asks TfL itself, which is gated to once per mode per 60s — a fallback, not
 * a liveness path.
 *
 * Writes through DataCacheService.setLineStatus, NEVER LineStatusStreamHub
 * directly: that method owns ordering and is the single point every producer
 * shares, so bypassing it would let the cache and the stream disagree.
 */
router.post('/line-status-updates', guard, (req: Request, res: Response) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Expected an object of lineId -> status' });
    }

    let lines = 0;
    let delivered = 0;
    let skipped = 0;

    for (const [key, status] of Object.entries(body)) {
        if (!status || typeof status !== 'object') continue;

        // Returns -1 when nothing was sent: either a newer status is already
        // held (a retried or delayed POST) or the payload is identical to the
        // last one broadcast. Both mean "do not count this as delivered".
        const sent = DataCacheService.setLineStatus(key, status);
        if (sent < 0) { skipped++; continue; }

        lines++;
        delivered += sent;
    }

    return res.json({ lines, delivered, skipped });
});

/**
 * Liveness + fan-out visibility for ops. Loopback+secret gated like the rest.
 * `StationStreamHub.stats()` already embeds the cache stats under `cache`;
 * `prefetch` surfaces the cold-subscribe limiters, where a climbing
 * `droppedUnknown` means a client is asking for junk station ids and a climbing
 * `droppedQueueFull` means TfL is the bottleneck.
 */
router.get('/stream-stats', guard, (_req: Request, res: Response) => {
    return res.json({
        ...StationStreamHub.stats(),
        prefetch: StreamPrefetch.stats(),
        lines: LineStatusStreamHub.stats(),
    });
});

/**
 * POST /internal/maintenance/sweep
 * POST /internal/maintenance/reconcile
 *
 * The two nightly session-maintenance jobs, driven by the host's crontab.
 *
 * ## Why they are HTTP routes and not an in-process timer
 * There is no scheduler in this backend — no `node-cron`, no scheduler config,
 * and the only `setInterval`s belong to the stream server and the prediction
 * cache. The obvious reflex is to add one, and it would be wrong here:
 * `staging_deploy.sh` starts this service with `pm2 start -i max`, so staging
 * runs in CLUSTER MODE today. An in-process nightly timer would fire once per
 * worker, and a nightly registry recompute racing itself across N workers is
 * precisely the contention the transactions exist to serialise. A crontab line
 * fires exactly once regardless of how many workers are listening.
 *
 * ## Why they sit behind this guard and reuse its secret
 * Same trust boundary as the ingest routes above: loopback-only on the raw
 * socket address, constant-time secret, and nginx has no catch-all `location /`
 * so `/internal` is unreachable from the internet. Anyone able to present
 * `LIVESTREAM_INGEST_SECRET` from loopback already has full run of
 * `/internal/station-updates`, so minting a second secret would buy no
 * isolation while requiring a new GitHub Actions secret to land in both hosts'
 * `.env` before the first crontab line could fire. The name is now slightly
 * inaccurate; that is a documentation nit, not a security cost.
 *
 * ## Why both bodies are wrapped
 * Express 4 does not forward a rejected async handler's promise to error
 * middleware, and this app has none (no 4-arg `app.use` exists anywhere).
 * Unwrapped, a throw during a 3am run becomes an unhandled rejection that can
 * take the whole worker down over a maintenance job.
 *
 * Both jobs are idempotent, so an overlapping crontab, a manual run during an
 * incident, and a retry after `pm2 reload` are all harmless.
 */
router.post('/maintenance/sweep', guard, async (_req: Request, res: Response) => {
    try {
        return res.json(await SessionMaintenanceService.sweep());
    } catch (e: any) {
        console.error('INTERNAL: ❌ maintenance sweep failed', e);
        return res.status(500).json({ error: e?.message ?? 'sweep failed' });
    }
});

router.post('/maintenance/reconcile', guard, async (_req: Request, res: Response) => {
    try {
        return res.json(await SessionMaintenanceService.reconcile());
    } catch (e: any) {
        console.error('INTERNAL: ❌ maintenance reconcile failed', e);
        return res.status(500).json({ error: e?.message ?? 'reconcile failed' });
    }
});

router.post('/maintenance/reindex-watch', guard, async (_req: Request, res: Response) => {
    try {
        return res.json(await SessionMaintenanceService.reindexWatch());
    } catch (e: any) {
        console.error('INTERNAL: ❌ watch reindex failed', e);
        return res.status(500).json({ error: e?.message ?? 'reindex failed' });
    }
});

export default router;
