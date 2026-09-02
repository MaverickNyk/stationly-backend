import { useEffect, useRef, useState } from 'react';
import type { DepartureRow } from '../logic/board';

/**
 * Row-level entry/exit, ported from the iOS widget's `refreshFlip`
 * (`iosApp/StationlyWidget/WidgetViews.swift`).
 *
 * ## Direction encodes cause, and that is the whole point
 * The widget learned this on device: a horizontal push and a quiet opacity
 * fade were indistinguishable, so a data refresh looked like a page move that
 * had gone somewhere unexpected. The rule that replaced it is physical, and a
 * viewer learns it without being told:
 *
 *   - **Vertical = the world moved.** New times arrived; rows fall into place
 *     from above and the old ones drop away beneath them.
 *   - Horizontal would mean "you moved" - there is no paging on a café wall,
 *     so nothing here moves horizontally at all.
 *
 * ## It does not contradict "an LED panel does not scroll"
 * A dot-matrix panel changes its lamps rather than scrolling, and that holds
 * for the ambient minute tick - which is exactly why the tick gets the
 * character-level flap and NOT this. But a train departing is the board being
 * re-set, and every real one on a concourse does that by turning its rows over.
 *
 * So: a row that appears because new data landed falls in. A label that merely
 * counted down does not - it flips its digits in place, and this hook never
 * sees it, because the row's identity did not change.
 */

export type RowPhase = 'settled' | 'entering';

export interface TransitioningRow {
    row: DepartureRow;
    key: string;
    phase: RowPhase;
}

/** Matches the immersion animation duration in board.css. */
const IMMERSE_MS = 750;

/** A train's identity on the board. Not the ETA - that changes every minute
 *  and would make every row look new once a minute. */
export function rowKey(row: DepartureRow): string {
    return `${row.platform}|${row.targetMs ?? row.destination}`;
}

export function useRowTransition(rows: DepartureRow[]): TransitioningRow[] {
    const [rendered, setRendered] = useState<TransitioningRow[]>([]);
    const isFirst = useRef(true);
    const prevKeysRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        const prevKeys = prevKeysRef.current;

        let anyEntering = false;
        const next: TransitioningRow[] = rows.map(row => {
            const key = rowKey(row);
            const isNew = !isFirst.current && !prevKeys.has(key);
            if (isNew) anyEntering = true;
            return { row, key, phase: isNew ? 'entering' : 'settled' };
        });

        prevKeysRef.current = new Set(next.map(r => r.key));
        isFirst.current = false;

        setRendered(next);

        // Nothing entered - which is the case on every one of the fifty-nine
        // minute ticks between data changes - so there is no settle to schedule.
        // A single shared timer, rather than the array that was accumulated and
        // discarded on every render.
        if (!anyEntering) return;

        const t = window.setTimeout(() => {
            setRendered(prev =>
                prev.some(r => r.phase !== 'settled')
                    ? prev.map(r => (r.phase === 'settled' ? r : { ...r, phase: 'settled' }))
                    : prev,
            );
        }, IMMERSE_MS);

        return () => window.clearTimeout(t);
    }, [rows]);

    return rendered;
}
