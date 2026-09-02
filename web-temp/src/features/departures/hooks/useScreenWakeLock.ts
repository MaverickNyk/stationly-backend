import { useEffect } from 'react';

/**
 * Keeps the screen awake for as long as the board is on it.
 *
 * ## Why a wall display needs this at all
 * Every TV stick treats "no remote input" as "nobody is here". A Fire TV shows
 * its photo screensaver after a few minutes and sleeps the device after about
 * twenty - and a board nobody touches is precisely that condition. Left alone,
 * the café's departure board disappears behind holiday photos within five
 * minutes of being set up, which reads as our bug rather than the TV's setting.
 *
 * `navigator.wakeLock` is the correct answer to that, and it is the only one a
 * web page has: it asks the platform to keep the display on while this page is
 * visible.
 *
 * ## What it does NOT do, and why the setup step still exists
 * A wake lock holds the DEVICE awake. It does not override a system-level
 * screensaver on every platform, and on Fire OS in particular the screensaver
 * is a launcher setting we cannot reach from a page. So this narrows the
 * problem rather than removing it: the stick will not sleep, but the
 * screensaver timer must still be turned off once, by hand, on the TV. That
 * step belongs in the setup notes, not in a comment nobody reads - see
 * CAFE_KIOSK_DISPLAY.md §7.5.
 *
 * ## Three things the API makes you handle
 *  - **It is not everywhere.** Older Fire OS Silk builds have no `wakeLock` at
 *    all. Absence is normal, not an error, so it degrades silently.
 *  - **The request rejects unless the page is visible**, so it is attempted on
 *    mount and again whenever the page becomes visible.
 *  - **The lock is released for us** when the page is hidden or the device
 *    sleeps anyway, and is NOT re-acquired automatically. A TV that is switched
 *    to another input and back would come back without one, so the
 *    visibility listener is what makes this survive the day rather than the
 *    first hour.
 */
export function useScreenWakeLock(): void {
    useEffect(() => {
        // Not in every lib.dom, and absent entirely on older TV browsers.
        const nav = navigator as Navigator & {
            wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> };
        };
        if (!nav.wakeLock) return;

        let lock: WakeLockLike | null = null;
        let unmounted = false;

        const acquire = async () => {
            if (unmounted || lock || document.visibilityState !== 'visible') return;
            try {
                const next = await nav.wakeLock!.request('screen');
                // The effect can tear down while the request is in flight.
                if (unmounted) {
                    void next.release().catch(() => {});
                    return;
                }
                lock = next;
                // The platform drops the lock on its own terms; forget ours so
                // the next visibility change asks for a fresh one.
                next.addEventListener?.('release', () => {
                    if (lock === next) lock = null;
                });
            } catch {
                /* Denied, unsupported, or the page lost visibility mid-request.
                   The board is not worth failing over a screensaver. */
            }
        };

        const onVisibility = () => {
            if (document.visibilityState === 'visible') void acquire();
            else lock = null; // released for us; do not hold a stale handle
        };

        void acquire();
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            unmounted = true;
            document.removeEventListener('visibilitychange', onVisibility);
            void lock?.release().catch(() => {});
            lock = null;
        };
    }, []);
}

/** The slice of `WakeLockSentinel` we use. Declared locally because the real
 *  type is missing from the DOM lib on some TypeScript/lib.dom combinations,
 *  and this folder must build on its own. */
interface WakeLockLike {
    release(): Promise<void>;
    addEventListener?(type: 'release', listener: () => void): void;
}
