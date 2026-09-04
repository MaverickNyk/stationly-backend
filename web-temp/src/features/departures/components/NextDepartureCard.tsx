import type { DepartureRow } from '../logic/board';
import { SplitFlap } from './SplitFlap';

/**
 * The hero - one card per platform.
 *
 *   Platform 1  [Mildmay]        ← pinned top-left: where, and on what
 *   Richmond              6 min  ← the destination, and when
 *
 * The ratio is the whole design: the ETA is only slightly larger than the
 * destination, not the twice-the-size number it was. A card at the top of a
 * board is a summary, not a countdown clock - the countdown is the board
 * underneath it, and a hero shouting a number competed with it.
 *
 * Rules kept from the app:
 *  - **Fixed height in EVERY state**, including "no departures", so content
 *    changing animates the text and nothing else. A departure board must not
 *    move.
 *  - **"Due" and "1 min" take the brand amber; nothing takes red.** Red on an
 *    arrival reads as "something is wrong" rather than "your train is here",
 *    and there is no pulse - that read as stressful from across a room.
 *  - A disrupted line with nothing to show names its SEVERITY where the
 *    destination goes, rather than a bare "no departures" that would read as
 *    our bug rather than the closure it is.
 */
export function NextDepartureCard({
    platform,
    row,
    lineColor,
    emptyHeadline,
}: {
    platform: string;
    row?: DepartureRow;
    lineColor: string;
    emptyHeadline: string;
}) {
    // Read the NUMBER the row carries, never the label. Parsing " min" back off
    // the string turned an uncomputable ETA (label "") into Number("") === 0,
    // which then read as `urgent` and rendered a confident amber "0 min" for a
    // train whose time we do not actually know.
    const isDue = row?.isDue ?? false;
    const minutes = row?.etaMinutes ?? null;
    const urgent = isDue || minutes === 1;

    return (
        <article
            className={`hero ${urgent ? 'hero--urgent' : ''} ${!row ? 'hero--empty' : ''}`}
            style={{ ['--line-color' as string]: lineColor }}
        >
            {/* iOS-style vertical line accent bar */}
            <div className="hero__accent" aria-hidden="true" />

            <div className="hero__content">
                <header className="hero__top">
                    <div className="hero__badge-group">
                        <span className="hero__live-dot" aria-hidden="true" />
                        <span className="hero__platform">{platform || 'Next departure'}</span>
                    </div>
                </header>

                <div className="hero__body">
                    <div className="hero__dest-wrapper">
                        <span className="hero__arrow" aria-hidden="true">→</span>
                        <span className="hero__dest">
                            <SplitFlap text={row ? row.destination : emptyHeadline} />
                        </span>
                    </div>
                </div>
            </div>

            {/* Full-height ETA Box on the right */}
            <div className={`hero__eta-box ${urgent ? 'hero__eta-box--urgent' : ''}`}>
                {row ? (
                    isDue ? (
                        <div className="hero__eta-stack">
                            <span className="hero__eta-val hero__eta-val--due">
                                <SplitFlap text="Due" />
                            </span>
                        </div>
                    ) : (
                        <div className="hero__eta-stack">
                            <span className="hero__eta-val">
                                <SplitFlap text={minutes === null ? row.eta : String(minutes)} />
                            </span>
                            {minutes !== null && <span className="hero__eta-unit">min</span>}
                        </div>
                    )
                ) : (
                    <span className="hero__eta-val hero__eta-val--empty">-</span>
                )}
            </div>
        </article>
    );
}
