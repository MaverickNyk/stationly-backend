/**
 * ⚠️ TEMPORARY — the ONLY file in this backend that knows `web-temp/` exists.
 *
 * The café-trial web app is hosted inside this process for the duration of the
 * trial. Read `web-temp/CAFE_KIOSK_DISPLAY.md` before changing anything here; the short
 * version is that this file, plus two lines in `server.ts`, is the entire
 * coupling, and deleting both is the entire extraction.
 *
 * ## Why in-process, rather than a separate service
 *
 * Three things fall out of being inside the backend that no separate frontend
 * host could have had for free:
 *
 *  1. **The API key never reaches a browser.** `/api/v1/*` is gated by
 *     `validateApiKey`, and a key shipped to a public café screen is a key
 *     published. Here the BFF calls `StationController.fetchPredictions()` as a
 *     function — there is no request to sign, so there is nothing to leak.
 *  2. **The kiosk is free.** That call reads `PredictionCache`, which the Syncer
 *     already fills every ~30s for every subscribed station. A café display
 *     watching a subscribed station costs a memory read and NO TfL call. Going
 *     through HTTP would have cost the same TfL budget twice — the exact
 *     duplication `services/predictionCache/README.md` was written to end.
 *  3. Same origin, so no CORS and no preflight.
 *
 * ## How the board stays live
 *
 * A WebSocket, not polling — `attachTemporaryKioskStream` below, which joins the
 * café screen to the same `StationStreamHub` the phones use. The BFF endpoint
 * that remains here is no longer on that path: nothing in `web-temp/` calls it,
 * and it is kept only as a curl-able probe of what the kiosk would see. Delete
 * it with the rest of the file on extraction.
 */

import express, { Express, Request, Response } from 'express';
import { Server as HttpServer } from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { StationController } from './controllers/stationController';
import { LineController } from './controllers/lineController';
import { DataCacheService } from './services/dataCacheService';
import { StationStreamHub } from './services/stationStreamHub';
import { LineStatusStreamHub } from './services/lineStatusStreamHub';
import { toEpochMs, toIso } from './utils/timestamps';

/** Mount path. Matches `base` in web-temp/vite.config.ts and `basename` in
 *  web-temp/src/main.tsx — all three are the same string. */
const MOUNT = '/kiosk';

/** Built assets. `web-temp/src` is excluded by the deploy script's
 *  `--exclude src` (it matches at any depth), so only `dist` ever ships — build
 *  locally before deploying. */
const DIST = path.join(process.cwd(), 'web-temp', 'dist');

/** A NaptanId, validated before it becomes an upstream lookup. Mirrors
 *  `isValidNaptan` in the web app, which guards the display side. */
const NAPTAN = /^[0-9]{3}[A-Za-z0-9]{3,20}$/;

export function mountTemporaryWebApp(app: Express): void {
    // ── the BFF ──────────────────────────────────────────────────────────
    //
    // One endpoint. It joins the two upstream reads the board needs so the TV
    // makes a single request per poll, and stamps the server clock so a display
    // with a wrong system time still counts down correctly.
    app.get(`${MOUNT}-api/snapshot/:naptanId`, async (req: Request, res: Response) => {
        const { naptanId } = req.params;

        if (!NAPTAN.test(naptanId)) {
            res.status(400).json({ error: 'Bad station id' });
            return;
        }

        try {
            const station = await StationController.fetchPredictions(naptanId);

            // Only the lines this station actually serves — a café board must
            // not rotate a Piccadilly closure at a Mildmay stop.
            const lineIds = Object.keys(station.lines ?? {});
            const statuses = await statusesForLines(lineIds);

            // The mode per line, so the display can show the right roundel —
            // Overground at Hackney Wick, not a generic dot. Sent alongside
            // rather than derived on the client: mode lives in the line record
            // here and the kiosk has no line metadata of its own.
            const lineModes: Record<string, string> = {};
            for (const id of lineIds) {
                const mode = DataCacheService.getLineById(id)?.modeName;
                if (mode) lineModes[id] = mode;
            }

            // No cache header: the board is live, and an intermediary caching
            // this for even 30s would show the café a board the rider's phone
            // disagrees with.
            res.set('Cache-Control', 'no-store');
            res.json({ station, statuses, lineModes, serverNowMs: Date.now() });
        } catch (error: any) {
            // Mirror the public endpoint's contract rather than inventing one.
            // An empty board is a CLAIM ("no trains here") and must never be
            // how an upstream failure looks — see stationController.
            const name = error?.constructor?.name;
            if (name === 'UnknownStationError') {
                res.status(404).json({ error: 'Station not found', naptanId });
                return;
            }
            if (name === 'TflUnavailableError') {
                res.status(503).json({ error: 'Upstream unavailable', naptanId });
                return;
            }
            console.error(`[TEMP WEB] snapshot failed for ${naptanId}:`, error);
            res.status(500).json({ error: 'Failed to fetch predictions' });
        }
    });

    // ── static assets ────────────────────────────────────────────────────
    // Vite content-hashes filenames, so assets are safe to cache hard; index.html
    // must never be, or a redeploy leaves the café on the old bundle forever.
    app.use(
        MOUNT,
        express.static(DIST, {
            index: false,
            setHeaders: (res, filePath) => {
                if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
                else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            },
        }),
    );

    // ── SPA fallback ─────────────────────────────────────────────────────
    // The station is a path segment (`/kiosk/910GHACKNYW`), so every one of
    // those has to return index.html and let the client router read it.
    app.get(`${MOUNT}/*`, (_req: Request, res: Response) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(DIST, 'index.html'), err => {
            if (err) {
                // Almost always "you forgot to build". Say that, rather than
                // serving a blank 500 to a screen on a café wall.
                res.status(503).send('Kiosk build missing — run `npm run build` in web-temp/.');
            }
        });
    });
    app.get(MOUNT, (_req: Request, res: Response) => res.redirect(`${MOUNT}/`));

    console.log(`[TEMP WEB] café kiosk mounted at ${MOUNT} (temporary — see web-temp/CAFE_KIOSK_DISPLAY.md)`);
}

