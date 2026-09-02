/**
 * ETA rules, ported from `core/.../util/StationlyFormatters.kt` and
 * `android/.../ui/util/PredictionTicker.kt`.
 *
 * These four rules are the whole contract, and every one of them is a decision
 * somebody already made and defended. Do not "improve" them here - a web board
 * that rounds differently from the phone in the user's pocket is a bug in the
 * product, not a difference in the platform.
 */

/** TfL's own rounding: FLOOR, never round-half. 90s reads "1 min", 119s reads
 *  "1 min", 120s reads "2 min". TfL deliberately under-promises so the rider
 *  gets to the platform on time. */
export function formatEta(targetMs: number, nowMs: number): string {
    const secs = Math.floor((targetMs - nowMs) / 1000);
    return secs < 60 ? 'Due' : `${Math.floor(secs / 60)} min`;
}

/**
 * How long after a train's target before it leaves the board.
 *
 * 30s - the dwell of a train at a London platform (doors open ~10s, boarding
 * ~15-25s, doors close ~5s). The board keeps showing "Due" through that window
 * because that is what the physical platform indicator does, and the platform
 * indicator is what the rider cross-checks against. tfl.gov.uk drops the train
 * the moment its target passes; we are not matching that page.
 */
export const DEPARTED_GRACE_MS = 30_000;

/** Parse the ISO target once. Null for anything unparseable, so callers can
 *  pass the row through rather than inventing a time for it. */
export function parseTargetMs(etaIso: string): number | null {
    const t = Date.parse(etaIso);
    return Number.isFinite(t) ? t : null;
}

/**
 * Ordering key: the absolute target, never the label.
 *
 * The label has been rounded AND deliberately bumped (see bumpPlatformGroup),
 * so reading it back to sort is reading a lie - two close trains end up in the
 * wrong order exactly when it matters most. Unparseable sorts to the END, not
 * the front: an unknown time is not an imminent one.
 */
export function arrivalSortKey(targetMs: number | null): number {
    return targetMs ?? Number.MAX_SAFE_INTEGER;
}

/** Strip TfL's station suffixes and cap the length, matching
 *  `StationlyFormatters.formatDestination`. */
export function formatDestination(name: string): string {
    const clean = name
        .replace(' Underground Station', '')
        .replace(' DLR Station', '')
        .replace(' Rail Station', '')
        .trim();
    return clean.length > 25 ? `${clean.slice(0, 22)}...` : clean;
}

/**
 * The café-board version: everything above, plus the two suffixes TfL leaves on
 * a destination that the phone keeps and a wall does not want.
 *
 * "Richmond (London) Rail" is correct and it is what the app shows, but on a
 * screen read from six metres away those eleven extra characters are the
 * difference between a destination you take in at a glance and one you read.
 * They also lengthen the split-flap ripple, which is timed per character.
 *
 * A DELIBERATE divergence from `StationlyFormatters.formatDestination`, and the
 * only one - everything else on this board is the phone's rule verbatim.
 * `(London)` is a disambiguator for a national rail network the café is
 * standing in the middle of, and the trailing "Rail" says a mode the whole
 * board is already about.
 */
export function formatDestinationShort(name: string): string {
    const clean = formatDestination(name)
        .replace(/\s*\(London\)\s*/g, ' ')
        .replace(/\s+Rail$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Never return an empty destination: if the suffixes were the whole name,
    // the full one is more use than nothing.
    return clean || formatDestination(name);
}
