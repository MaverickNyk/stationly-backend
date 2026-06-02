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
 * Coerce a stored/incoming value to epoch millis. Accepts an existing number
 * (passed through), an ISO-8601 string (parsed), or null/garbage (→ null).
 * Used by the migration and by any boundary that might still see a legacy
 * ISO string during the cutover window.
 */
export function toEpochMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const ms = Date.parse(value);
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
