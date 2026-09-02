/**
 * The ONE TfL colour palette, and the four shapes the clients read it in.
 *
 * ## The problem this closes
 * The same hex values existed in four places, none of them authoritative:
 *
 *  1. `core/util/TflLineColors.kt` — the brand palette, read by Android's
 *     notification chip.
 *  2. `Board.kt`'s `TFL_LINE_COLORS` plus two per-theme override maps — what the
 *     iOS board actually renders.
 *  3. `WidgetTheme.swift`'s `modeColor` — what the widget renders.
 *  4. `lineIconService.ts` in this repo — what server-rendered icons use.
 *
 * `TflLineColors.kt` carries the instruction "update BOTH files in the same
 * commit", written when there were two. There are four.
 *
 * ## What a three-way diff actually showed
 * Twenty of twenty-one lines agreed. The interesting part is the one that did
 * not, because it is NOT drift:
 *
 *   northern    brand #000000    iOS board #888888
 *
 * Pure black is the correct brand colour and it is invisible on a near-black
 * departure board. Two surfaces genuinely want different answers, which is why
 * this is a brand palette PLUS per-theme legibility overrides rather than one
 * flat map. Collapsing them to a single value would have to be wrong somewhere.
 *
 * ## Wire shape
 * Flat keys in `home-config` rather than a bucket in `theme-tokens`, which is
 * where a palette semantically belongs. The reason is plumbing that already
 * exists and is proven: home-config is fetched on launch, cached for offline and
 * cold start, and republished into the iOS App Group by `publishFallbackCopy` —
 * which is the only way the widget, a process that never makes a network call,
 * can see any of this. theme-tokens has none of that path.
 */

export type LinePaletteBucket = 'base' | 'dark' | 'light' | 'mode';

export class LinePaletteService {
    /**
     * TfL's published brand colours, keyed by the line id the API returns.
     *
     * The same values as {lineIconService}'s table — that one owns icon
     * RENDERING and this one owns what the clients paint with. Verified equal
     * by `npm test`.
     */
    private static readonly BRAND: Record<string, string> = {
        bakerloo: '#B36305',
        central: '#E32017',
        circle: '#FFD300',
        district: '#00782A',
        'hammersmith-city': '#F3A9BB',
        jubilee: '#A0A5A9',
        metropolitan: '#9B0056',
        northern: '#000000',
        piccadilly: '#003688',
        victoria: '#0098D4',
        'waterloo-city': '#95CDBA',
        dlr: '#00A4A7',
        elizabeth: '#6950A1',
        lioness: '#E2A12B',
        mildmay: '#1A6DB4',
        windrush: '#E2231A',
        weaver: '#7B2D8B',
        suffragette: '#00843D',
        liberty: '#6B717E',
        tram: '#84B817',
        'cable-car': '#E21836',
    };

    /**
     * Overrides for a DARK surface, where several brand colours go muddy or
     * vanish. Only the lines that need one appear here; everything else falls
     * through to {BRAND}.
     *
     * `northern` is the load-bearing entry: brand black on a near-black board is
     * an invisible line pill.
     */
    private static readonly DARK: Record<string, string> = {
        northern: '#888888',
        piccadilly: '#3B7AE0',
        suffragette: '#1FB54E',
        metropolitan: '#D14990',
        weaver: '#B069BE',
        mildmay: '#4C95D8',
        district: '#2BB55D',
        bakerloo: '#D17F2A',
        elizabeth: '#9482D0',
    };

    /** Overrides for a LIGHT surface — the greys, which wash out on white. */
    private static readonly LIGHT: Record<string, string> = {
        northern: '#6E6A66',
        jubilee: '#7A7E83',
        liberty: '#5A6068',
    };

    /**
     * Roundel tint per transport MODE, for surfaces that show a station rather
     * than a line — the board's station strip and every widget family.
     *
     * `tube` and `bus` share TfL's corporate red, which is also the fallback for
     * a mode nobody has mapped.
     */
    private static readonly MODES: Record<string, string> = {
        tube: '#DC241F',
        underground: '#DC241F',
        bus: '#DC241F',
        dlr: '#00A4A7',
        overground: '#EE7C0E',
        elizabeth: '#6950A1',
        'elizabeth-line': '#6950A1',
        tram: '#84B817',
    };

    /** The fallback tint when a mode is unknown. Served so it is tunable too. */
    private static readonly MODE_DEFAULT = '#DC241F';

    static brand(): Record<string, string> { return { ...this.BRAND }; }
    static modes(): Record<string, string> { return { ...this.MODES }; }

    /** Every wire form, ready to spread into `getHomeConfig().strings`. */
    static homeConfigKeys(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [id, hex] of Object.entries(this.BRAND))  out[`line.color.${id}`] = hex;
        for (const [id, hex] of Object.entries(this.DARK))   out[`line.color.dark.${id}`] = hex;
        for (const [id, hex] of Object.entries(this.LIGHT))  out[`line.color.light.${id}`] = hex;
        for (const [id, hex] of Object.entries(this.MODES))  out[`mode.color.${id}`] = hex;
        out['mode.color.default'] = this.MODE_DEFAULT;
        return out;
    }
}
