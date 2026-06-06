/**
 * Canonical time handling for the master-slave replication watermark.
 *
 * Internally EVERYTHING is epoch milliseconds (UTC integer): the Firestore
 * `lastUpdatedTime` field, the SQLite columns, and the per-collection sync
 * checkpoints. Integers compare numerically and unambiguously in Firestore,
 * SQLite, JS and Java — which eliminates the ISO-string format / precision /
 * timezone pitfalls entirely.
 *
 * ISO-8601 is produced ONLY at the API boundary (see `toIso`), for clients
 * that still expect a string (e.g. the mobile `LineStatus.lastUpdatedTime`).
 */

/** Current time as epoch milliseconds — the canonical watermark unit. */
export const nowMs = (): number => Date.now();

/**
 * Coerce a stored/incoming value to epoch millis. Accepts:
 *   - an existing number (passed through),
 *   - a NUMERIC string (epoch millis, e.g. "1780780698371" or a REAL-serialised
 *     "1780351370057.0") — this is how `updateLastSyncTime` persists the
 *     watermark, so it MUST round-trip,
 *   - an ISO-8601 string (legacy checkpoints / API boundary), or
 *   - null/garbage (→ null).
 *
 * The numeric-string case is critical: without it, a stored watermark like
 * "1780…" goes through `Date.parse` → NaN → null, so the delta sync treats the
 * collection as never-synced and re-reads it WHOLE on every boot. Parsing the
 * numeric string keeps the watermark readable so boots stay delta (minimal
 * Firestore reads).
 */
export function toEpochMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        // Numeric epoch string first (possibly with a trailing ".0" from REAL).
        if (/^\d+(\.\d+)?$/.test(trimmed)) {
            const n = Math.trunc(Number(trimmed));
            if (Number.isFinite(n) && n > 0) return n;
        }
        const ms = Date.parse(trimmed);
        if (!Number.isNaN(ms)) return ms;
    }
    return null;
}

/**
 * Format an epoch-millis watermark as an ISO-8601 UTC string for API
 * responses. This is the ONLY place the internal integer becomes a string —
 * "format at the API boundary". Returns null for a missing/invalid watermark.
 */
export function toIso(ms: number | null | undefined): string | null {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
}
