import { memo, useEffect, useRef, useState } from 'react';

/**
 * Per-character split-flap text, ported from `SplitFlapText` / `FlapRow` in
 * `composeApp/.../ui/summary/components/Board.kt`.
 *
 * The three numbers below are the app's, not new ones - a board on a café wall
 * and a board in the user's pocket flipping at different speeds would read as
 * two different products.
 *
 * Three rules carried over verbatim, each of which was a decision:
 *
 *  - **The stagger is the whole effect.** Characters flip in sequence so the
 *    eye follows a ripple across the word, the way a mechanical board resets.
 *    A crossfade of the whole string reads as a screen redrawing itself.
 *  - **Unchanged characters do not animate.** "Edgware Road" → "Edgware Town"
 *    flips the four that differ and leaves the rest still. Cheaper, and truer
 *    to the real thing.
 *  - **Clipping IS the effect, not a limitation.** A real split-flap character
 *    appears from behind its housing. With the cell unclipped the incoming and
 *    outgoing glyphs draw over the rows above and below, which is what makes a
 *    flip look like a smear.
 *
 * Only the TRANSITION animates. Nothing runs while the board sits still, which
 * is what makes it safe to leave on a screen for twelve hours.
 */

const FLIP_STAGGER_MS = 50;
const FLIP_DURATION_MS = 800;
const FLIP_OUT_DURATION_MS = 400;

/**
 * Memoised, and so is every cell.
 *
 * The board re-renders on the minute tick, and without this each tick walked
 * every character of every destination on screen - a few hundred components -
 * to produce identical output for all but the handful whose ETA actually
 * changed. The cells are pure in `char` and `index`, so React can skip them,
 * and the only work left per tick is the text that really moved.
 */
export const SplitFlap = memo(function SplitFlap({
    text,
    className,
}: {
    text: string;
    className?: string;
}) {
    const chars = [...text];
    return (
        <span className={className ? `flap ${className}` : 'flap'} aria-label={text}>
            {chars.map((char, i) => (
                // Keyed by POSITION, not by character: the cell at index 3 is a
                // physical flap that shows different letters over time. Keying
                // by the character would destroy and rebuild the cell on every
                // change, and a rebuilt cell cannot animate from its old glyph.
                <FlapCell key={i} char={char} index={i} />
            ))}
        </span>
    );
});

const FlapCell = memo(function FlapCell({ char, index }: { char: string; index: number }) {
    // `gen` increments per change so React remounts the animating spans and the
    // CSS animation actually restarts - re-applying the same class to a live
    // node does nothing.
    const [state, setState] = useState({ current: char, previous: null as string | null, gen: 0 });
    const timer = useRef<number>();

    useEffect(() => {
        setState(prev => {
            if (prev.current === char) return prev;
            return { current: char, previous: prev.current, gen: prev.gen + 1 };
        });
    }, [char]);

    useEffect(() => {
        if (state.previous === null) return;
        // Drop the outgoing glyph once it has finished leaving. Held by timer
        // rather than onAnimationEnd because a backgrounded tab never fires the
        // event, and the café TV does get backgrounded.
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(
            () => setState(prev => ({ ...prev, previous: null })),
            FLIP_OUT_DURATION_MS + index * FLIP_STAGGER_MS + 60,
        );
        return () => window.clearTimeout(timer.current);
    }, [state.gen, state.previous, index]);

    const delay = `${index * FLIP_STAGGER_MS}ms`;

    return (
        <span className="flap__cell">
            {state.previous !== null && (
                <span key={`out-${state.gen}`} className="flap__out" style={{ animationDelay: delay }}>
                    {state.previous}
                </span>
            )}
            <span
                key={`in-${state.gen}`}
                className={state.gen > 0 ? 'flap__in' : undefined}
                style={state.gen > 0 ? { animationDelay: delay } : undefined}
            >
                {state.current}
            </span>
        </span>
    );
});

export const FLAP_TIMING = { FLIP_STAGGER_MS, FLIP_DURATION_MS, FLIP_OUT_DURATION_MS };
