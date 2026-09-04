import { useMemo } from 'react';
import type { LineStatus } from '../../api/types';
import { isGoodService, rankOf, toneOf, Tone } from '../../features/departures/logic/status';
import { modeIconUrl } from '../../config/assets';

export interface LineMeta {
    id: string;
    name: string;
    mode: 'tube' | 'overground' | 'rail';
    colorVar: string;
}

export interface LineStatusItem extends LineMeta {
    severity: string;
    isGood: boolean;
    tone: Tone;
    rank: number;
}

export const TUBE_LINES: LineMeta[] = [
    { id: 'bakerloo',         name: 'Bakerloo',         mode: 'tube', colorVar: 'var(--line-bakerloo, #B36305)' },
    { id: 'central',          name: 'Central',          mode: 'tube', colorVar: 'var(--line-central, #E32017)' },
    { id: 'circle',           name: 'Circle',           mode: 'tube', colorVar: 'var(--line-circle, #FFD300)' },
    { id: 'district',         name: 'District',         mode: 'tube', colorVar: 'var(--line-district, #00782A)' },
    { id: 'hammersmith-city', name: 'H&C',              mode: 'tube', colorVar: 'var(--line-hammersmith-city, #F3A9BB)' },
    { id: 'jubilee',          name: 'Jubilee',          mode: 'tube', colorVar: 'var(--line-jubilee, #A0A5A9)' },
    { id: 'metropolitan',     name: 'Metropolitan',     mode: 'tube', colorVar: 'var(--line-metropolitan, #9B0056)' },
    { id: 'northern',         name: 'Northern',         mode: 'tube', colorVar: 'var(--line-northern, #888888)' },
    { id: 'piccadilly',       name: 'Piccadilly',       mode: 'tube', colorVar: 'var(--line-piccadilly, #003688)' },
    { id: 'victoria',         name: 'Victoria',         mode: 'tube', colorVar: 'var(--line-victoria, #0098D4)' },
    { id: 'waterloo-city',    name: 'Waterloo & City',  mode: 'tube', colorVar: 'var(--line-waterloo-city, #95CDBA)' },
];

export const OVERGROUND_LINES: LineMeta[] = [
    { id: 'lioness',          name: 'Lioness',          mode: 'overground', colorVar: 'var(--line-lioness, #E2A12B)' },
    { id: 'mildmay',          name: 'Mildmay',          mode: 'overground', colorVar: 'var(--line-mildmay, #1A6DB4)' },
    { id: 'windrush',         name: 'Windrush',         mode: 'overground', colorVar: 'var(--line-windrush, #E2231A)' },
    { id: 'weaver',           name: 'Weaver',           mode: 'overground', colorVar: 'var(--line-weaver, #7B2D8B)' },
    { id: 'suffragette',      name: 'Suffragette',      mode: 'overground', colorVar: 'var(--line-suffragette, #00843D)' },
    { id: 'liberty',          name: 'Liberty',          mode: 'overground', colorVar: 'var(--line-liberty, #6B717E)' },
    { id: 'elizabeth',        name: 'Elizabeth Line',   mode: 'rail',       colorVar: 'var(--line-elizabeth, #6950A1)' },
    { id: 'dlr',              name: 'DLR',              mode: 'rail',       colorVar: 'var(--line-dlr, #00A4A7)' },
];

/** Index once per frame instead of scanning the status list per line - this ran
 *  nineteen linear searches over a nineteen-element array, twice. */
function indexById(statuses: LineStatus[]): Map<string, LineStatus> {
    const byId = new Map<string, LineStatus>();
    for (const s of statuses) byId.set(s.id.toLowerCase(), s);
    return byId;
}

function enrichLines(metaList: LineMeta[], byId: Map<string, LineStatus>): LineStatusItem[] {
    return metaList.map(conf => {
        const match = byId.get(conf.id.toLowerCase());
        const severity = match?.statusSeverityDescription?.trim() || 'Good Service';
        const isGood = isGoodService(severity);
        const tone = toneOf(severity);
        const rank = isGood ? 9999 : rankOf(severity);

        return {
            ...conf,
            severity,
            isGood,
            tone,
            rank,
        };
    });
}

function StatusColumn({
    title,
    modeIcon,
    lines,
}: {
    title: string;
    /** A mode name, resolved through `config/icons`. This used to be a bare
     *  filename joined onto Vite's base, which loaded the duplicated copy of
     *  the backend's artwork rather than the backend's own. */
    modeIcon: string;
    lines: LineStatusItem[];
}) {
    const disrupted = useMemo(() => {
        return lines.filter(l => !l.isGood).sort((a, b) => a.rank - b.rank);
    }, [lines]);

    const hasGoodService = lines.some(l => l.isGood);

    return (
        <div className="net-col">
            {/* Pinned header at the top with authentic mode icon */}
            <header className="net-col__header">
                <div className="net-col__title-group">
                    <img
                        className="net-col__icon"
                        src={modeIconUrl(modeIcon) ?? undefined}
                        alt=""
                        aria-hidden="true"
                    />
                    <h3 className="net-col__title">{title}</h3>
                </div>
                {disrupted.length === 0 && (
                    <span className="net-col__status-dot net-col__status-dot--green" title="Good Service" />
                )}
            </header>

            <div className="net-col__body">
                {disrupted.length > 0 ? (
                    <>
                        <div className="net-col__disrupted-list">
                            {disrupted.map(line => (
                                <div
                                    key={line.id}
                                    className={`net-chip net-chip--${line.tone} net-chip--disrupted`}
                                >
                                    <span
                                        className="net-chip__bar"
                                        style={{ backgroundColor: line.colorVar }}
                                        aria-hidden="true"
                                    />
                                    <span className="net-chip__name">{line.name}</span>
                                    <span className={`net-chip__severity net-chip__severity--${line.tone}`}>
                                        {line.severity}
                                    </span>
                                </div>
                            ))}
                        </div>
                        {hasGoodService && (
                            <div className="net-col__rest">
                                <span className="net-col__rest-dot" aria-hidden="true">✓</span>
                                <span>Good service on rest of lines</span>
                            </div>
                        )}
                    </>
                ) : (
                    <div className="net-col__all-good">
                        <span className="net-col__check" aria-hidden="true">✓</span>
                        <span>Good service on all lines</span>
                    </div>
                )}
            </div>
        </div>
    );
}

export function NetworkStatusPanel({ statuses }: { statuses: LineStatus[] }) {
    const byId = useMemo(() => indexById(statuses), [statuses]);
    const tubeStatusList = useMemo(() => enrichLines(TUBE_LINES, byId), [byId]);
    const overgroundStatusList = useMemo(() => enrichLines(OVERGROUND_LINES, byId), [byId]);

    return (
        <section className="net-panel" aria-label="Network Line Status">
            <StatusColumn
                title="UNDERGROUND"
                modeIcon="tube"
                lines={tubeStatusList}
            />
            <StatusColumn
                title="OVERGROUND & RAIL"
                modeIcon="overground"
                lines={overgroundStatusList}
            />
        </section>
    );
}