/**
 * Line statuses for exactly the lines a station serves.
 *
 * Deliberately follows `LineController.getLineStatuses` step for step rather
 * than reading the cache directly, because two of its steps are load-bearing
 * and both were learned from bugs:
 *
 *  - The mode comes from the LINE, not from a guess. Statuses are cached per
 *    mode, so looking up an overground line in the default 'tube' set silently
 *    returns nothing.
 *  - `ensureLineStatuses` must run. The cache fills from the Syncer's pushes,
 *    which carry only CHANGED lines, so after a backend restart a mode is
 *    routinely non-empty yet missing most of it — and a café board would sit
 *    there with no status strip until some unrelated line happened to change.
 *
 * `lastUpdatedTime` is an integer internally and an ISO string on the wire;
 * converting here keeps this endpoint's shape identical to the public one.
 */
async function statusesForLines(lineIds: string[]): Promise<any[]> {
    if (lineIds.length === 0) return [];

    // Group the wanted lines by their own mode, so one query per mode.
    const byMode = new Map<string, string[]>();
    for (const id of lineIds) {
        const mode = DataCacheService.getLineById(id)?.modeName || 'tube';
        const group = byMode.get(mode);
        if (group) group.push(id);
        else byMode.set(mode, [id]);
    }

    // Fetch line statuses for each mode in parallel to minimize latency
    await Promise.all(
        Array.from(byMode.entries()).map(async ([mode, ids]) => {
            try {
                await LineController.ensureLineStatuses(mode, ids);
            } catch (e) {
                console.error(`[TEMP WEB] status refresh failed for mode ${mode}:`, e);
            }
        })
    );

    const out: any[] = [];
    for (const [mode, ids] of byMode) {
        for (const s of DataCacheService.getLineStatuses(mode)) {
            if (ids.includes(s.id)) out.push({ ...s, lastUpdatedTime: toIso(toEpochMs(s.lastUpdatedTime)) });
        }
    }
    return out;
}


/**
 * The café display's live stream.
 *
 * ## Why this exists instead of using /api/v1/stream
 * That endpoint closes any socket that has not presented a Firebase ID token
 * within ten seconds, and a screen on a wall has no user to sign in. The wrong
 * fixes were to mint a service account for a TV, or to poke a hole in the real
 * stream's auth. Both put a credential on a public display.
 *
 * ## What this does instead
 * The socket is registered into the SAME `StationStreamHub` the phones use,
 * under a synthetic uid, from inside the backend process. No token is needed
 * because no trust boundary is crossed: the hub's `register`/`subscribe` are
 * in-process calls, and this file is already inside. The phone stream is
 * untouched — it keeps its auth, its timeout, and its close codes.
 *
 * What the kiosk gets is exactly what a phone gets: the Syncer pushes a changed
 * station to `/internal/station-updates`, the hub fans it out, and this socket
 * is in the room. Sub-second, one connection, no polling.
 *
 * ## Read-only by construction
 * The socket accepts NO frames. A café screen has nothing to say, and a display
 * anyone can point a browser at should not be able to ask this process for
 * anything. Its station comes from the URL and is fixed for the life of the
 * connection.
 */
