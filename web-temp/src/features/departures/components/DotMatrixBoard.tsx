import type { LineStatus } from '../../../api/types';
import type { PlatformGroup } from '../logic/board';
import type { FallbackCopy } from '../logic/fallback';
import { useRowTransition } from '../hooks/useRowTransition';
import { SplitFlap } from './SplitFlap';
import { StatusMarquee } from './StatusMarquee';
import { BoardFooter } from './BoardFooter';

/**
 * The dot-matrix panel - the whole screen's content, on a café wall.
 *
 * The look is the PANEL, not the typeface: near-black ground, amber text, and a
 * faint unlit-dot grid behind every row so each departure reads as its own lit
 * cell. A real dot-matrix font was tried on the apps and reverted; the live rule
 * is one system face everywhere (`BOARD_DOTMATRIX_FONT.md`).
 *
 * The grid is one repeating background-image per row, never a dot per element -
 * the Compose port found out what a draw-per-dot costs (~800 calls for a single
 * row, and this board is on screen for twelve hours at a stretch).
 *
 * The panel's order is the app's: departures, then ONE status strip, then the
 * clock footer. The strip is pinned between the two rather than living with the
 * rows, and that placement is load-bearing - a marquee animates every frame, and
 * inside a scrolling row list it kept the whole subtree dirty and repainted
 * every departure at 60fps (BOARD_AND_DREAM_UI.md §7).
 */
export function DotMatrixBoard({
    groups,
    fallback,
    statuses,
    rowsPerPlatform,
}: {
    groups: PlatformGroup[];
    fallback: FallbackCopy | null;
    statuses: LineStatus[];
    /** From `?rows=`. The board pads every block out to this many rows, so this
     *  is what the slot arithmetic below has to count - not a hardcoded 3. */
    rowsPerPlatform: number;
}) {
    // How many line-slots the panel must hold: one per platform header, one per
    // departure, plus the status strip and the clock. The stylesheet divides the
    // panel's height by this to size the type, which is what guarantees three
    // departures per platform fit on ANY screen - the board never drops a row to
    // make room, it just sets itself in a size that fits.
    //
    // It counts the PADDED row count, not the live one. Counting only the rows
    // that exist meant a platform with one departure was measured as two slots
    // while it drew four, so the type was sized for a shorter board than the
    // one on screen and the block overflowed its panel.
    const slots =
        groups.reduce((n, g) => n + 1 + Math.max(g.rows.length, rowsPerPlatform), 0) +
        (statuses.length > 0 ? 1 : 0);

    return (
        <section className="panel" style={{ ['--slots' as string]: Math.max(slots, 6) }}>
            {fallback ? (
                <div className="fallback">
                    <div className="fallback__title">{fallback.title}</div>
                    {fallback.detailLines.map(line => (
                        <div className="fallback__detail" key={line}>{line}</div>
                    ))}
                </div>
            ) : (
                <div className="panel__body">
                    {groups.map(group => (
                        <PlatformBlock
                            key={group.platform}
                            group={group}
                            rowsPerPlatform={rowsPerPlatform}
                        />
                    ))}
                </div>
            )}

            {/* Both stay put in the fallback state. A board with nothing to show
                still knows what time it is and when it last heard anything -
                which is exactly when a viewer most wants to know. */}
            <StatusMarquee statuses={statuses} />
            <BoardFooter />
        </section>
    );
}

/**
 * One platform's header and rows. A component rather than a loop body because
 * the row transition is per-group state - a train leaving Platform 1 must not
 * make Platform 2's rows animate.
 */
function PlatformBlock({
    group,
    rowsPerPlatform,
}: {
    group: PlatformGroup;
    rowsPerPlatform: number;
}) {
    const rows = useRowTransition(group.rows);
    const emptyCount = Math.max(0, rowsPerPlatform - rows.length);

    return (
        <div className="panel__group">
            {/* The header flips too: a station reshuffling its platforms mid-day
                is exactly the change a waiting passenger must not miss. */}
            <div className="panel__header">
                <SplitFlap text={group.header} />
            </div>

            {/* Keyed by the TRAIN, not the slot index. `useRowTransition` exists
                to mark which rows are new, and an index key threw that away: as
                a departed train left the top, every row below it shifted up one
                index, so React reused the node and the entry animation landed
                on whichever row happened to be last rather than the one that
                actually arrived. */}
            {rows.map(({ row, key, phase }) => (
                <div
                    key={key}
                    className={phase === 'settled' ? 'panel__row' : `panel__row panel__row--${phase}`}
                >
                    <span className="panel__dest">
                        <SplitFlap text={row.destination} />
                    </span>
                    <span className="panel__eta">
                        <SplitFlap text={row.eta} />
                    </span>
                </div>
            ))}

            {Array.from({ length: emptyCount }).map((_, idx) => (
                <div key={`empty-slot-${idx}`} className="panel__row panel__row--empty">
                    <span className="panel__dest">&nbsp;</span>
                    <span className="panel__eta">&nbsp;</span>
                </div>
            ))}
        </div>
    );
}
