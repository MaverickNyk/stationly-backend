/**
 * The ONE TfL severity vocabulary, and the three shapes the clients read it in.
 *
 * ## The problem this closes
 * A severity has three separate jobs on a board, and each had grown its own
 * enumeration of the same list:
 *
 *  1. **Order** — which disruption a multi-line board leads with.
 *     `BoardPolicy.severityOrder`, already served.
 *  2. **Display name** — "bus service" is shown as "Replacement buses".
 *     `LineStatusSheet.SEVERITY_WORDS`, read per key and never served.
 *  3. **Tone** — which severities make the indicator dot RED rather than amber.
 *     `LineStatusRanker.RED_SEVERITIES`, a hand-kept subset of (1) with no
 *     config at all.
 *
 * Three lists, in two languages, across two repos, that all have to agree. TfL
 * changes its own vocabulary from time to time, and nothing caught a miss.
 *
 * ## What this does about it
 * One table here, three wire forms out of it. The clients still read three keys,
 * because that is what they already read and the frozen Android app cannot be
 * changed — but the three can no longer disagree, because one array produced
 * them all.
 *
 * ## Why `explore.status.severity.*` is emitted per key
 * That is the shape the clients ALREADY read (`humanSeverity` in
 * `LineStatusSheet.kt`, and the Android equivalent), and it has never been
 * served — a knob wired on both sides of the app with nothing in the middle.
 * Emitting it here lights it up on iOS AND on production Android without an
 * Android release, because the reader was always there.
 */

export type SeverityTone = 'red' | 'amber' | 'green';

export interface SeverityEntry {
    /** TfL's own `statusSeverityDescription`, matched case-insensitively. */
    tfl: string;
    /** What a board shows instead. Often the same word in sentence case. */
    display: string;
    /**
     * `red` means "you cannot travel on this line right now" — a closure or a
     * suspension. Delays and reduced service are `amber`: a train is still
     * coming, and a passenger who sees red should change their plan rather than
     * expect to wait.
     */
    tone: SeverityTone;
}

export class LineSeverityService {
    /**
     * Worst first. The order IS the ranking — a multi-line board rotates its one
     * status strip through this, and the first disrupted line leads.
     *
     * Mirrors TfL's own severity ordering rather than inventing one, so our idea
     * of "worse" matches the source's.
     */
    private static readonly TABLE: SeverityEntry[] = [
        { tfl: 'Closed',               display: 'Closed',              tone: 'red'   },
        { tfl: 'Suspended',            display: 'Suspended',           tone: 'red'   },
        { tfl: 'Part Suspended',       display: 'Part suspended',      tone: 'red'   },
        { tfl: 'Planned Closure',      display: 'Planned closure',     tone: 'red'   },
        { tfl: 'Part Closure',         display: 'Part closed',         tone: 'red'   },
        { tfl: 'Part Closed',          display: 'Part closed',         tone: 'red'   },
        { tfl: 'Severe Delays',        display: 'Severe delays',       tone: 'amber' },
        { tfl: 'Service Closed',       display: 'Service closed',      tone: 'red'   },
        { tfl: 'Not Running',          display: 'Not running',         tone: 'red'   },
        { tfl: 'Reduced Service',      display: 'Reduced service',     tone: 'amber' },
        { tfl: 'Bus Service',          display: 'Replacement buses',   tone: 'amber' },
        { tfl: 'Diverted',             display: 'Diverted',            tone: 'amber' },
        { tfl: 'Minor Delays',         display: 'Minor delays',        tone: 'amber' },
        { tfl: 'Change of frequency',  display: 'Altered frequency',   tone: 'amber' },
        { tfl: 'Special Service',      display: 'Special service',     tone: 'amber' },
        { tfl: 'Exit Only',            display: 'Exit only',           tone: 'amber' },
        { tfl: 'No Step Free Access',  display: 'No step-free access', tone: 'amber' },
        { tfl: 'Issues Reported',      display: 'Issues reported',     tone: 'amber' },
        { tfl: 'Information',          display: 'Notice',              tone: 'amber' },
        // Not disruptions, and deliberately OUT of the order list below: a board
        // shows "Good service" only when every line is good, in which case one
        // line says it for the whole board. They are here for their display name.
        { tfl: 'Good Service',         display: 'Good service',        tone: 'green' },
        { tfl: 'No Issues',            display: 'Good service',        tone: 'green' },
    ];

    /** `explore.status.severity.<lowercased, spaces to underscores>`. */
    private static keyFor(tfl: string): string {
        return `explore.status.severity.${tfl.toLowerCase().replace(/ /g, '_')}`;
    }

    /** The disrupted severities, worst first — everything but the green ones. */
    static order(): string[] {
        return this.TABLE.filter(e => e.tone !== 'green').map(e => e.tfl);
    }

    /** The severities that make the indicator red. */
    static redSeverities(): string[] {
        return this.TABLE.filter(e => e.tone === 'red').map(e => e.tfl);
    }

    /**
     * Every wire form, ready to spread into `getHomeConfig().strings`.
     *
     * All three derive from {TABLE}, which is the whole point: adding a severity
     * is one row here, and the ordering, the tone and the wording move together.
     */
    static homeConfigKeys(): Record<string, string> {
        const out: Record<string, string> = {
            'board.status.severityOrder':  this.order().join(','),
            'board.status.redSeverities':  this.redSeverities().join(','),
        };
        for (const e of this.TABLE) out[this.keyFor(e.tfl)] = e.display;
        return out;
    }
}
