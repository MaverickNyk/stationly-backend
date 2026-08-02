import { WebSocket } from 'ws';
import { DataCacheService } from './dataCacheService';
import { UnknownStationError } from '../client/TflApiClient';
import { StationController } from '../controllers/stationController';

/**
 * Guarded TfL prefetch for stations a subscribing client wants but the cache
 * has nothing for.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * `subscribe` used to be pure cache reads — ZERO outbound calls. Once a cold
 * subscribe can reach TfL, the socket becomes an amplification surface, and
 * unlike REST it sits behind no rate limiter: `RateLimitMiddleware` and
 * `validateApiKey` guard `/api/v1`, but a socket is checked once at auth and
 * then trusted for its lifetime. One valid Firebase token would otherwise buy
 * unlimited outbound fetches.
 *
 * Three independent limits, each closing a different hole:
 *
 *  1. EXISTENCE. A naptanId not in the local station table never reaches TfL.
 *     Without this, `{"stations":["ASDF1"]}` produces a live TfL request whose
 *     result is cached as "Unknown Station" — so ~500 junk ids evict every real
 *     entry from the cache, and `evictOldest()` (an O(n) scan per insert past
 *     the ceiling) starts running on every write. The check is a Map lookup
 *     against data already in memory, so it costs nothing.
 *
 *  2. PER-SOCKET BUDGET. The 25-station subscription cap is CONCURRENT, not
 *     cumulative: subscribe → unsubscribe → subscribe-a-different-25 loops
 *     forever. A refilling token budget bounds what one socket can spend over
 *     time, which the subscription cap cannot.
 *
 *  3. GLOBAL CONCURRENCY. Single-flight in `PredictionCache.getOrFetch` dedupes
 *     per station; it does nothing about 200 DIFFERENT cold stations at once.
 *     That is the mass-reconnect case — cache empty after a restart, so every
 *     station is cold precisely when every client reconnects. `TflApiClient`
 *     does space requests 210ms apart, so TfL itself is already protected; what
 *     that interceptor does NOT do is shed load, so without a cap here the
 *     excess accumulates as pending promises all sleeping behind it. This
 *     bounds the backlog and drops the overflow instead.
 *
 * Delivery is NOT this module's job. `fetchPredictions` ends in
 * `fetchPredictionsFromTfl`, which broadcasts to everyone in the station's room;
 * `subscribe()` put the socket there before we were called. We only decide
 * whether the fetch is allowed to happen.
 */

/** Simultaneous outbound TfL prefetches, process-wide. */
const MAX_CONCURRENT = 4;
/** Prefetches allowed to wait behind the cap before we shed load. */
const MAX_QUEUED = 150;
/** Per-socket allowance, refilled every window. Generous for real use: a cold
 *  app open spends ~25, and browsing to an already-fetched board spends none. */
const BUDGET_PER_WINDOW = 40;
const BUDGET_WINDOW_MS = 60_000;

interface Budget {
    tokens: number;
    /** Epoch ms at which `tokens` refills. */
    resetAt: number;
}

/** Fired per station when its fetch fails; `permanent` means TfL 404'd the id. */
type OnFailure = (naptanId: string, permanent: boolean) => void;

/** Immediate, synchronous rejections — the caller turns these into frames. */
export interface PrefetchRejections {
    /** Not a real station; the client should stop asking. */
    unknown: string[];
    /** Over budget or the queue is full; transient. */
    throttled: string[];
}

export class StreamPrefetch {
    /** Station ids awaiting a slot. Their callbacks live in `pending`. */
    private static queue: string[] = [];
    private static active = 0;

    /**
     * Deliberately a WeakMap: a disconnected socket's budget is collected along
     * with the socket, so there is no cleanup hook to wire into the close path
     * and forget. (A plain Map here would leak one entry per connection.)
     */
    private static budgets = new WeakMap<WebSocket, Budget>();

    /**
     * naptanId → callbacks of every socket waiting on that fetch, for stations
     * queued or in flight. Two jobs: dedupe — sockets cold on the same station
     * share one slot and one TfL call, since the broadcast reaches the whole
     * room anyway — and failure fan-out. EVERY waiter is notified on failure:
     * a permanent failure must drop the subscription on all of them, or late
     * joiners keep a dead station holding one of their 25 slots with nothing
     * ever telling them why.
     */
    private static pending = new Map<string, OnFailure[]>();

