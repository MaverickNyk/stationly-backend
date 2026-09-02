import { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';

import { DotMatrixBoard } from '../../features/departures/components/DotMatrixBoard';
import { NextDepartureCard } from '../../features/departures/components/NextDepartureCard';
import { QrPanel } from '../../components/kiosk/QrPanel';
import { NetworkStatusPanel } from '../../components/kiosk/NetworkStatusPanel';
import { ModeRoundel } from '../../components/kiosk/ModeRoundel';
import { LinePills } from '../../components/kiosk/LinePills';
import { FullscreenButton } from '../../components/kiosk/FullscreenButton';

import { useKioskStream } from '../../features/departures/hooks/useKioskStream';
import { useMinuteTick } from '../../features/departures/hooks/useMinuteTick';
import { useKioskAutoUpdate } from '../../features/departures/hooks/useKioskAutoUpdate';
import { useScreenWakeLock } from '../../features/departures/hooks/useScreenWakeLock';
import {
    dropUnassignedWhenPossible,
    flatten,
    groupByPlatform,
    tick,
} from '../../features/departures/logic/board';
import { computeFallback, fallbackCopy } from '../../features/departures/logic/fallback';
import { londonMinutesOf } from '../../time/london';
import { isGoodService } from '../../features/departures/logic/status';
import { DEFAULT_STATION, isValidNaptan, readKioskConfig } from '../../config/kiosk';
import { BRAND_MARK_URL } from '../../config/assets';
import { formatDestinationShort } from '../../features/departures/logic/eta';

/**
 * The café display.
 *
 *   ┌──────────────────────────────────────────┐
 *   │  station · roundel · pills · clock       │  ┐
 *   │  [ next departure ] [ next departure ]   │  │ 70%
 *   │  ┌── dot-matrix board, by platform ──┐   │  │
 *   │  └───────────────── status marquee ──┘   │  ┘
 *   ├───────────────────────────┬──────────────┤
 *   │  the café's own space     │  our app     │  30%  (70 / 30)
 *   └───────────────────────────┴──────────────┘
 *
 * The top is the phone home screen's reading order, scaled to a wall: station,
 * then which lines, then the next train, then the full board, then the status.
 * The bottom belongs to the room - the café's message on the left, and the one
 * thing we are asking for on the right.
 */
function lineVar(lineId: string | undefined): string {
    return lineId ? `var(--line-${lineId}, var(--stationly-red))` : 'var(--stationly-red)';
}

export function KioskRoute() {
    useKioskAutoUpdate();
    useScreenWakeLock();

    const { stationId } = useParams();
    const { search } = useLocation();
    const config = useMemo(() => readKioskConfig(search), [search]);

    const valid = isValidNaptan(stationId);
    const { station, statuses, lineModes, lastUpdatedMs, isOnline, isLoading, clockSkewMs } =
        useKioskStream(valid ? stationId : '');

    const minuteTick = useMinuteTick();

    // Count down against the SERVER's clock. A café TV is very often minutes out
    // of true, and an ETA only means anything relative to the clock that
    // produced it - a screen running three minutes fast would quietly drop every
    // train before it arrived.
    const now = minuteTick + clockSkewMs;

    // Flattening the payload and shortening every destination depends on the
    // PAYLOAD, not the clock - so it is memoised against the payload alone.
    // Folded into the block below it re-ran on every minute tick, re-walking
    // and re-regexing every prediction at the station once a minute for a
    // result that could not have changed.
    const flatRows = useMemo(() => {
        if (!station) return [];
        return flatten(station).map(r => ({
            ...r,
            destination: formatDestinationShort(r.destination),
        }));
    }, [station]);

    // This part genuinely is per-minute: drop departed trains, relabel the rest
    // against the current clock, and group into the blocks the board draws.
    //
    // The BOARD shows every platform, unassigned included - those are real
    // departures and a passenger reading the board wants them.
    const groups = useMemo(
        () => groupByPlatform(tick(flatRows, now), config.rowsPerPlatform)
            .slice(0, config.maxPlatforms),
        [flatRows, now, config.rowsPerPlatform, config.maxPlatforms],
    );

    // The CARDS do not. A hero card is an instruction - "this is the train to
    // move for" - and TfL has not said which platform it leaves from. The row
    // on the board carries the same train honestly, with its platform named as
    // unassigned; the card would have to imply one.
    //
    // Note the count: `maxHeroCards`, not `maxPlatforms`. The board may show
    // four platform blocks and still want only two hero cards - they are
    // different questions about different parts of the screen, and passing the
    // board's number here put four cards in a row sized for two.
    const cardGroups = useMemo(
        () => dropUnassignedWhenPossible(groups, config.maxHeroCards),
        [groups, config.maxHeroCards],
    );

    const lines = useMemo(
        () => Object.values(station?.lines ?? {}).map(l => ({ id: l.id, name: l.name })),
        [station],
    );

    const stationLineIds = useMemo(
        () => new Set(lines.map(l => l.id.toLowerCase())),
        [lines],
    );

    // Statuses for the lines serving THIS station (e.g. Mildmay at Hackney Wick).
    //
    // No fallback to the full list. `statuses` carries the WHOLE network now -
    // the stream's kiosk_meta frame subscribes to every major line for the
    // bottom panel - so falling back to it meant that a station whose own lines
    // happened to have no status yet rotated Piccadilly and Jubilee
    // disruptions through its marquee. An empty strip is correct there; the
    // network panel below is where other lines belong.
    const stationStatuses = useMemo(
        () => statuses.filter(s => stationLineIds.has(s.id.toLowerCase())),
        [statuses, stationLineIds],
    );

    const primaryLine = lines[0];
    const primaryStatus = stationStatuses[0];
    const primaryMode = primaryLine ? lineModes[primaryLine.id] : undefined;

    // A disrupted line names its severity on the card rather than showing a bare
    // "no departures". A Good Service reason is discarded: TfL puts standing
    // advice there, and under an empty hero it implies a connection that does
    // not exist.
    const emptyHeadline = useMemo(() => {
        const severity = primaryStatus?.statusSeverityDescription?.trim();
        if (severity && !isGoodService(severity)) return severity;
        return 'No departures reported yet';
    }, [primaryStatus]);

    // No `!valid` branch: that state returns <KioskSplash> below, before this
    // value is read. It used to build a "Station not set" copy that nothing
    // could ever render.
    const fallback = useMemo(() => {
        const state = computeFallback({
            hasPredictions: groups.length > 0,
            isOnline,
            lastUpdatedMs,
            nowMs: now,
            londonMinutes: londonMinutesOf(now),
            statusSeverity: primaryStatus?.statusSeverityDescription,
            statusReason: primaryStatus?.reason,
        });
        return state ? fallbackCopy(state) : null;
    }, [groups.length, isOnline, lastUpdatedMs, now, primaryStatus]);

    if (!valid) {
        return (
            <KioskSplash
                message="Station not set."
                hint={`Add a valid NaPTAN ID to the URL (e.g. /kiosk/${DEFAULT_STATION})`}
            />
        );
    }

    if (isLoading || !station) {
        return (
            <KioskSplash
                pulse
                message="Connecting to live TfL signaling..."
                hint={`Station: ${stationId}`}
            />
        );
    }

    const stationName = formatDestinationShort(station.name);

    return (
        <main
            className="kiosk"
            style={
                // vh/vw, not `%`: percentage padding resolves against the
                // containing block's WIDTH on all four sides, so `padding: 3%`
                // on a 16:9 screen insets the top and bottom by 5.3% of their
                // own axis. Overscan crops both axes evenly and the correction
                // has to as well.
                config.overscanPercent
                    ? {
                        padding: `${config.overscanPercent}vh ${config.overscanPercent}vw`,
                    }
                    : undefined
            }
        >
            <section className="kiosk__top">
                <header className="kiosk__head">
                    <ModeRoundel mode={primaryMode} lineColor={lineVar(primaryLine?.id)} />
                    <h1 className="kiosk__station">{stationName}</h1>
                    <LinePills lines={lines} statuses={stationStatuses} />

                    <div className="kiosk__brand">
                        <img className="kiosk__brandmark" src={BRAND_MARK_URL} alt="" aria-hidden="true" />
                        <span className="kiosk__brandname">Stationly</span>
                    </div>
                </header>

                <div className="heroes">
                    {cardGroups.length > 0 ? (
                        cardGroups.map(group => (
                            <NextDepartureCard
                                key={group.platform}
                                platform={group.platform}
                                row={group.rows[0]}
                                lineColor={lineVar(group.rows[0]?.lineId ?? primaryLine?.id)}
                                emptyHeadline={emptyHeadline}
                            />
                        ))
                    ) : (
                        <NextDepartureCard
                            platform=""
                            lineColor={lineVar(primaryLine?.id)}
                            emptyHeadline={emptyHeadline}
                        />
                    )}
                </div>

                <DotMatrixBoard
                    groups={groups}
                    fallback={fallback}
                    statuses={stationStatuses}
                    rowsPerPlatform={config.rowsPerPlatform}
                />
            </section>

            <section className="kiosk__bottom">
                <NetworkStatusPanel statuses={statuses} />
                <QrPanel caption={config.qrCaption} />
            </section>

            {/* Bottom-right corner timestamp */}
            <footer className="kiosk__footnote">
                <LastUpdatedBadge lastUpdatedMs={lastUpdatedMs} />
            </footer>

            <div className="kiosk__fs-row">
                <FullscreenButton />
            </div>
        </main>
    );
}

/**
 * The full-screen states: no station in the URL, and waiting for the first
 * frame. They were two near-identical copies of the same markup differing only
 * in their two strings and one pulse - and the example NaPTAN in the "station
 * not set" hint was hardcoded separately from `DEFAULT_STATION`, so pointing the
 * trial at a different station would have left the on-screen instructions naming
 * the old one.
 */
function KioskSplash({
    message,
    hint,
    pulse = false,
}: {
    message: string;
    hint: string;
    /** The amber breathing dot - shown while we are genuinely waiting on
     *  something, not on a state the screen will sit in until someone fixes the
     *  URL. */
    pulse?: boolean;
}) {
    return (
        <main className="kiosk kiosk--loader">
            <div className="kiosk-loader">
                <div className="kiosk-loader__brand">
                    <img className="kiosk-loader__logo" src={BRAND_MARK_URL} alt="" aria-hidden="true" />
                    <span className="kiosk-loader__title">Stationly</span>
                </div>

                {pulse && (
                    <div className="kiosk-loader__pulse">
                        <div className="kiosk-loader__amber-dot" />
                        <div className="kiosk-loader__amber-ring" />
                    </div>
                )}

                <p className="kiosk-loader__msg">{message}</p>
                <span className="kiosk-loader__station-hint">{hint}</span>
            </div>
        </main>
    );
}

/**
 * "Last Updated: 12s ago".
 *
 * The label is held in state rather than recomputed from a ticking `now`,
 * and only written when the STRING changes. Past the first minute the text
 * moves once a minute and then once an hour, so the previous version was
 * re-rendering an identical span 3,599 times an hour for the life of the
 * screen. Same second-by-second accuracy while it is young, none of the churn
 * once it is not.
 */
function LastUpdatedBadge({ lastUpdatedMs }: { lastUpdatedMs: number }) {
    const [label, setLabel] = useState(() => elapsedLabel(lastUpdatedMs, Date.now()));

    useEffect(() => {
        const apply = () => {
            const next = elapsedLabel(lastUpdatedMs, Date.now());
            setLabel(prev => (prev === next ? prev : next));
        };
        apply();
        const id = window.setInterval(apply, 1000);
        return () => window.clearInterval(id);
    }, [lastUpdatedMs]);

    return <span className="kiosk__last-updated">Last Updated: {label}</span>;
}

function elapsedLabel(lastUpdatedMs: number, nowMs: number): string {
    if (lastUpdatedMs === 0) return '-';
    const sec = Math.max(0, Math.floor((nowMs - lastUpdatedMs) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
}
