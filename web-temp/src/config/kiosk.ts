/**
 * What one café display shows.
 *
 * The station is a PATH segment - `/kiosk/910GHACKNYW` - so a screen is
 * repointed at another station by editing the URL on the TV, and so the URL
 * itself says which board it is. Everything else is a query parameter. One
 * build serves every venue; a change needs no redeploy, because the café owner
 * is handed a URL, not a release.
 *
 *   /kiosk/910GHACKNYW?venue=Bloom%20Coffee&message=Free%20refills%20before%2010
 */

export interface KioskConfig {
    /** Shown top-right beside the station name. Blank hides it entirely. */
    venue: string;
    /** The café's own message panel. Blank hides the panel. */
    message: string;
    /** Departures shown per platform block. Three: enough to answer "and if I
     *  miss it?", few enough that every row can be large. The rows flex to fill
     *  the panel, so this is what sets their size too. */
    rowsPerPlatform: number;
    /** Platform BLOCKS on the dot-matrix board. */
    maxPlatforms: number;
    /** Hero CARDS above the board. Separate from `maxPlatforms` on purpose: the
     *  board can list four platforms while the hero row still wants two, and
     *  more than two cards get too narrow to read from across a room - which is
     *  the only distance that matters here. */
    maxHeroCards: number;
    qrCaption: string;
    /**
     * Extra edge padding, as a percentage of the screen, for a TV that crops.
     *
     * Overscan is a television problem we cannot detect from a page: some sets
     * throw away the outer few percent of the picture, which on this board eats
     * the pinned timestamp and the fullscreen button before it eats anything
     * else. It is a URL parameter rather than a fixed margin because it is
     * per-television - and because the alternative to a parameter is a redeploy
     * to fix one café's screen, which is the thing the URL-provisioning design
     * exists to avoid.
     *
     * `?overscan=3` is the usual starting point on a set that crops.
     */
    overscanPercent: number;
}

/** Where `/kiosk` with no station sends you. The trial café's station. */
export const DEFAULT_STATION = '910GHACKNYW';

const DEFAULTS: KioskConfig = {
    venue: '',
    message: '',
    rowsPerPlatform: 3,
    maxPlatforms: 4,
    maxHeroCards: 2,
    overscanPercent: 0,
    // Empty by default: the mark and the name say who we are, and a QR on a
    // wall needs no instructions. `?qr=` is still there for a venue that
    // wants a line of its own.
    qrCaption: "",
};

export function readKioskConfig(search: string): KioskConfig {
    const q = new URLSearchParams(search);
    const str = (key: string, fallback: string) => (q.get(key) ?? fallback).trim();
    const num = (key: string, fallback: number) => {
        const n = Number(q.get(key));
        return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    return {
        venue: str('venue', DEFAULTS.venue),
        message: str('message', DEFAULTS.message),
        rowsPerPlatform: num('rows', DEFAULTS.rowsPerPlatform),
        maxPlatforms: num('platforms', DEFAULTS.maxPlatforms),
        maxHeroCards: num('cards', DEFAULTS.maxHeroCards),
        qrCaption: str('qr', DEFAULTS.qrCaption),
        // Clamped: a typo'd `?overscan=50` should not shrink the board to
        // nothing on a screen nobody can reach to fix it.
        overscanPercent: Math.min(num('overscan', DEFAULTS.overscanPercent), 10),
    };
}

/**
 * A NaptanId is `[0-9]{3}[A-Z]...` - validated before it reaches the API so a
 * typo'd or hostile path segment is rejected here rather than becoming an
 * upstream lookup. The BFF validates independently; this is the display's own
 * guard so it can show a real message instead of an error.
 */
export function isValidNaptan(id: string | undefined): id is string {
    return !!id && /^[0-9]{3}[A-Za-z0-9]{3,20}$/.test(id);
}
