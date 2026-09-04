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
    const { sequences, sequenceVias, ...rest } = route;
    return {
        ...rest,
        sequencesJson: JSON.stringify(sequences || {}),
        // A SEPARATE field rather than a second key inside `sequencesJson`.
        // During a rolling deploy an older instance still parses that blob
        // straight into `route.sequences`, so changing its shape would hand it
        // an object where it expects `string[][]` and quietly disable station
        // filtering. A field it never reads cannot do that.
        sequenceViasJson: JSON.stringify(sequenceVias || {}),
    };
}

/** Reconstruct `sequences: Record<string,string[][]>` from `sequencesJson`. */
export function decodeRouteFromFirestore(route: any): any {
    if (!route) return route;
    const hasUsableSequences = route.sequences && Object.keys(route.sequences).length > 0;
    if (!hasUsableSequences && route.sequencesJson) {
        try { route.sequences = JSON.parse(route.sequencesJson); } catch { /* leave undefined → TfL re-enrich */ }
    }
    // Absent on every route cached before branch labels existed. Left undefined
    // rather than defaulted to {}, because the caller re-enriches on undefined
    // and would otherwise keep serving unlabelled branches forever.
    const hasVias = route.sequenceVias && Object.keys(route.sequenceVias).length > 0;
    if (!hasVias && route.sequenceViasJson) {
        try { route.sequenceVias = JSON.parse(route.sequenceViasJson); } catch { /* leave undefined → TfL re-enrich */ }
    }
    return route;
}
