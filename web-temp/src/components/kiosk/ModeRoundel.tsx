import { modeIconUrl } from '../../config/assets';

/**
 * The station's mode roundel - the real TfL mark, not a coloured dot.
 *
 * The artwork is the backend's own, resolved by `config/icons.ts`; see that
 * file for where it lives and what changes on extraction.
 *
 * A mode with no artwork falls back to a plain coloured ring in the line's own
 * colour rather than rendering a broken image - tram and national-rail have no
 * icon in that folder today.
 */

export function ModeRoundel({ mode, lineColor }: { mode: string | undefined; lineColor: string }) {
    const src = modeIconUrl(mode);

    if (!src) {
        return <span className="roundel" style={{ ['--line-color' as string]: lineColor }} />;
    }

    return <img className="roundel-img" src={src} alt={mode} />;
}
