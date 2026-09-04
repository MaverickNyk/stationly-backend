import { WebSocket } from 'ws';

/**
 * In-memory fan-out hub for live line status updates.
 *
 * The line-status sibling of StationStreamHub, sharing the same socket: a
 * client subscribes to stations and lines over ONE connection, so auth, the
 * keepalive sweep and the routing table's lifecycle all stay in
 * StationStreamHub. This class owns line rooms and nothing else.
 *
 * ── How this differs from StationStreamHub, and why ──────────────────────
 *
 * 1. NO CACHE OF ITS OWN. Line statuses already live in DataCacheService, with
 *    `setLineStatus` as the single write point every producer goes through.
 *    Adding a second store would give the same data two sources of truth —
 *    the opposite of what PredictionCache exists to prevent. So this hub is
 *    pure routing and never reads or writes the cache; callers pass payloads in.
 *
 *    That store is now MEMORY-ONLY for the live path. The Firestore
 *    onSnapshot listener that used to feed it was removed: it billed a document
 *    read for every status change, on every instance, forever. Liveness now
 *    comes from the Syncer posting to /internal/line-status-updates, exactly as
 *    station predictions have always worked.
 *
 * 2. NO `register`. Membership is created lazily on first subscribe. There is
 *    no separate connection lifecycle to attach to — StationStreamHub.register
 *    already ran at auth, and `forget()` is called from the same close handler.
 *
 * 3. IMPORTS ONLY `ws`. DataCacheService imports THIS module to broadcast from
 *    `setLineStatus`, so importing DataCacheService back would form a cycle.
 *    That constraint is why payloads are passed in rather than looked up.
 */

/** Which producer wrote an entry. Diagnostic only — never affects routing. */
export type LineStatusSource = 'syncer' | 'tfl';

export interface LineStatusPayload {
    id: string;
    name?: string;
    statusSeverityDescription?: string;
    reason?: string;
    mode?: string;
    lastUpdatedTime?: string | number;
}

/** Notified on every genuinely-new line status. See [LineStatusStreamHub.observe]. */
export type LineStatusObserver = (lineId: string, payload: LineStatusPayload) => void;

export class LineStatusStreamHub {

    /**
     * Side-effects that want to know a line's status changed.
     *
     * An observer list rather than a direct import, purely to keep constraint 3
     * above intact: this module imports only `ws`, and the disruption trigger
     * pulls in the push stack (registry, APNs, refresh policy). Registering
     * from `server.ts` inverts that dependency so the hub stays a leaf.
     *
     * Observers are called synchronously and their exceptions are swallowed —
     * this runs inside the live-stream broadcast path, and a failing side
     * effect must never cost a connected client its board.
     */
    private static observers: LineStatusObserver[] = [];

    /** Register a side-effect. Called once at startup from `server.ts`. */
    static observe(observer: LineStatusObserver): void {
        this.observers.push(observer);
    }

    private static notifyObservers(lineId: string, payload: LineStatusPayload): void {
        for (const observer of this.observers) {
            try { observer(lineId, payload); } catch { /* never break the broadcast */ }
        }
    }

    /** lineId → sockets watching it. The routing table. */
    private static rooms = new Map<string, Set<WebSocket>>();

    /** Reverse index, so a disconnect is O(subscriptions) not O(all rooms). */
    private static membership = new Map<WebSocket, Set<string>>();

    /**
     * lineId → the last payload we serialised for it.
     *
     * Suppresses duplicate frames. Two producers write the same statuses
     * independently — the Syncer's push and our own TfL fallback refresh — and
     * they run their own change-detection against their own view, so the same
     * status legitimately arrives twice with no way for either side to know.
     * A retried POST does the same. Without this, clients would see a status
     * "change" to the value they already had.
     *
     * Bounded by the number of lines (~30), so it needs no eviction. Note this
     * is a FRAME filter, not a cache: it holds serialised output, never serves
     * reads, and `closeAll` deliberately keeps it (see below).
     */
    private static lastFrame = new Map<string, string>();

