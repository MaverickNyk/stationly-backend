/**
 * The branch a service takes, reduced to one comparable token.
 *
 * ## Why this exists
 * A departure's `destinationNaptanId` says where a train ENDS, not how it got
 * there. That is enough on a line that only ever splits, and it is not enough
 * the moment two branches rejoin: southbound from Camden Town, "Morden via Bank"
 * and "Morden via Charing Cross" report the SAME naptan (940GZZLUMDN), travel
 * completely different central sections, and meet again at Kennington. Nothing
 * in the id can separate them.
 *
 * TfL does separate them, in prose, in two places that we already read:
 *  - `orderedLineRoutes[].name` on the route sequence — "Edgware ↔ Morden via Bank"
 *  - `towards` on a live arrival                      — "Morden via Bank"
 *
 * This module turns both into the same token so the two can be compared. It is
 * deliberately ONE module used by both sides: a route tagged `charingcross` and
 * a prediction tagged `charing-cross` would silently never match, and the
 * failure would look exactly like "no trains on this branch".
 *
 * ## What it does NOT do
 * It never invents a discriminator. Where TfL publishes no "via" — the four
 * Metropolitan patterns to Aldgate differ only in whether they call at Willesden
 * Green — this returns null and callers must FAIL OPEN, showing the train rather
 * than guessing which branch it is on.
 */

/**
 * TfL's own abbreviations, as they appear in `towards` but not in route names.
 *
 * Keys and values are both pre-normalised. Only add an entry when the two sides
 * genuinely disagree: a token that already matches a stop name needs nothing
 * here, which is why "Newbury Park", "Woodford" and "Bank" are absent.
 */
const VIA_ALIASES: Record<string, string> = {
    // "Morden via CX" (arrival) vs "… via Charing Cross" (route name).
    cx: 'charingcross',
};

/**
 * Strip a via token down to its comparable form: letters and digits only.
 *
 * Punctuation and spacing differ freely between the two feeds ("King's Cross"
 * vs "Kings Cross"), and none of it carries meaning here.
 */
export function canonicalToken(token: string): string {
    const flat = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    return VIA_ALIASES[flat] ?? flat;
}

/**
 * The via token in a piece of TfL text, or null when there isn't one.
 *
 * Matches the trailing "via X" of a route name ("Edgware ↔ Morden via Bank") or
 * a destination string ("Morden via CX"). Anything else — "Aldgate", "Heathrow
 * T123 + 5", "Check Front of Train" — yields null, which is the honest answer:
 * those carry no branch information.
 */
export function viaKeyOf(text: string | undefined | null): string | null {
    if (!text) return null;
    const m = /\bvia\s+(.+?)\s*$/i.exec(String(text).trim());
    if (!m) return null;
    const key = canonicalToken(m[1]);
    return key.length > 0 ? key : null;
}

/**
 * The human-readable half of the same token, for labelling a branch in the UI.
 *
 * Returned verbatim apart from whitespace, so the map can say "via Charing
 * Cross" in TfL's own words rather than a re-derived guess.
 */
export function viaLabelOf(text: string | undefined | null): string | null {
    if (!text) return null;
    const m = /\bvia\s+(.+?)\s*$/i.exec(String(text).trim());
    const label = m?.[1]?.replace(/\s+/g, ' ').trim();
    return label ? label : null;
}
