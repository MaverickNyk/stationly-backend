import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Tiny fullscreen toggle. Uses the browser Fullscreen API.
 * Esc exits automatically (browser-native behaviour).
 */
export function FullscreenButton() {
    const [isFs, setIsFs] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);

    // Focused on arrival so a Fire TV remote goes fullscreen with one press of
    // OK — but with `preventScroll`, which the JSX `autoFocus` prop cannot pass.
    //
    // This button is the LAST child of `.kiosk`, and `.kiosk` is a fixed
    // `100dvh` box with `overflow: hidden`. Where the content does not fit (the
    // clamp() floors bind on a short window), a plain focus scrolls the button
    // into view — scrolling a container that has no scrollbar, so the header and
    // hero cards silently vanish off the TOP with nothing on screen to explain
    // it. The board must never scroll; if something does not fit, it is clipped
    // from the bottom where the layout intends.
    useEffect(() => {
        btnRef.current?.focus({ preventScroll: true });
    }, []);

    useEffect(() => {
        const onChange = () => setIsFs(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const toggle = useCallback(() => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.documentElement.requestFullscreen();
        }
    }, []);

    return (
        <button
            className="fs-btn"
            ref={btnRef}
            onClick={toggle}
            title={isFs ? 'Exit fullscreen' : 'Go fullscreen'}
            aria-label={isFs ? 'Exit fullscreen' : 'Go fullscreen'}
        >
            {isFs ? '⤓' : '⤢'}
        </button>
    );
}