    /** Generous: a client showing every tube line plus rail modes needs ~25. */
    private static readonly MAX_LINES_PER_CLIENT = 30;

    /**
     * Writes by producer — the line-status analogue of PredictionCache.writes.
     *
     * Operationally the most important number here: the Syncer's push is now
     * the ONLY live source of line status, and if it silently stops (Java not
     * deployed, secret mismatch, endpoint moved) the TfL fallback keeps the
     * cache populated, so nothing looks broken while every client sits behind
     * the fallback's polling interval. `writes.syncer` going flat is the signal.
     *
     * Tagged `tfl` rather than `rest` — unlike predictions, that refresh is
     * triggered from BOTH the REST endpoint and a cold stream subscribe, so
     * naming it after one caller would be misleading.
     */
    private static writes: Record<LineStatusSource, number> = { syncer: 0, tfl: 0 };

    private static suppressedDuplicates = 0;

    // ─── subscriptions ───────────────────────────────────────────────────

    /**
     * Subscribe, returning the ids that took effect so the caller can flush a
     * snapshot for each in the same turn. Mirrors StationStreamHub.subscribe,
     * including reporting over-limit ids rather than dropping them silently —
     * a client that believes it is subscribed but isn't would show a
     * permanently frozen status row with nothing to explain it.
     */
    static subscribe(socket: WebSocket, lineIds: string[]): { subscribed: string[]; rejected: string[] } {
        let mine = this.membership.get(socket);
        if (!mine) { mine = new Set(); this.membership.set(socket, mine); }

        const subscribed: string[] = [];
        const rejected: string[] = [];
        for (const raw of lineIds) {
            const lineId = this.normalise(raw);
            if (!lineId) continue;

            // Membership checked FIRST so re-sending an existing list is
            // idempotent: a client already at the limit would otherwise be
            // told it had exceeded it for lines it already holds.
            if (!mine.has(lineId)) {
                if (mine.size >= this.MAX_LINES_PER_CLIENT) { rejected.push(lineId); continue; }
                mine.add(lineId);
                let room = this.rooms.get(lineId);
                if (!room) { room = new Set(); this.rooms.set(lineId, room); }
                room.add(socket);
            }

            subscribed.push(lineId);
        }
        return { subscribed, rejected };
    }

    static unsubscribe(socket: WebSocket, lineIds: string[]): void {
        const mine = this.membership.get(socket);
        if (!mine) return;
        for (const raw of lineIds) {
            const lineId = this.normalise(raw);
            mine.delete(lineId);
            const room = this.rooms.get(lineId);
            if (!room) continue;
            room.delete(socket);
            if (room.size === 0) this.rooms.delete(lineId);
        }
        if (mine.size === 0) this.membership.delete(socket);
    }

    /**
     * Drop a socket from every line room it joined.
     *
     * MUST be called from the same close handler as StationStreamHub.unregister
     * — this hub has no lifecycle of its own, so a missed call here leaks dead
     * sockets into the routing table until the process restarts.
     */
    static forget(socket: WebSocket): void {
        const mine = this.membership.get(socket);
        if (!mine) return;
        for (const lineId of mine) {
            const room = this.rooms.get(lineId);
            if (!room) continue;
            room.delete(socket);
            if (room.size === 0) this.rooms.delete(lineId);
        }
        this.membership.delete(socket);
    }

    // ─── frames ──────────────────────────────────────────────────────────

    /**
     * Frame for a newly-subscribed client, built from whatever the caller
     * holds — at ANY age. A status is valid until superseded, so there is no
     * freshness test to apply; waiting for the next change would leave the row
     * blank on every app open.
     */
    static snapshotFrame(lineId: string, payload: LineStatusPayload | undefined): string | undefined {
        if (!payload) return undefined;
        return `{"type":"snapshot","line":${JSON.stringify(this.normalise(lineId))},"payload":${JSON.stringify(payload)}}`;
    }

