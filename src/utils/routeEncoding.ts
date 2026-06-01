/**
 * Firestore route (de)serialization.
 *
 * A route's `sequences` field is `Record<direction, string[][]>` — each
 * direction holds an array of branch sequences (each branch an ordered array
 * of NaPTAN ids). Firestore REJECTS arrays nested directly inside arrays
 * ("invalid nested entity"), so we persist `sequences` as a JSON string in
 * `sequencesJson` and strip the raw `sequences` field before writing.
 *
 * This is backward-compatible: a backend that doesn't know about
 * `sequencesJson` simply sees no `sequences` on the doc and re-enriches it
 * from TfL on demand (the existing fallback), so reseeding never breaks a
 * running instance — it only gets faster once the decode below is deployed.
 */

/** Strip the un-storable `sequences` and emit `sequencesJson` for Firestore. */
export function encodeRouteForFirestore(route: any): any {
    if (!route) return route;
    const { sequences, ...rest } = route;
    return { ...rest, sequencesJson: JSON.stringify(sequences || {}) };
}

/** Reconstruct `sequences: Record<string,string[][]>` from `sequencesJson`. */
export function decodeRouteFromFirestore(route: any): any {
    if (!route) return route;
    const hasUsableSequences = route.sequences && Object.keys(route.sequences).length > 0;
    if (!hasUsableSequences && route.sequencesJson) {
        try { route.sequences = JSON.parse(route.sequencesJson); } catch { /* leave undefined → TfL re-enrich */ }
    }
    return route;
}
