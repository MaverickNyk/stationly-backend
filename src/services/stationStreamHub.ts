import { WebSocket } from 'ws';
import { PredictionCache } from './predictionCache';

/**
 * In-memory fan-out hub for live station departure updates.
 *
 * The Syncer already decides WHAT changed (ChangeDetectionService) and posts
 * only changed stations to `/internal/station-updates`. This hub's whole job is
 * routing: given a station id, write the payload to the sockets watching it.
 *
 * Follows the codebase's service idiom (see SubscriptionService /
 * DataCacheService): `export class` with `private static` state and static
 * accessors — no instances, no DI.
 *
 * NOTHING here is persisted. The routing table is rebuilt by clients
 * reconnecting, and the snapshot cache by the next Syncer cycle (~30s), so a
 * restart costs at most one cycle of staleness.
 *
 * ⚠️ SINGLE-PROCESS BY CONSTRUCTION. Connections live in this worker's heap, so
 * the Syncer's POST must land on the SAME worker that holds them. Under PM2
 * `-i max` with >1 core that silently breaks: the POST round-robins and reaches
 * only ~1/N of subscribers, which looks like a flaky client rather than a
 * server bug. `assertSingleInstance()` below turns that into a loud warning.
 * Fixing it properly means a single-instance process, the PM2 message bus, or
 * Redis pub/sub — see `broadcast()`'s note.
 */

/** Wire shape of a station payload — mirrors StationPredictionResponse. */
export interface StationPayload {
    id: string;
    name?: string;
    lut?: string | number;
    lines?: Record<string, unknown>;
}

interface ClientState {
    uid: string;
    /** Stations this socket currently wants. */
    stations: Set<string>;
    /** Cleared by every pong; a second miss closes the socket. */
    awaitingPong: boolean;
}

export class StationStreamHub {
    /** naptanId → sockets watching it. The routing table. */
    private static rooms = new Map<string, Set<WebSocket>>();

    /** Reverse index, so a disconnect is O(subscriptions) not O(all rooms). */
    private static clients = new Map<WebSocket, ClientState>();

    /**
     * Payload storage lives in PredictionCache, NOT here — it is shared with
     * the REST endpoint so a Syncer push also spares a REST caller a TfL
     * fetch, and vice versa. This class owns routing only.
     */

    private static readonly MAX_STATIONS_PER_CLIENT = 25;

    // ─── connection lifecycle ────────────────────────────────────────────

    /**
     * Idempotent by contract. Re-registering an already-known socket would
     * install a fresh, EMPTY station set while `rooms` still holds the socket,
     * stranding it in rooms that `unregister` can no longer find. The stream
     * server also guards against double-auth, but this is the invariant that
     * actually protects the routing table, so it is enforced here too.
     */
    static register(socket: WebSocket, uid: string): void {
        if (this.clients.has(socket)) return;
        this.clients.set(socket, { uid, stations: new Set(), awaitingPong: false });
    }

    /**
     * Drop a socket from every room it joined. Skipping this leaks the routing
     * table — dead sockets accumulate until the process restarts, and every
     * broadcast then walks a growing list of closed connections.
     */
    static unregister(socket: WebSocket): void {
        const state = this.clients.get(socket);
        if (!state) return;
        for (const naptanId of state.stations) {
            const room = this.rooms.get(naptanId);
            if (!room) continue;
            room.delete(socket);
            if (room.size === 0) this.rooms.delete(naptanId);
        }
        this.clients.delete(socket);
    }

    // ─── subscriptions ───────────────────────────────────────────────────

    /**
     * Subscribe, returning the ids that took effect so the caller can flush a
     * snapshot for each in the same turn.
     *
     * Deliberately does NOT read the cache to pre-test for a payload: that cost
     * an extra `getLatest` per station, which double-counted `streamHits` and
     * made the metric exactly 2x reality. `snapshotFrame` already returns
     * undefined when nothing is held, so one read is enough — and this keeps
     * the class to pure routing, as its header claims.
     */
    static subscribe(socket: WebSocket, naptanIds: string[]): { subscribed: string[]; rejected: string[] } {
        const state = this.clients.get(socket);
        if (!state) return { subscribed: [], rejected: [] };

        const subscribed: string[] = [];
        const rejected: string[] = [];
        for (const raw of naptanIds) {
            const naptanId = this.normalise(raw);
            if (!naptanId) continue;

            // Bound per-connection memory; a client asking for hundreds of
            // stations is a bug or an abuse, not a real board. Over-limit ids
            // are REPORTED rather than silently dropped — a client that thinks
            // it is subscribed but isn't would show a permanently frozen board
            // with nothing to explain it.
            //
            // Membership is checked FIRST so re-sending an existing list is
            // idempotent: a client already at the limit would otherwise get a
            // subscription_limit error for stations it is subscribed to.
            if (!state.stations.has(naptanId)) {
                if (state.stations.size >= this.MAX_STATIONS_PER_CLIENT) { rejected.push(naptanId); continue; }
                state.stations.add(naptanId);
                let room = this.rooms.get(naptanId);
                if (!room) { room = new Set(); this.rooms.set(naptanId, room); }
                room.add(socket);
            }

            subscribed.push(naptanId);
        }
        return { subscribed, rejected };
    }

