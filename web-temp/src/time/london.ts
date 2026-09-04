/**
 * The ONE place London wall-clock time is derived.
 *
 * A café TV out of the box is very often on the wrong timezone, so every clock
 * on this board is pinned to Europe/London regardless of what the machine
 * thinks. That rule was previously re-implemented in four places - the footer
 * clock, the minute tick, the fallback's time-of-day buckets and the nightly
 * reset - each with its own `Intl.DateTimeFormat`.
 *
 * Two reasons that mattered, beyond the duplication:
 *
 *  - `Intl.DateTimeFormat` construction is the expensive part of formatting,
 *    and two of those call sites built a fresh one on every tick - one of them
 *    every second, for twelve hours a day, on the slowest browser we support.
 *    The formatters below are built once per module load.
 *  - Four copies of "what time is it in London" is four chances to disagree,
 *    and a board whose footer says 03:29 while its nightly reset thinks it is
 *    03:31 is a bug nobody will ever reproduce.
 */

/**
 * Building a formatter with an explicit `timeZone` THROWS a RangeError where the
 * platform has no timezone database - and these are module-level constants, so
 * that throw would happen at import and take the whole bundle down. A white
 * screen on a café wall, because a TV browser shipped a trimmed ICU.
 *
 * Android WebView normally carries full ICU and this will not fire. But "the
 * board is an hour out during BST" is a far better failure than "the board does
 * not exist", and the cost of guaranteeing that is this function.
 */
function londonFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    try {
        return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'Europe/London' });
    } catch {
        console.warn('[KIOSK] No Europe/London timezone data; clocks will use device time.');
        return new Intl.DateTimeFormat('en-GB', options);
    }
}

const CLOCK = londonFormat({
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});

const HOUR_MINUTE = londonFormat({
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

export interface LondonClockParts {
    hour: string;
    minute: string;
    second: string;
}

/** Zero-padded h/m/s in London, for the blinking footer clock. */
export function londonClockParts(nowMs: number): LondonClockParts {
    const parts = CLOCK.formatToParts(new Date(nowMs));
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Minutes past midnight in London. Feeds the fallback machine's late-night and
 *  early-morning windows, and the nightly self-reset. */
export function londonMinutesOf(nowMs: number): number {
    const parts = HOUR_MINUTE.formatToParts(new Date(nowMs));
    const num = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
    return num('hour') * 60 + num('minute');
}