    private static droppedUnknown = 0;
    private static droppedBudget = 0;
    private static droppedQueueFull = 0;
    private static rejectedByTfl = 0;
    private static failed = 0;
    private static completed = 0;

    /**
     * Request prefetches for `naptanIds`, returning what was refused outright.
     *
     * `onFailure` fires later, per station, only when the fetch itself throws —
     * success needs no callback because the broadcast already delivered it.
     */
    static request(
        socket: WebSocket,
        naptanIds: string[],
        onFailure: OnFailure,
    ): PrefetchRejections {
        const unknown: string[] = [];
        const throttled: string[] = [];

        for (const naptanId of naptanIds) {
            if (!DataCacheService.getStationById(naptanId)) {
                this.droppedUnknown++;
                unknown.push(naptanId);
                continue;
            }

            // Already queued or in flight — the broadcast will reach this
            // socket too, so it costs no budget and no slot. Join the waiter
            // list so a failure notifies this socket as well.
            const waiters = this.pending.get(naptanId);
            if (waiters) { waiters.push(onFailure); continue; }

            // Capacity is checked BEFORE budget: spending a token on a job we
            // are about to drop would penalise the client for our own overload.
            if (this.queue.length >= MAX_QUEUED) {
                this.droppedQueueFull++;
                throttled.push(naptanId);
                continue;
            }

            if (!this.spend(socket)) {
                this.droppedBudget++;
                throttled.push(naptanId);
                continue;
            }

            this.pending.set(naptanId, [onFailure]);
            this.queue.push(naptanId);
        }

        this.pump();
        return { unknown, throttled };
    }

    /** Take one token, refilling the window if it has elapsed. */
    private static spend(socket: WebSocket): boolean {
        const now = Date.now();
        let budget = this.budgets.get(socket);
        if (!budget || now >= budget.resetAt) {
            budget = { tokens: BUDGET_PER_WINDOW, resetAt: now + BUDGET_WINDOW_MS };
            this.budgets.set(socket, budget);
        }
        if (budget.tokens <= 0) return false;
        budget.tokens--;
        return true;
    }

    /** Start jobs up to the concurrency cap. Re-entered as each one settles. */
    private static pump(): void {
        while (this.active < MAX_CONCURRENT && this.queue.length > 0) {
            const naptanId = this.queue.shift()!;
            this.active++;

            StationController.fetchPredictions(naptanId)
                .then(() => { this.completed++; })
                .catch((err) => {
                    // TfL being down is not a client error and must not kill the
                    // socket. Logged per station, which the concurrency cap keeps
                    // bounded — without it an outage would emit one line per
                    // station per subscribe.
                    //
                    // A 404 from TfL is different in kind: the id is dead, not
                    // the service. The caller is told so it can report it as
                    // permanent and drop the subscription, exactly as it does
                    // for an id the local table already rejected. This is the
                    // case the local gate CANNOT catch — a station present in
                    // our table but retired or renamed at TfL.
                    const permanent = err instanceof UnknownStationError;
                    this.failed++;
                    if (permanent) this.rejectedByTfl++;
                    console.warn(`WS: ⚠️  Prefetch failed for ${naptanId}:`, (err as any)?.message || err);
                    for (const notify of this.pending.get(naptanId) ?? []) {
                        try { notify(naptanId, permanent); } catch { /* socket already gone */ }
                    }
                })
                .finally(() => {
                    this.active--;
                    this.pending.delete(naptanId);
                    // Safe to recurse: this runs in a microtask after the loop
                    // above has exited, so the stack does not grow.
                    this.pump();
                });
        }
    }

    static stats() {
        return {
            active: this.active,
            queued: this.queue.length,
            completed: this.completed,
            failed: this.failed,
            droppedUnknown: this.droppedUnknown,
            droppedBudget: this.droppedBudget,
            droppedQueueFull: this.droppedQueueFull,
            rejectedByTfl: this.rejectedByTfl,
        };
    }

    /** Test/ops helper. */
    static reset(): void {
        this.queue = [];
        this.active = 0;
        this.pending.clear();
        this.budgets = new WeakMap();
        this.droppedUnknown = this.droppedBudget = this.droppedQueueFull = 0;
        this.rejectedByTfl = 0;
        this.failed = this.completed = 0;
    }
}
