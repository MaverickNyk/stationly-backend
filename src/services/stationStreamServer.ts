import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { auth } from '../config/firebase';
import { StationStreamHub } from './stationStreamHub';
import { StreamPrefetch } from './streamPrefetch';

/**
 * WebSocket endpoint that streams live departure updates to foreground clients.
 *
 * Why a socket rather than push: silent APNs pushes proved undeliverable on
 * iOS (proven on-device 2026-07-30 — alerts arrive, `content-available` does
 * not), and polling every 30s is wasteful for both device and backend. A socket
 * gives sub-second updates while a board is on screen, and one implementation
 * in KMP `commonMain` serves Android, iOS and the WASM web app.
 *
 * It is explicitly a FOREGROUND layer. Sockets die when an app is backgrounded,
 * so nothing here replaces Android's FCM path or the iOS widget's own refresh.
 *
 * Protocol (all frames JSON):
 *   → {"action":"auth","token":"<firebase id token>"}
 *   ← {"type":"ready"}
 *   → {"action":"subscribe","stations":["940GZZDLTWG"]}
 *   ← {"type":"snapshot","station":"940GZZDLTWG","payload":{…}}   (immediate, if cached)
 *   ← {"type":"update","station":"940GZZDLTWG","payload":{…}}     (on change)
 *   → {"action":"unsubscribe","stations":[…]}
 *
 * A `snapshot` is only sent when the cache already holds the station. A cold
 * one is fetched from TfL on demand and arrives as an `update` instead (it
 * reaches the client through the normal broadcast), so clients must paint on
 * both and never block waiting for a `snapshot`. Cold subscribes that will not
 * produce data are reported as `unknown_station`, `prefetch_throttled` or
 * `prefetch_failed` — none of which close the socket. See StreamPrefetch.
 */

/** Auth must arrive within this window or the socket is closed. */
const AUTH_TIMEOUT_MS = 10_000;
/** Ping cadence. Must stay well under Nginx's proxy_read_timeout. */
const PING_INTERVAL_MS = 30_000;
/** Frames larger than this are rejected outright — clients only send commands. */
const MAX_FRAME_BYTES = 4096;

const CLOSE_AUTH_TIMEOUT = 4001;
const CLOSE_AUTH_FAILED = 4003;

export function attachStationStream(server: HttpServer, path = '/api/v1/stream'): WebSocketServer {
    StationStreamHub.assertSingleInstance();

    // `noServer` + a manual upgrade handler, so an upgrade on any OTHER path is
    // destroyed rather than silently accepted.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

    server.on('upgrade', (req, socket, head) => {
        let pathname: string;
        try {
            pathname = new URL(req.url || '', 'http://localhost').pathname;
        } catch {
            socket.destroy();
            return;
        }
        if (pathname !== path) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket as any, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws: WebSocket) => {
        let authed = false;
        /** Set synchronously, so batched auth frames can't race — see below. */
        let authInFlight = false;

        // Unauthenticated sockets are cheap to open and expensive to leave
        // open; close any that never present a token.
        const authTimer = setTimeout(() => {
            if (!authed) {
                try { ws.close(CLOSE_AUTH_TIMEOUT, 'auth timeout'); } catch { /* already gone */ }
            }
        }, AUTH_TIMEOUT_MS);

        ws.on('pong', () => StationStreamHub.markPong(ws));

        ws.on('message', async (raw) => {
            let msg: any;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return send(ws, { type: 'error', message: 'Malformed JSON' });
            }
            if (!msg || typeof msg !== 'object') return;

            if (msg.action === 'auth') {
                // Both flags are read and set SYNCHRONOUSLY, before the await.
                // `authed` alone is not enough: it is only assigned once
                // verifyIdToken resolves, so several auth frames arriving in one
                // batch would ALL pass the check and each call register() —
                // which installs a fresh ClientState. A subscribe interleaved
                // between two of those registrations leaves the socket in
                // `rooms` but absent from its own station set, so unregister()
                // can never clean those rooms and they leak dead sockets.
                if (authed || authInFlight) return;
                authInFlight = true;
                try {
                    // Same verification as AuthMiddleware.validateUserToken —
                    // one call, no Express dependency. The decoded uid is
                    // authoritative; a uid in the frame is never trusted.
                    const decoded = await auth.verifyIdToken(String(msg.token || ''));
                    authed = true;
                    clearTimeout(authTimer);
                    StationStreamHub.register(ws, decoded.uid);
                    send(ws, { type: 'ready' });
                } catch {
                    try { ws.close(CLOSE_AUTH_FAILED, 'invalid token'); } catch { /* ignore */ }
                } finally {
                    authInFlight = false;
                }
                return;
            }

            // Everything past this point requires auth.
            if (!authed) return;

            if (msg.action === 'subscribe') {
                const ids = toStationList(msg.stations);
                const { subscribed, rejected } = StationStreamHub.subscribe(ws, ids);
                // Flush what we already hold so the board paints immediately
                // rather than waiting up to a Syncer cycle for the next change.
                // snapshotFrame returns undefined when the cache holds nothing
                // for a station, which is the only presence test we need.
                const cold: string[] = [];
                for (const naptanId of subscribed) {
                    const frame = StationStreamHub.snapshotFrame(naptanId);
                    if (!frame) { cold.push(naptanId); continue; }
                    if (ws.readyState !== WebSocket.OPEN) break;
                    try { ws.send(frame); } catch { break; /* closed mid-write; cleanup runs on 'close' */ }
                }
                // Nothing cached — fetch from TfL so the first subscriber to a
                // station the Syncer doesn't poll isn't left with a blank
                // board. Skipped when the socket died mid-flush above: the
                // fetch's only purpose is delivering to this socket. See
                // prefetchColdStations for why success sends nothing here.
                if (cold.length && ws.readyState === WebSocket.OPEN) {
                    prefetchColdStations(ws, cold);
                }
                // Tell the client what it did NOT get. Silently dropping these
                // would leave it believing it's subscribed, watching a board
                // that never updates, with nothing to diagnose.
                if (rejected.length) {
                    send(ws, {
                        type: 'error',
                        code: 'subscription_limit',
                        message: `Subscription limit reached; ${rejected.length} station(s) not subscribed.`,
                        stations: rejected,
                    });
                }
                return;
            }

            if (msg.action === 'unsubscribe') {
                StationStreamHub.unsubscribe(ws, toStationList(msg.stations));
                return;
            }

            if (msg.action === 'ping') {
                send(ws, { type: 'pong' });
            }
        });

        const cleanup = () => { clearTimeout(authTimer); StationStreamHub.unregister(ws); };
        ws.on('close', cleanup);
        // Without this an errored socket stays in the routing table forever.
        ws.on('error', cleanup);
    });

    const pinger = setInterval(() => StationStreamHub.sweep(), PING_INTERVAL_MS);
    // Don't hold the event loop open on shutdown.
    pinger.unref?.();
    wss.on('close', () => clearInterval(pinger));

    console.log(`WS: 🔌 Station stream listening on ${path}`);
    return wss;
}

