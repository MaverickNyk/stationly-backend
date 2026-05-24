import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Generates and serves per-line "roundel" icons for use as the
 * notification large-icon (and anywhere else we want to brand a line
 * visually — line pills on web, etc.).
 *
 * Design rationale:
 *   - Each TfL line has a distinct brand colour. Showing that colour
 *     + line abbreviation in a notification gives instant recognition
 *     ("oh, Piccadilly is down") without the user having to read.
 *   - Bus lines DON'T have unique per-line iconography — bus 39 and
 *     bus 93 share the same TfL bus-mode icon. For buses, callers
 *     resolve to the existing `/icons/bus.png` mode icon instead.
 *
 * Implementation:
 *   - SVG generated in-memory from a template (line colour + 2-3 letter
 *     abbreviation, e.g. "PIC" / "CIR" / "VIC").
 *   - sharp renders to a 256×256 PNG (4× notification large-icon size
 *     so downscaling on the device stays crisp; the file is ~6KB).
 *   - First-time generation writes to disk under
 *     `public/icons/lines/<lineId>.png`. Subsequent requests are
 *     served by express.static — zero CPU after the first hit.
 *   - We deliberately do NOT proxy TfL's own roundel SVGs. They're
 *     redirect-laden, sometimes 404, and require attribution. Our
 *     own assets are stable, theme-friendly, and align with the
 *     amber-on-black Stationly identity.
 */

interface LineMeta {
    /** Hex `#RRGGBB`. Renders as the flat fill of the roundel disc. */
    color: string;
    /**
     * 2-3 letter line mark (e.g. "PIC" / "CIR"). Not rendered today —
     * the current design is intentionally text-free (see `roundelSvg`)
     * — but kept as metadata so a future text-overlay variant can pull
     * the canonical abbreviation from a single source.
     */
    abbr: string;
}

const LINES: Record<string, LineMeta> = {
    // London Underground
    'bakerloo':         { color: '#B36305', abbr: 'BAK' },
    'central':          { color: '#E32017', abbr: 'CEN' },
    'circle':           { color: '#FFD300', abbr: 'CIR' },
    'district':         { color: '#00782A', abbr: 'DIS' },
    'hammersmith-city': { color: '#F3A9BB', abbr: 'H&C' },
    'jubilee':          { color: '#A0A5A9', abbr: 'JUB' },
    'metropolitan':     { color: '#9B0056', abbr: 'MET' },
    'northern':         { color: '#000000', abbr: 'NOR' },
    'piccadilly':       { color: '#003688', abbr: 'PIC' },
    'victoria':         { color: '#0098D4', abbr: 'VIC' },
    'waterloo-city':    { color: '#95CDBA', abbr: 'W&C' },
    // London Overground (renamed lines, post-2024)
    'lioness':          { color: '#E2A12B', abbr: 'LIO' },
    'mildmay':          { color: '#1A6DB4', abbr: 'MIL' },
    'windrush':         { color: '#E2231A', abbr: 'WIN' },
    'weaver':           { color: '#7B2D8B', abbr: 'WEA' },
    'suffragette':      { color: '#00843D', abbr: 'SUF' },
    'liberty':          { color: '#6B717E', abbr: 'LIB' },
    // Other rail modes
    'dlr':              { color: '#00A4A7', abbr: 'DLR' },
    'elizabeth':        { color: '#6950A1', abbr: 'ELZ' },
    'tram':             { color: '#84B817', abbr: 'TRA' },
    'cable-car':        { color: '#E21836', abbr: 'CBL' },
};

const ICONS_DIR = path.join(process.cwd(), 'public', 'icons', 'lines');

/**
 * Bump this whenever the visual design of the roundels changes. Suffixed
 * to every URL as `?v=N` so Cloudflare / browser caches treat it as a
 * different resource and re-fetch. Cache-Control on the route is still
 * 30 days for fast subsequent hits, but bumping this is the kill-switch
 * for stale-design problems.
 */
