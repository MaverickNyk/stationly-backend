import { StationPredictionResponse } from '../../models';
import {
    CachedPrediction,
    PredictionCacheOptions,
    PredictionCacheStats,
    PredictionSourceTag,
} from './types';

/**
 * THE single in-memory store of current station predictions.
 *
 * Both producers write here and both consumers read here:
 *
 *      Syncer push ──┐                 ┌──► WebSocket stream (getLatest)
 *                    ├──► PredictionCache ──┤
 *      REST TfL fetch┘                 └──► REST endpoint    (getFresh)
 *
 * Before this existed the same data was fetched from TfL twice — once by the
 * Syncer every 30s for its FCM/stream fan-out, and again by the REST endpoint
 * whenever its own cache lapsed. Merging them means a Syncer push satisfies
 * later REST callers, and a REST fetch for a station the Syncer doesn't cover
 * (i.e. one nobody has subscribed to) serves anyone streaming it.
 *
 * ── Design decisions worth knowing ───────────────────────────────────────
 *
 * 1. FRESHNESS IS THE CALLER'S CALL. The cache stores age; it does not impose
 *    one policy. A streaming client wants the latest payload whatever its age
 *    (a board showing 90s-old data beats a blank board), while REST wants
 *    "fresh or go get it". Hence two distinct read methods rather than one with
 *    a flag — the intent is visible at the call site.
 *
 * 2. `lut` ORDERS WRITES, `storedAt` MEASURES AGE. Producers' clocks aren't
 *    ours, so freshness is judged by when WE stored it. But `lut` is comparable
 *    between payloads for the same station, so it's the right guard against a
 *    delayed or retried write overwriting newer data — a rare bug, and a
 *    horrible one because it's intermittent.
 *
 * 3. DELIBERATELY NOT PERSISTED. This data is worthless within ~60s, so paying
 *    a disk write for it (as the old SQLite `station_preds` table did) buys
 *    nothing. After a restart the cache is empty and reads simply fall through
 *    to TfL — exactly the pre-existing behaviour, so no regression; the Syncer
 *    refills it within a poll cycle or two.
 *
 * 4. RETENTION OUTLIVES FRESHNESS. Entries are kept well past the point they
 *    stop being REST-fresh, because they remain useful to streaming clients and
 *    as a fallback while TfL is erroring.
 *
 * 5. PER-PROCESS. Under PM2 cluster (`-i max`) each worker holds its own cache.
 *    That costs some duplicate TfL fetches but is never *incorrect*. See
 *    StationStreamHub.assertSingleInstance for the related fan-out caveat,
 *    which is a correctness problem rather than an efficiency one.
 */
export class PredictionCache {
    private static entries = new Map<string, CachedPrediction>();
    private static sweeper: NodeJS.Timeout | null = null;

    /** Matches the 60s window the previous SQLite cache enforced. */
    private static freshForMs = 60_000;
    /**
     * 10 min. Generous on purpose — the Syncer only re-pushes a station when it
     * CHANGES (plus a heartbeat every ~5 cycles), so a quiet station's entry can
     * legitimately be minutes old and still be correct.
     */
    private static retainForMs = 10 * 60_000;
    private static maxEntries = 500;
    private static sweepIntervalMs = 60_000;

    // REST and stream reads are counted separately and never mixed: only a
    // REST miss causes a TfL call, so blending stream reads into the hit rate
    // would inflate it toward 1.0 and hide the metric's whole purpose.
    private static restHits = 0;
    private static restStaleMisses = 0;
    private static restMisses = 0;
    private static streamHits = 0;
    private static streamMisses = 0;
    private static evicted = 0;
    private static rejectedOutOfOrder = 0;
    private static coalesced = 0;
    private static writes: Record<PredictionSourceTag, number> = { syncer: 0, rest: 0 };

    /**
     * Single-flight: naptanId → the in-flight fetch for it.
     *
     * Without this, N concurrent requests for the same cold station all miss
     * and all call TfL — exactly when it hurts most, since concurrency means a
     * traffic spike. Mirrors LineController's `inFlightStatusRefresh`.
     */
    private static inFlight = new Map<string, Promise<StationPredictionResponse>>();

    static configure(opts: PredictionCacheOptions = {}): void {
        if (opts.freshForMs !== undefined) this.freshForMs = opts.freshForMs;
        if (opts.retainForMs !== undefined) this.retainForMs = opts.retainForMs;
        if (opts.maxEntries !== undefined) this.maxEntries = opts.maxEntries;
        if (opts.sweepIntervalMs !== undefined) this.sweepIntervalMs = opts.sweepIntervalMs;
    }

    // ─── reads ───────────────────────────────────────────────────────────

    /**
     * For REST: the payload only if still within the freshness window.
     *
     * `undefined` means "go fetch from TfL" — either nothing is held, or what
     * we hold is too old to serve. Both outcomes are counted separately so the
     * stats can distinguish "cache is cold" from "TTL is too tight".
     */
    static getFresh(naptanId: string, maxAgeMs: number = this.freshForMs): StationPredictionResponse | undefined {
        const entry = this.entries.get(this.normalise(naptanId));
        if (!entry) { this.restMisses++; return undefined; }
        if (Date.now() - entry.storedAt > maxAgeMs) { this.restStaleMisses++; return undefined; }
        this.restHits++;
        return entry.payload;
    }

