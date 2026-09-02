/**
 * The ONE status strip, ported from `core/.../util/LineStatusRanker.kt` and
 * `StationlyFormatters.formatStatusReason`.
 *
 * A board gets one strip, not one per line. Worst first, then rotate every 8s so
 * nothing is hidden. "Good Service" never takes a rotation slot - it shows only
 * when every line is healthy, once, for the whole board, because saying
 * "Good Service" three times says nothing three times.
 */

import type { LineStatus } from '../../../api/types';

/** Worst first. Mirrors TfL's own `statusSeverity` ordering rather than an
 *  invented one, so our idea of "worse" matches the source's. */
const SEVERITY_ORDER = [
    'closed', 'suspended', 'part suspended', 'planned closure', 'part closure',
    'part closed', 'severe delays', 'service closed', 'not running',
    'reduced service', 'bus service', 'diverted', 'minor delays',
    'change of frequency', 'special service', 'exit only',
    'no step free access', 'issues reported', 'information',
];

/** An unrecognised severity sorts BELOW known disruptions but ABOVE Good
 *  Service: new TfL wording is far more likely to be a new disruption than a
 *  new way of being fine, and burying it is the worse failure. */
const UNKNOWN_RANK = 1_000;
const GOOD_RANK = 2_000;

const GOOD_SEVERITIES = new Set(['good service', 'no issues']);

export type Tone = 'green' | 'amber' | 'red';

/** Red is reserved for "you cannot travel on this line right now". Delays and
 *  reduced service still mean a train is coming, so they are amber - a
 *  passenger who sees red should change their plan, not just expect to wait. */
const RED_SEVERITIES = new Set([
    'closed', 'suspended', 'part suspended', 'planned closure',
    'part closure', 'part closed', 'service closed', 'not running',
]);

export function isGoodService(severity: string | undefined): boolean {
    return GOOD_SEVERITIES.has((severity ?? '').trim().toLowerCase());
}

export function rankOf(severity: string | undefined): number {
    const s = (severity ?? '').trim().toLowerCase();
    if (!s || isGoodService(s)) return GOOD_RANK;
    const i = SEVERITY_ORDER.indexOf(s);
    return i >= 0 ? i : UNKNOWN_RANK;
}

export function toneOf(severity: string | undefined): Tone {
    const s = (severity ?? '').trim().toLowerCase();
    if (!s || isGoodService(s)) return 'green';
    return RED_SEVERITIES.has(s) ? 'red' : 'amber';
}

/** Trim TfL's boilerplate: drop the "Circle Line:" prefix it repeats inside the
 *  reason, and keep at most the first two sentences. */
export function formatStatusReason(reason: string | undefined): string {
    if (!reason || !reason.trim()) return '';
    let text = reason.includes(':') ? reason.slice(reason.indexOf(':') + 1).trim() : reason.trim();
    if (!text) return '';

    const firstDot = text.indexOf('.');
    if (firstDot !== -1) {
        const secondDot = text.indexOf('.', firstDot + 1);
        text = secondDot !== -1 ? text.slice(0, secondDot + 1) : text.slice(0, firstDot + 1);
    }
    return text.trim();
}

export interface StatusEntry {
    /** Blank when this entry speaks for the whole board (the all-good case). */
    lineLabel: string;
    severity: string;
    reason: string;
    tone: Tone;
}

/**
 * What to rotate through. Disrupted lines only, de-duplicated on
 * (severity, reason) with the line labels joined - sub-surface lines share
 * track, so "Circle, District  Minor Delays" is one fact, not three.
 */
export function rotation(statuses: LineStatus[]): StatusEntry[] {
    if (statuses.length === 0) return [];

    const disrupted = statuses.filter(s => !isGoodService(s.statusSeverityDescription));

    if (disrupted.length === 0) {
        // Everything is fine - say so once, for the board rather than per line.
        // Carry the reason: TfL does ship a description alongside Good Service
        // often enough, and dropping it leaves two bare words and a dead
        // marquee on the most common state the board is ever in. Whichever
        // healthy line actually has something to say speaks for the board.
        const spoken = statuses.find(s => (s.reason ?? '').trim()) ?? statuses[0];
        return [{
            lineLabel: '',
            severity: spoken.statusSeverityDescription,
            reason: formatStatusReason(spoken.reason),
            tone: 'green',
        }];
    }

    const merged = new Map<string, StatusEntry & { labels: string[] }>();
    for (const s of disrupted) {
        const reason = formatStatusReason(s.reason);
        const key = `${s.statusSeverityDescription.trim().toLowerCase()}|${reason.toLowerCase()}`;
        const existing = merged.get(key);
        if (existing) {
            if (!existing.labels.includes(s.name)) existing.labels.push(s.name);
        } else {
            merged.set(key, {
                lineLabel: s.name,
                severity: s.statusSeverityDescription,
                reason,
                tone: toneOf(s.statusSeverityDescription),
                labels: [s.name],
            });
        }
    }

    return [...merged.values()]
        .map(({ labels, ...entry }) => ({ ...entry, lineLabel: labels.join(', ') }))
        .sort((a, b) => rankOf(a.severity) - rankOf(b.severity));
}

/** Severity label for the status strip: e.g. "Good Service:" or "Minor Delays:" */
export function statusLabel(entry: StatusEntry): string {
    const rawSev = (entry.severity || '').replace(/:+$/, '').trim();
    return `${rawSev}:`;
}

export const STATUS_ROTATION_MS = 8_000;
