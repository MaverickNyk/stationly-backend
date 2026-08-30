import { useEffect, useState } from 'react';

import { londonClockParts } from '../../../time/london';

/**
 * The board's clock footer, ported from `BoardFooter` in the app's `Board.kt`.
 *
 * The clock is the board's proof of life. A departure countdown only moves once
 * a minute, so for fifty-nine seconds out of sixty a still board and a frozen
 * one look identical - and a café wall is glanced at, not watched. Hence the
 * separators BLINK once a second, the way the platform clocks on the network
 * do: the smallest possible movement that says the screen is alive.
 *
 * It sits on the active-row background, like Android's TextClock on the board
 * layout, so it reads as part of the panel rather than text floating under it.
 *
 * "X ago" carries the freshness colour - amber under a minute, grey to three,
 * red past that. Anchored to when the DATA arrived, never to render time: a
 * re-render of a stale board must not reset the colour to amber. The thresholds
 * are `StaleColor`'s, shared with the home board, the dream and the widget, so a
 * glance at any of them means the same thing.
 */

export function BoardFooter() {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);

    const { hour, minute, second } = londonClockParts(now);

    return (
        <div className="boardfoot">
            <span className="boardfoot__clock">
                {hour}
                <span className="boardfoot__sep">:</span>
                {minute}
                <span className="boardfoot__sep">:</span>
                {second}
            </span>
        </div>
    );
}