export function attachTemporaryKioskStream(server: HttpServer, path = '/kiosk-stream'): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

    // ── Upgrade routing: INTERCEPT, do not append ────────────────────────
    //
    // `attachStationStream` installs its own 'upgrade' listener that destroys
    // any socket whose path is not `/api/v1/stream` — deliberately, so a stray
    // upgrade cannot be silently accepted. Node calls every listener on the
    // event, so simply adding a second one does not work: the phone stream's
    // handler would run alongside ours and destroy the café's socket underneath
    // it. (Order does not save us either — it destroys the socket whether it
    // runs first or second.)
    //
    // So this takes the listeners off, puts itself in front, and delegates
    // everything that is not ours to the originals, unchanged. The phone stream
    // keeps its exact behaviour including the destroy, for every path but this
    // one. Contained here on purpose: `stationStreamServer.ts` is code the apps
    // depend on and this is a temporary tenant — the tenant does the adapting.
    //
    // Runs after attachStationStream(server), which is what makes `previous`
    // non-empty. See the call site in server.ts.
    const previous = server.listeners('upgrade') as Array<
        (req: any, socket: any, head: any) => void
    >;
    server.removeAllListeners('upgrade');

    server.on('upgrade', (req, socket, head) => {
        let url: URL;
        try {
            url = new URL(req.url || '', 'http://localhost');
        } catch {
            for (const listener of previous) listener(req, socket, head);
            return;
        }

        if (url.pathname !== path) {
            for (const listener of previous) listener(req, socket, head);
            return;
        }

        const naptanId = (url.searchParams.get('station') || '').trim();
        if (!NAPTAN.test(naptanId)) {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket as any, head, ws => open(ws, naptanId));
    });

    async function open(ws: WebSocket, rawNaptanId: string): Promise<void> {
        const naptanId = rawNaptanId.toUpperCase();
        // The hub's own sweeper pings every registered socket and closes the
        // ones that stop answering, so a café TV that sleeps or drops off the
        // wifi is cleaned up by the machinery that already exists.
        ws.on('pong', () => StationStreamHub.markPong(ws));

        const cleanup = () => {
            StationStreamHub.unregister(ws);
            LineStatusStreamHub.forget(ws);
        };
        ws.on('close', cleanup);
        ws.on('error', cleanup);
        // Read-only: anything the client sends is dropped on the floor.
        ws.on('message', () => { /* intentionally ignored */ });

        StationStreamHub.register(ws, `kiosk:${naptanId}`);
        StationStreamHub.subscribe(ws, [naptanId]);

        // Paint immediately from cache if we have it. `snapshotFrame` returns
        // undefined when the cache is cold, which is the only presence test
        // needed — a cold station is warmed below, and its result reaches this
        // socket through the normal broadcast.
        const frame = StationStreamHub.snapshotFrame(naptanId);
        if (frame && ws.readyState === WebSocket.OPEN) {
            try { ws.send(frame); } catch { /* closed mid-write; 'close' cleans up */ }
        }

        try {
            // Which lines this station serves — needed for the status
            // subscription and the roundel.
            let station: any = null;
            if (frame) {
                try { station = JSON.parse(frame).payload; } catch { /* fall through */ }
            }
            if (!station) {
                // Cold: this both warms the shared PredictionCache and
                // broadcasts the result to this socket.
                station = await StationController.fetchPredictions(naptanId);
            }

            // If snapshot wasn't sent earlier, send the station payload now
            if (!frame && station && ws.readyState === WebSocket.OPEN) {
                send(ws, { type: 'snapshot', station: naptanId, payload: station });
            }

            const stationLineIds = Object.keys(station?.lines ?? {})
                .filter((id: string) => DataCacheService.getLineById(id));

            // All major London network lines for the live network status ribbon
            const NETWORK_LINE_IDS = [
                'bakerloo', 'central', 'circle', 'district', 'hammersmith-city',
                'jubilee', 'metropolitan', 'northern', 'piccadilly', 'victoria', 'waterloo-city',
                'lioness', 'mildmay', 'windrush', 'weaver', 'suffragette', 'liberty',
                'elizabeth', 'dlr'
            ];

            const allTrackedLineIds = Array.from(new Set([...stationLineIds, ...NETWORK_LINE_IDS]))
                .filter((id: string) => DataCacheService.getLineById(id));

            if (ws.readyState !== WebSocket.OPEN) return;

            if (allTrackedLineIds.length) LineStatusStreamHub.subscribe(ws, allTrackedLineIds);

            const lineModes: Record<string, string> = {};
            for (const id of allTrackedLineIds) {
                const mode = DataCacheService.getLineById(id)?.modeName;
                if (mode) lineModes[id] = mode;
            }

            // A status refresh talks to TfL and can be slow or fail. It must not
            // take the roundel and the mode down with it, so it is awaited
            // separately and degrades to an empty list.
            let statuses: any[] = [];
            if (allTrackedLineIds.length) {
                try {
                    statuses = await statusesForLines(allTrackedLineIds);
                } catch (e) {
                    console.error(`[TEMP WEB] kiosk ${naptanId}: network status fetch failed:`, e);
                }
            }

            // One frame carrying what the hub protocol has no shape for: the
            // joined statuses and the per-line mode. After this the client lives
            // on hub frames alone.
            send(ws, { type: 'kiosk_meta', statuses, lineModes, serverNowMs: Date.now() });
        } catch (e) {
            console.error(`[TEMP WEB] kiosk stream warm-up failed for ${naptanId}:`, e);
            // Not fatal. The socket stays in the room, and the next Syncer push
            // for this station paints the board.
        }
    }

    function send(ws: WebSocket, payload: unknown): void {
        if (ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify(payload)); } catch { /* closed */ }
    }

    console.log(`[TEMP WEB] café kiosk stream listening on ${path} (temporary)`);
}
