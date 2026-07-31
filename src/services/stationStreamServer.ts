import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { auth } from '../config/firebase';
import { StationStreamHub } from './stationStreamHub';

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
 *   ← {"type":"snapshot","station":"940GZZDLTWG","payload":{…}}   (immediate)
 *   ← {"type":"update","station":"940GZZDLTWG","payload":{…}}     (on change)
 *   → {"action":"unsubscribe","stations":[…]}
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
                for (const naptanId of subscribed) {
                    const frame = StationStreamHub.snapshotFrame(naptanId);
                    if (frame && ws.readyState === WebSocket.OPEN) {
                        try { ws.send(frame); } catch { break; /* closed mid-write; cleanup runs on 'close' */ }
                    }
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