/**
 * Fetch stations the cache had nothing for, so a first subscriber gets data.
 *
 * Nothing is sent on success — deliberately. fetchPredictions ends in
 * fetchPredictionsFromTfl, whose broadcast() writes an `update` frame to every
 * socket in the station's room, and subscribe() put this socket in those rooms
 * before we were called. Sending here too would deliver the payload twice.
 *
 * Every refusal IS reported, though (same reasoning as subscription_limit: a
 * client watching a board that never paints, with nothing to explain it, is
 * the worst outcome), with codes split by what the client should do —
 * `unknown_station` is permanent and drops the subscription, the two
 * `prefetch_*` codes are transient and keep it.
 */
function prefetchColdStations(ws: WebSocket, cold: string[]): void {
    const { unknown, throttled } = StreamPrefetch.request(ws, cold, (naptanId, permanent) => {
        // Fires per station only when its fetch failed. `permanent` is a TfL
        // 404 on an id our local table still lists (retired or renamed
        // upstream) — treat it exactly like a locally-rejected id.
        if (permanent) return dropUnknownStations(ws, [naptanId]);
        send(ws, {
            type: 'error',
            code: 'prefetch_failed',
            message: 'Could not load initial data; updates will still arrive.',
            stations: [naptanId],
        });
    });

    if (unknown.length) dropUnknownStations(ws, unknown);
    if (throttled.length) {
        send(ws, {
            type: 'error',
            code: 'prefetch_throttled',
            message: 'Too many initial loads; updates will still arrive.',
            stations: throttled,
        });
    }
}

/**
 * Cancel subscriptions to dead ids and say so. subscribe() necessarily ran
 * before anything could know an id was junk, so without this the socket keeps
 * an active subscription to a station that can never deliver — holding one of
 * its 25 slots for the connection's lifetime and stranding a room in the
 * routing table. A client looping junk ids would exhaust its own slots.
 */
function dropUnknownStations(ws: WebSocket, naptanIds: string[]): void {
    StationStreamHub.unsubscribe(ws, naptanIds);
    send(ws, {
        type: 'error',
        code: 'unknown_station',
        message: `Station(s) not recognised: ${naptanIds.join(', ')}`,
        stations: naptanIds,
    });
}

function send(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(obj)); } catch { /* closed mid-write */ }
    }
}

function toStationList(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