    // ─── fan-out ─────────────────────────────────────────────────────────

    /**
     * Write a status to every subscriber of that line.
     *
     * Called from DataCacheService.setLineStatus AFTER the cache is updated, so
     * this never stores anything — by then the data is already the truth. That
     * single hook is what makes every producer fan out for free: the Syncer's
     * ingest and the TfL fallback refresh both end up there.
     *
     * The frame is serialised ONCE and the same string handed to every socket.
     * Returns the number of sockets written to, or **-1** when the payload was
     * identical to the last one broadcast and nothing was sent. Callers must
     * test `< 0` explicitly — a bare truthiness check reads -1 as "delivered".
     */
    static broadcast(lineId: string, payload: LineStatusPayload, source: LineStatusSource = 'syncer'): number {
        const id = this.normalise(lineId);
        if (!id || !payload) return 0;

        const body = JSON.stringify(payload);
        this.writes[source]++;
        if (this.lastFrame.get(id) === body) { this.suppressedDuplicates++; return -1; }
        this.lastFrame.set(id, body);

        // Notify observers (today: the disruption→push trigger).
        //
        // Placed here, after the duplicate filter and BEFORE the room check,
        // for two reasons. After the filter, because an identical re-broadcast
        // is not news. Before the room check, because devices needing a PUSH
        // are by definition the ones with NO socket open — returning early on
        // an empty room would mean the trigger only ever fired for users whose
        // app was already in the foreground watching, which is exactly backwards.
        this.notifyObservers(id, payload);

        const room = this.rooms.get(id);
        if (!room || room.size === 0) return 0;

        const frame = `{"type":"update","line":${JSON.stringify(id)},"payload":${body}}`;
        let sent = 0;
        for (const socket of room) {
            if (socket.readyState !== WebSocket.OPEN) continue;
            try { socket.send(frame); sent++; } catch { /* dropped mid-write; cleanup runs on 'close' */ }
        }
        return sent;
    }

    // ─── ops ─────────────────────────────────────────────────────────────

    static stats() {
        return {
            rooms: this.rooms.size,
            subscribers: this.membership.size,
            trackedLines: this.lastFrame.size,
            writes: { ...this.writes },
            suppressedDuplicates: this.suppressedDuplicates,
        };
    }

    /** Clear routing state. Sockets themselves are closed by StationStreamHub. */
    static closeAll(): void {
        this.rooms.clear();
        this.membership.clear();
        // `lastFrame` is deliberately KEPT: it mirrors DataCacheService, which
        // also survives, so clearing it would make the next write look like a
        // change and re-broadcast data every client already has.
    }

    /** Test/ops helper — wipes everything including the duplicate filter. */
    static reset(): void {
        this.rooms.clear();
        this.membership.clear();
        this.lastFrame.clear();
        this.writes = { syncer: 0, tfl: 0 };
        this.suppressedDuplicates = 0;
    }

    /**
     * Accept either a bare lineId or the Syncer's FCM topic form
     * (`LineStatus_tube_victoria`), mirroring how StationStreamHub absorbs the
     * `Station_` prefix. The ingest path sends bare ids, but tolerating the
     * topic form means a caller that reuses the FCM map — the obvious mistake,
     * since that is exactly what the station path does — fans out correctly
     * instead of silently creating rooms nobody is subscribed to.
     */
    private static normalise(raw: string): string {
        if (typeof raw !== 'string') return '';
        const id = raw.trim();
        if (!id.startsWith('LineStatus_')) return id;
        // LineStatus_<mode>_<lineId>; mode never contains an underscore.
        const rest = id.slice('LineStatus_'.length);
        const sep = rest.indexOf('_');
        return sep === -1 ? rest : rest.slice(sep + 1);
    }
}
