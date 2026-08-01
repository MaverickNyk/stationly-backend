import { StationPredictionResponse } from '../../models';

/** Which producer last wrote an entry. Diagnostic only — never affects reads. */
export type PredictionSourceTag = 'syncer' | 'rest';

export interface CachedPrediction {
    /** The station payload, exactly as clients receive it. */
    payload: StationPredictionResponse;
    /** Epoch ms this entry was written — the basis for every freshness check. */
    storedAt: number;
    /**
     * The payload's own `lut`, parsed to epoch ms, or null when absent/unparseable.
     * Used to reject out-of-order writes, NOT to judge freshness (`storedAt` does
     * that) — a producer's clock is not ours.
     */
    lut: number | null;
    source: PredictionSourceTag;
}

export interface PredictionCacheStats {
    /** Entries currently held. */
    size: number;

    // ── REST reads (getFresh) ────────────────────────────────────────────
    // Counted SEPARATELY from stream reads on purpose. Only these three say
    // anything about TfL load, because only a REST miss triggers a fetch.
    /** Served within the freshness window — a TfL call avoided. */
    restHits: number;
    /** Entry held but too old, so REST refetched. Tune `freshForMs` if high. */
    restStaleMisses: number;
    /** Nothing held — cold cache, or a station the Syncer doesn't poll. */
    restMisses: number;
    /**
     * Share of REST reads answered without touching TfL. THE number this
     * module exists to move. Deliberately excludes stream reads: those never
     * cause a TfL call, so folding them in would inflate this toward 1.0 and
     * hide the thing it is meant to measure.
     */
    restHitRate: number;

    // ── Stream reads (getLatest) ─────────────────────────────────────────
    /** Snapshot served to a subscriber, at any age. */
    streamHits: number;
    /** Subscriber found nothing to paint yet. */
    streamMisses: number;

    /** Writes accepted, by producer. */
    writes: Record<PredictionSourceTag, number>;
    /** Writes rejected because a newer payload was already held. */
    rejectedOutOfOrder: number;
    /** Entries dropped by the TTL sweeper. */
    evicted: number;
    /** Concurrent misses that awaited an in-flight fetch instead of starting one. */
    coalesced: number;

    // ── Negative cache (TfL-confirmed 404s) ──────────────────────────────
    /** Ids currently remembered as unknown to TfL. */
    unknownIds: number;
    /** Requests refused from that memory — each one a TfL call avoided. */
    negativeHits: number;
}

export interface PredictionCacheOptions {
    /**
     * How long an entry may be served to a freshness-sensitive reader (REST).
     * Streaming readers ignore this — see `getLatest`.
     */
    freshForMs?: number;
    /**
     * How long an entry is retained at all. Must exceed `freshForMs`: a stale
     * entry is still useful to a streaming client and as a fallback when TfL
     * is failing, so it is NOT dropped the moment it stops being "fresh".
     */
    retainForMs?: number;
    /** Hard ceiling on entries, as a backstop against unbounded growth. */
    maxEntries?: number;
    /** How often the TTL sweeper runs. */
    sweepIntervalMs?: number;
}