    static unsubscribe(socket: WebSocket, naptanIds: string[]): void {
        const state = this.clients.get(socket);
        if (!state) return;
        for (const raw of naptanIds) {
            const naptanId = this.normalise(raw);
            state.stations.delete(naptanId);
            const room = this.rooms.get(naptanId);
            if (!room) continue;
            room.delete(socket);
            if (room.size === 0) this.rooms.delete(naptanId);
        }
    }

    /**
     * Frame for a newly-subscribed client, built from whatever the shared cache
     * holds — at ANY age. Waiting for the next change would leave the board
     * blank on every app open.
     */
    static snapshotFrame(naptanId: string): string | undefined {
        const payload = PredictionCache.getLatest(naptanId);
        if (!payload) return undefined;
        const id = this.normalise(naptanId);
        return `{"type":"snapshot","station":${JSON.stringify(id)},"payload":${JSON.stringify(payload)}}`;
    }

    // ─── fan-out ─────────────────────────────────────────────────────────

    /**
     * Cache the payload and write it to every subscriber.
     *
     * The frame is serialised ONCE per station and the same string handed to
     * every socket — the difference between fan-out cost scaling with
     * connection count and being ~free. Retrofitting that later is far harder
     * than starting with it.
     *
     * Returns the number of sockets written to, or **-1** when the cache
     * rejected the payload as out-of-order (a newer one is already held) and
     * nothing was sent. Callers must test `< 0` explicitly — a bare truthiness
     * check reads -1 as "delivered".
     */
    static broadcast(naptanId: string, payload: unknown, source: 'syncer' | 'rest' = 'syncer'): number {
        const id = this.normalise(naptanId);
        if (!id) return 0;

        // Store first, for TWO reasons now.
        //
        // 1. Ordering. The cache owns it: a `false` here means a NEWER payload
        //    is already held, so re-broadcasting this one would make clients
        //    flicker backwards.
        // 2. `PredictionCache.set` stamps each departure's `viaKey` IN PLACE,
        //    and the frame below is serialised from this same object. Moving the
        //    store after the send would ship unstamped departures to every
        //    streaming client while the cached copy had them — the board and the
        //    live stream would filter differently. Keep this line first.
        const accepted = PredictionCache.set(id, payload as any, source);
        if (!accepted) return -1;

        const room = this.rooms.get(id);
        if (!room || room.size === 0) return 0;

        const body = JSON.stringify(payload);
        const frame = `{"type":"update","station":${JSON.stringify(id)},"payload":${body}}`;
        let sent = 0;
        for (const socket of room) {
            if (socket.readyState !== WebSocket.OPEN) continue;
            try { socket.send(frame); sent++; } catch { /* dropped mid-write; cleanup runs on 'close' */ }
        }
        return sent;
    }

    // ─── keepalive ───────────────────────────────────────────────────────

    /**
     * Ping every socket; close any that missed the previous round.
     *
     * Two jobs: keeps Nginx from culling an idle connection at
     * `proxy_read_timeout`, and detects half-open sockets — a client that
     * vanished without a close frame (train tunnel, airplane mode) otherwise
     * stays in the routing table forever.
     */
    static sweep(): void {
        for (const [socket, state] of this.clients) {
            if (state.awaitingPong) { try { socket.terminate(); } catch { /* already gone */ } continue; }
            state.awaitingPong = true;
            try { socket.ping(); } catch { /* dead; the close handler unregisters */ }
        }
    }

    static markPong(socket: WebSocket): void {
        const state = this.clients.get(socket);
        if (state) state.awaitingPong = false;
    }

    // ─── ops ─────────────────────────────────────────────────────────────

    static stats() {
        return {
            connections: this.clients.size,
            rooms: this.rooms.size,
            cache: PredictionCache.stats(),
        };
    }

    /**
     * PM2 `-i max` gives one worker per core, all sharing port 3000. Each holds
     * its own connections, so a Syncer POST reaches only the worker it happens
     * to be routed to. Staging is 1 vCPU today (so `max` == 1 and this is
     * fine), but a bigger box would half-deliver silently.
     */
    static assertSingleInstance(): void {
        const instance = process.env.NODE_APP_INSTANCE;
        if (instance !== undefined && instance !== '0') {
            console.warn(
                `WS: ⚠️  Running as PM2 instance ${instance}. The stream hub is single-process — ` +
                `connections on this worker will NOT receive updates posted to another. ` +
                `Run the backend with 'pm2 -i 1', or add a cross-worker relay.`
            );
        }
    }

    /** Close every socket with 1001 "going away" so clients reconnect promptly. */
    static closeAll(): void {
        for (const socket of this.clients.keys()) {
            try { socket.close(1001, 'server shutting down'); } catch { /* ignore */ }
        }
        this.clients.clear();
        this.rooms.clear();
        // The cache is deliberately NOT cleared — it's shared with REST, which
        // keeps serving during a graceful shutdown.
    }

    /**
     * The Syncer keys its map by FCM topic (`Station_940GZZDLTWG`) while the
     * payload's own `id` is the bare naptanId. Normalising here means callers
     * never have to care which form they hold.
     */
    private static normalise(raw: string): string {
        if (!raw) return '';
        return raw.startsWith('Station_') ? raw.slice('Station_'.length) : raw;
    }
}