export const LINE_ICON_VERSION = 3;

export class LineIconService {

    /** Public URL helper. Returns null for unknown / bus lines so the
     *  caller can fall back to mode icon. Appends a `?v=` cache-buster
     *  so design refreshes propagate past CDN caching. */
    static iconUrlFor(lineId: string | undefined, baseUrl: string): string | null {
        if (!lineId) return null;
        const key = lineId.toLowerCase();
        if (!(key in LINES)) return null;
        return `${baseUrl}/icons/lines/${key}.png?v=${LINE_ICON_VERSION}`;
    }

    /** Test whether a lineId has a generated roundel. */
    static has(lineId: string | undefined): boolean {
        return !!lineId && lineId.toLowerCase() in LINES;
    }

    /**
     * Canonical TfL brand colour for a line id (`#RRGGBB`). Single source
     * of truth — consumed by both the roundel SVG renderer here AND the
     * notification service's auto-fill of `payload.color`, so the chip
     * tint on a status-change push matches the line's roundel exactly.
     * Returns null for unknown line ids and bus routes (which share the
     * generic bus mode icon rather than a per-line colour).
     */
    static colorFor(lineId: string | undefined): string | null {
        if (!lineId) return null;
        return LINES[lineId.toLowerCase()]?.color ?? null;
    }

    /**
     * Resolve a roundel PNG buffer for the given lineId, generating it
     * on disk the first time. Returns null for lines without a defined
     * roundel (bus, unknown).
     */
    static async resolve(lineId: string): Promise<Buffer | null> {
        const key = lineId.toLowerCase();
        const meta = LINES[key];
        if (!meta) return null;

        // Ensure cache dir exists. Cheap to retry; mkdir with recursive
        // = idempotent.
        fs.mkdirSync(ICONS_DIR, { recursive: true });

        const file = path.join(ICONS_DIR, `${key}.png`);
        if (fs.existsSync(file)) {
            return fs.promises.readFile(file);
        }

        const svg = roundelSvg(meta.color);
        const png = await sharp(Buffer.from(svg))
            .resize(256, 256)
            .png({ compressionLevel: 9 })
            .toBuffer();

        // Best-effort persist. If the write fails (read-only fs, full
        // disk), we still return the buffer for this request.
        fs.promises.writeFile(file, png).catch(() => { /* swallow */ });
        return png;
    }
}

/**
 * Notification line-mark — a clean, subtle coloured disc with a single
 * thin white horizontal stripe across the middle. The stripe is the
 * iconic TfL roundel cue without the visual noise of inner-white
 * concentric shapes or text-on-bar typography that turns to mush at
 * 48dp.
 *
 * Design intent (informed by the user's "subtle, beautiful, focused
 * on the information" brief):
 *   - The notification title already carries "Piccadilly · Severe
 *     Delays" — the icon's job is line-colour BRANDING, not duplicating
 *     the line name with a "PIC" abbreviation.
 *   - The horizontal stripe is the strongest TfL signature at any size
 *     and gives the icon "transit" semantics without competing with
 *     the title for the user's attention.
 *   - No drop shadow, no text, no nested rings — every element earns
 *     its place by adding information, not decoration.
 *
 * Renders cleanly through Android's circular largeIcon mask because
 * the entire design IS already circular.
 */
function roundelSvg(color: string): string {
    // Minimum viable line icon — a flat disc in the line colour and
    // nothing else. Reason: Android's setColor() on a notification
    // doesn't reliably tint the chip on Material You devices, so the
    // line identity has to live in actual ARTWORK rather than a system
    // hint. The roundel is intentionally featureless (no stripe, no
    // text, no inner shape) so the eye reads "Piccadilly = blue"
    // without parsing detail; pairs cleanly with the Stationly small
    // icon on the other side of the chip — two icons, two purposes,
    // no competition for the user's attention.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="100" fill="${color}"/>
    </svg>`;
}
