/**
 * What the board says when it has no departures to show.
 *
 * Ported from `core/.../util/BoardFallback.kt`. An empty board is a CLAIM -
 * "no trains here" - and at 03:00 that claim is indistinguishable from a broken
 * screen. Every branch below exists so the board says the true reason instead.
 *
 * Kept in the same order as the Kotlin, including the ordering fix noted on the
 * closed-network windows: they are tested BEFORE staleness, because after the
 * last train there is nothing to fetch, and reporting that correct silence as
 * "Live updates paused · Last refresh 5h ago" makes the board blame itself for
 * behaving correctly.
 */

export type FallbackKind =
    | 'offline'
    | 'signal_lost'
    | 'disrupted'
    | 'late_night'
    | 'early_morning'
    | 'no_upcoming'
    | 'connecting';

export interface FallbackState {
    kind: FallbackKind;
    ageMinutes: number;
    statusSeverity?: string;
    statusReason?: string;
}

/** Minutes since the last successful fetch before the board admits it is stale. */
const SIGNAL_LOST_MIN = 6;
/** Europe/London, in minutes past midnight. */
const LATE_NIGHT_START = 0;
const LATE_NIGHT_END = 4 * 60 + 30;
const EARLY_MORNING_END = 6 * 60;

export interface FallbackInput {
    hasPredictions: boolean;
    isOnline: boolean;
    /** Wall-clock millis of the last successful fetch; 0 = never. */
    lastUpdatedMs: number;
    nowMs: number;
    /** Minutes past midnight, Europe/London. */
    londonMinutes: number;
    statusSeverity?: string;
    statusReason?: string;
}

export function computeFallback(input: FallbackInput): FallbackState | null {
    if (input.hasPredictions) return null;
    if (!input.isOnline) return { kind: 'offline', ageMinutes: 0 };

    // A non-good-service status is almost certainly WHY there are no
    // predictions, so it wins over the time-of-day buckets - an all-day closure
    // is more specific than "service ended".
    const severity = (input.statusSeverity ?? '').trim();
    if (severity && !severity.toLowerCase().startsWith('good service')) {
        return {
            kind: 'disrupted',
            ageMinutes: 0,
            statusSeverity: severity,
            statusReason: (input.statusReason ?? '').trim() || undefined,
        };
    }

    const m = input.londonMinutes;
    if (m >= LATE_NIGHT_START && m < LATE_NIGHT_END) return { kind: 'late_night', ageMinutes: 0 };
    if (m >= LATE_NIGHT_END && m < EARLY_MORNING_END) return { kind: 'early_morning', ageMinutes: 0 };

    // Only claim staleness when we actually KNOW the age. Never synced (0) can't
    // honestly say "Last refresh N min ago" - fall through to no_upcoming.
    if (input.lastUpdatedMs > 0) {
        const ageMinutes = Math.max(0, Math.floor((input.nowMs - input.lastUpdatedMs) / 60_000));
        if (ageMinutes >= SIGNAL_LOST_MIN) return { kind: 'signal_lost', ageMinutes };
    }

    return { kind: 'no_upcoming', ageMinutes: 0 };
}

export interface FallbackCopy {
    title: string;
    detailLines: string[];
}

export function fallbackCopy(state: FallbackState): FallbackCopy {
    switch (state.kind) {
        case 'offline':
            return { title: 'Offline', detailLines: ["Catching up when you're back"] };
        case 'signal_lost':
            return { title: 'Live updates paused', detailLines: [`Last refresh ${formatAge(state.ageMinutes)} ago`] };
        case 'late_night':
            return { title: 'Service ended for tonight', detailLines: ['Back in the morning'] };
        case 'early_morning':
            return { title: 'Service starting soon', detailLines: ['First departures incoming'] };
        case 'no_upcoming':
            return { title: 'Nothing departing right now', detailLines: ['Watching for the next one'] };
        case 'connecting':
            return { title: 'Connecting', detailLines: ['Live data starting up'] };
        case 'disrupted':
            // The title is the live TfL severity - the "what". The detail points
            // at the fuller reason, which the status strip also carries.
            return {
                title: state.statusSeverity || 'Service disrupted',
                detailLines: state.statusReason
                    ? [state.statusReason]
                    : ['No departures expected here', "We'll update as things change"],
            };
    }
}

function formatAge(minutes: number): string {
    if (minutes < 1) return 'a moment';
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
}
