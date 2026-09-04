import { useEffect, useMemo, useState } from 'react';
import type { LineStatus } from '../../../api/types';
import { STATUS_ROTATION_MS, rotation, statusLabel } from '../logic/status';

/**
 * ONE status strip for the whole board, worst first, rotating every 8s.
 */
export function StatusMarquee({ statuses }: { statuses: LineStatus[] }) {
    const entries = useMemo(() => rotation(statuses), [statuses]);
    const [index, setIndex] = useState(0);

    // Restart from the top whenever the set of entries changes: worst-first is
    // the ordering, so a new disruption belongs at the front of the rotation
    // rather than appearing whenever the old cursor happens to reach it.
    useEffect(() => {
        setIndex(0);
        if (entries.length <= 1) return;
        const id = window.setInterval(
            () => setIndex(i => (i + 1) % entries.length),
            STATUS_ROTATION_MS,
        );
        return () => window.clearInterval(id);
    }, [entries]);

    if (entries.length === 0) return null;

    const entry = entries[index % entries.length];
    const reason = entry.reason;
    const severityLabel = statusLabel(entry);

    return (
        <div className="panel__row panel__row--status">
            <span className="status__label">{severityLabel}</span>

            {reason && (
                <div className="status__marquee">
                    <div
                        className="status__track"
                        style={{ ['--marquee-duration' as string]: `${Math.max(18, reason.length * 0.3)}s` }}
                    >
                        <div className="status__group">
                            <span>{reason}</span>
                            <span aria-hidden="true" className="status__bullet">•</span>
                        </div>
                        <div className="status__group" aria-hidden="true">
                            <span>{reason}</span>
                            <span aria-hidden="true" className="status__bullet">•</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