    /**
     * Fresh value, or the result of `fetcher()` — with concurrent callers for
     * the same station sharing ONE fetch.
     *
     * This is the method REST should use. `getFresh` alone leaves a gap: ten
     * simultaneous requests for a cold station all miss and all hit TfL. Here
     * the first caller starts the fetch and the rest await the same promise.
     *
     * The in-flight entry is cleared in `finally`, so a failed fetch doesn't
     * poison the station — the next caller retries rather than inheriting a
     * rejected promise forever.
     */
    static async getOrFetch(
        naptanId: string,
        fetcher: () => Promise<StationPredictionResponse>,
        maxAgeMs: number = this.freshForMs,
    ): Promise<StationPredictionResponse> {
        const cached = this.getFresh(naptanId, maxAgeMs);
        if (cached) return cached;

        const id = this.normalise(naptanId);
        const existing = this.inFlight.get(id);
        if (existing) { this.coalesced++; return existing; }

        const run = (async () => {
            const fresh = await fetcher();
            this.set(id, fresh, 'rest');
            return fresh;
        })().finally(() => this.inFlight.delete(id));

        this.inFlight.set(id, run);
        return run;
    }

    /**
     * For the WebSocket stream: the newest payload we hold, at any age.
     *
     * A subscriber connecting mid-cycle needs SOMETHING to paint immediately —
     * waiting up to a full Syncer cycle for the next change would leave the
     * board empty on every app open, which is the common case.
     */
    static getLatest(naptanId: string): StationPredictionResponse | undefined {
        const entry = this.entries.get(this.normalise(naptanId));
        if (!entry) { this.streamMisses++; return undefined; }
        this.streamHits++;
        return entry.payload;
    }

    /** Age in ms of the held entry, or null if absent. For diagnostics. */
    static ageOf(naptanId: string): number | null {
        const entry = this.entries.get(this.normalise(naptanId));
        return entry ? Date.now() - entry.storedAt : null;
    }

    // ─── writes ──────────────────────────────────────────────────────────

    /**
     * Store a payload. Returns false when rejected as out-of-order.
     *
     * Callers should treat `false` as "a newer payload is already held" and skip
     * any downstream fan-out — re-broadcasting older data would make clients
     * flicker backwards.
     */
    static set(naptanId: string, payload: StationPredictionResponse, source: PredictionSourceTag): boolean {
        const id = this.normalise(naptanId);
        if (!id || !payload) return false;

        const lut = this.toEpochMs((payload as any).lut);
        const existing = this.entries.get(id);

        // Only reject when BOTH sides carry a comparable timestamp. An
        // unparseable lut must not block a write, or a producer that omits the
        // field could never update the cache at all.
        if (existing && existing.lut !== null && lut !== null && lut < existing.lut) {
            this.rejectedOutOfOrder++;
            return false;
        }

        this.entries.set(id, { payload, storedAt: Date.now(), lut, source });
        this.writes[source]++;

        if (this.entries.size > this.maxEntries) this.evictOldest();
        return true;
    }

    // ─── lifecycle ───────────────────────────────────────────────────────

    static startSweeper(): void {
        if (this.sweeper) return;
        this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs);
        // Never hold the event loop open on shutdown.
        this.sweeper.unref?.();
    }

    static stopSweeper(): void {
        if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    }

    /** Drop entries past `retainForMs`. Returns how many went. */
    static sweep(): number {
        const cutoff = Date.now() - this.retainForMs;
        let dropped = 0;
        for (const [id, entry] of this.entries) {
            if (entry.storedAt < cutoff) { this.entries.delete(id); dropped++; }
        }
        this.evicted += dropped;
        return dropped;
    }

    static stats(): PredictionCacheStats {
        // Denominator is REST reads ONLY — stream reads never cause a TfL call,
        // so including them would inflate the rate and hide the signal.
        const restReads = this.restHits + this.restStaleMisses + this.restMisses;
        return {
            size: this.entries.size,
            restHits: this.restHits,
            restStaleMisses: this.restStaleMisses,
            restMisses: this.restMisses,
            restHitRate: restReads === 0 ? 0 : Number((this.restHits / restReads).toFixed(3)),
            streamHits: this.streamHits,
            streamMisses: this.streamMisses,
            writes: { ...this.writes },
            rejectedOutOfOrder: this.rejectedOutOfOrder,
            evicted: this.evicted,
            coalesced: this.coalesced,
        };
    }

    /** Test/ops helper — wipes everything including counters. */
    static reset(): void {
        this.entries.clear();
        this.inFlight.clear();
        this.restHits = this.restStaleMisses = this.restMisses = 0;
        this.streamHits = this.streamMisses = 0;
        this.evicted = this.rejectedOutOfOrder = this.coalesced = 0;
        this.writes = { syncer: 0, rest: 0 };
    }

    // ─── internals ───────────────────────────────────────────────────────

    /** Backstop for the size ceiling: drop the least recently stored entry. */
    private static evictOldest(): void {
        let oldestId: string | null = null;
        let oldestAt = Infinity;
        for (const [id, entry] of this.entries) {
            if (entry.storedAt < oldestAt) { oldestAt = entry.storedAt; oldestId = id; }
        }
        if (oldestId) { this.entries.delete(oldestId); this.evicted++; }
    }

    /**
     * The Syncer keys its map by FCM topic (`Station_940GZZDLTWG`) while REST
     * uses the bare naptanId. Normalising here means no caller has to know
     * which form it holds — and, critically, that both write to the SAME key.
     */
    private static normalise(raw: string): string {
        if (!raw) return '';
        return raw.startsWith('Station_') ? raw.slice('Station_'.length) : raw;
    }

    private static toEpochMs(lut: unknown): number | null {
        if (typeof lut === 'number' && Number.isFinite(lut)) return lut;
        if (typeof lut === 'string' && lut.trim()) {
            const t = lut.trim();
            // ISO-8601 from both producers, but epoch-millis strings appear on
            // some paths — accept both rather than mis-order one of them.
            if (/^\d+$/.test(t)) return Number(t);
            const ms = Date.parse(t);
            if (!Number.isNaN(ms)) return ms;
        }
        return null;
    }
}
