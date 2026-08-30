import { useEffect, useState } from 'react';

/**
 * "Now", refreshed at the next wall-clock MINUTE boundary and every minute
 * after. Ported from `rememberMinuteTick`.
 *
 * Not `setInterval(60_000)` from mount, for the two reasons the Kotlin gives:
 * mounting at 12:25:40 would make every "minute" land at :40 rather than the
 * round minute the viewer's own watch shows, and each component would drift to
 * its own offset so the big card and the rows below it would flip at different
 * moments. On a wall-mounted screen a viewer watches both at once.
 */
export function useMinuteTick(): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        let timer: number;
        const schedule = () => {
            const ms = 60_000 - (Date.now() % 60_000);
            timer = window.setTimeout(() => {
                setNow(Date.now());
                schedule();
            }, ms);
        };
        schedule();
        return () => window.clearTimeout(timer);
    }, []);

    return now;
}
