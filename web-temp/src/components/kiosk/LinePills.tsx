import type { LineStatus } from '../../api/types';
import { toneOf } from '../../features/departures/logic/status';

/**
 * A pill per line at this station, ported from `LinePill` in the app's
 * `Board.kt` - the same treatment the phone home screen uses.
 *
 * Two rules carried over exactly:
 *
 *  - **The fill is the line's own colour, at low alpha.** That is what makes a
 *    multi-line station legible at a glance: Mildmay blue and Weaver purple
 *    sitting next to each other say more than two identical grey chips ever
 *    could.
 *  - **The dot is the line's colour when healthy, and the STATUS tone when it
 *    is not.** A green dot would be redundant with "no news is good news", and
 *    it would cost the pill its line identity for nothing.
 *
 * The one deliberate change from the phone: the app's selected-state fill
 * (0.30) is used unconditionally, because a café pill is never selected and the
 * unselected 0.15 disappears at six metres. Same colour, same meaning, tuned for
 * the viewing distance.
 *
 * Note what does NOT get the line colour: the board itself. Real platform
 * boards are single-colour amber, and that rule holds on every Stationly
 * surface. Colour identifies the line in the chrome; it never enters the rows.
 */
export function LinePills({
    lines,
    statuses,
}: {
    lines: { id: string; name: string }[];
    statuses: LineStatus[];
}) {
    if (lines.length === 0) return null;

    return (
        <div className="pills">
            {lines.map(line => {
                const status = statuses.find(s => s.id.toLowerCase() === line.id.toLowerCase());
                const severityDesc = status?.statusSeverityDescription || 'Good Service';
                const tone = toneOf(severityDesc);
                const color = `var(--line-${line.id}, var(--stationly-red))`;

                const dot =
                    tone === 'green' ? color
                    : tone === 'amber' ? 'var(--status-amber)'
                    : 'var(--stationly-red)';

                return (
                    <div key={line.id} className="pills__item">
                        <span
                            className="pill"
                            style={{
                                ['--pill-color' as string]: color,
                                ['--pill-dot' as string]: dot,
                            }}
                        >
                            <span className="pill__dot" />
                            {line.name}
                        </span>

                        <span className={`pill-status pill-status--${tone}`}>
                            {tone === 'amber' ? (
                                <svg className="pill-status__icon" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
                                </svg>
                            ) : tone === 'red' ? (
                                <svg className="pill-status__icon" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
                                </svg>
                            ) : null}
                            <span>{severityDesc}</span>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
