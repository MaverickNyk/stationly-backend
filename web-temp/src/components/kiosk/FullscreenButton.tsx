import { useState, useCallback, useEffect } from 'react';

/**
 * Tiny fullscreen toggle. Uses the browser Fullscreen API.
 * Esc exits automatically (browser-native behaviour).
 */
export function FullscreenButton() {
    const [isFs, setIsFs] = useState(false);

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
            // The only focusable thing on the board, focused on arrival so a
            // Fire TV remote can go fullscreen with one press of OK. Without
            // it the viewer has to raise Silk's cursor and steer it, which is
            // the worst interaction on the device.
            autoFocus
            onClick={toggle}
            title={isFs ? 'Exit fullscreen' : 'Go fullscreen'}
            aria-label={isFs ? 'Exit fullscreen' : 'Go fullscreen'}
        >
            {isFs ? '⤓' : '⤢'}
        </button>
    );
}
