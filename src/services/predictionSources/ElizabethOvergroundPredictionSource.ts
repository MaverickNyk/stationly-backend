import { LinePredictions, Station } from '../../models';
import { TflApiClient } from '../../client/TflApiClient';
import { DataCacheService } from '../dataCacheService';
import { formatPlatform, isUnassignedPlatform } from '../../utils/formatters';
import { capitalize } from '../../utils/tflUtils';
import { PredictionSource, StationPredictionContext } from './PredictionSource';
import { TubeDlrBusTramMixPredictionSource } from './TubeDlrBusTramMixPredictionSource';
import {
    cleanDestinationName,
    isLongDeparted,
    resolveDepartingDirection,
    resolveDirectionTowards,
} from './predictionUtils';

/** One usable board entry, held until direction resolution completes. */
interface BoardRow {
    lineId: string;
    eta: string;
    rawPlatform: string;
    platform: string;
    destId: string;
    displayName: string;
    /** '' until resolved; filled by the two-pass assignment below. */
    direction: string;
}

/**
 * Prediction source for stations served by the Elizabeth line and/or
 * London Overground — the two modes TfL serves a rail-style live
 * departures board for: /StopPoint/{id}/ArrivalDepartures, the same
 * product tfl.gov.uk renders. Orchestration for a station that mixes
 * these modes with others (no such naptanId exists in our DB today, but
 * nothing forbids one): the board serves ONLY the elizabeth-line/
 * overground lines; every other line's arrivals flow through the
 * countdown source below and are merged, so each line is served by
 * exactly one product and no train can appear twice.
 *
 * Why not the countdown arrivals feed these modes also appear in? At a
 * terminus (Abbey Wood, Reading, Shenfield, Heathrow...) the arrivals
 * feed only sees the INBOUND working: arrival times and "destination =
 * this station", which we can only render as "Check Front of Train". The
 * departures board carries the return working — true outbound destination
 * and the actual DEPARTURE time (arrival + turnaround dwell).
 *
 * The countdown arrivals for the station are still passed in via the
 * context: they provide direction inference (the departures feed carries
 * none) and the fallback board for any line the departures feed cannot
 * serve right now.
 */
export class ElizabethOvergroundPredictionSource implements PredictionSource {
    readonly name = 'departure-board';

    // TfL only serves ArrivalDepartures for these modes; the pre-2022 docs
    // say "overground and tfl rail" — tfl-rail became the Elizabeth line.
    private static readonly SUPPORTED_MODES = new Set(['elizabeth-line', 'overground']);

    // Rows TfL marks as not boardable at this station.
    private static readonly SKIPPED_DEPARTURE_STATUSES = new Set(['Cancelled', 'NotStoppingAtStation']);

    // Injected by the factory so exactly ONE countdown-source instance exists
    // (per-line fallback here must be the same object the factory falls back to).
    constructor(private readonly countdownFallback: TubeDlrBusTramMixPredictionSource) {}

    supports(station: Station | undefined): boolean {
        return Object.keys(station?.modes || {})
            .some(m => ElizabethOvergroundPredictionSource.SUPPORTED_MODES.has(m.toLowerCase()));
    }

    async buildStationPredictions(ctx: StationPredictionContext): Promise<Record<string, LinePredictions>> {
        const { naptanId, station } = ctx;

        // The lines to board come from the locally-stored station details,
        // not from the live arrivals — so a quiet hour with zero countdown
        // arrivals can still serve the full departures board. Only the
        // board-capable modes' lines; any other mode at this naptanId is
        // served from its countdown arrivals by the merge at the bottom.
        const modeByLine = new Map<string, string>();
        Object.entries(station?.modes || {}).forEach(([modeName, group]) => {
            if (!ElizabethOvergroundPredictionSource.SUPPORTED_MODES.has(modeName.toLowerCase())) return;
            Object.keys(group.lines || {}).forEach(lineId =>
                modeByLine.set(lineId.toLowerCase(), modeName.toLowerCase()));
        });
        if (modeByLine.size === 0) return this.countdownFallback.buildStationPredictions(ctx);

        // The board API returns entries WITHOUT a lineId (the docs advertise
        // ArrivalDepartureWithLine; the live API sends plain ArrivalDeparture).
        // Requesting one line per call is the only unambiguous attribution —
        // verified live that the lineIds filter really does filter. The calls
        // depend only on local line data, so they overlap the arrivals fetch;
        // entries are filtered below, once the arrivals-taught maps exist.
        const boardEntries = Promise.all([...modeByLine.entries()].map(async ([lineId, modeName]) => ({
            lineId, modeName,
            entries: await TflApiClient.getArrivalDepartures(naptanId, [lineId]),
        })));
        const arrivals = await ctx.arrivals;

        const directionByPlatform = this.inferDirectionsByPlatform(arrivals);
        const directionByDestination = this.inferDirectionsByDestination(arrivals);

        // The cached route's direction labels don't match TfL's live
        // per-station labels everywhere (observed at Liverpool St: live
        // arrivals say Shenfield-bound = outbound, the route says inbound).
        // Route-based resolution is only usable where it does NOT contradict
        // the live labels — otherwise it would split physically same-
        // direction trains across both buckets.
        const routeTrustByLine = new Map<string, boolean>();
        const routeTrusted = (lineId: string): boolean => {
            if (!routeTrustByLine.has(lineId)) {
                let trusted = true;
                directionByDestination.forEach((dir, dest) => {
                    if (!dir) return;
                    const fromRoute = resolveDirectionTowards(lineId, dest);
                    if (fromRoute && fromRoute !== dir) trusted = false;
                });
                routeTrustByLine.set(lineId, trusted);
            }
            return routeTrustByLine.get(lineId)!;
        };

        // TfL transiently emits the same working twice mid-refresh (observed
        // live in both feeds at Abbey Wood 2026-07-19) — identical rows are
        // collapsed. Two real trains can't share one platform at one minute.
        const seenRows = new Set<string>();
        const rows: BoardRow[] = [];
        (await boardEntries).forEach(({ lineId, modeName, entries }) => {
            entries.forEach(entry => {
                const row = this.toBoardRow(naptanId, lineId, modeName, entry,
                    directionByPlatform, directionByDestination, routeTrusted);
                if (!row) return;
                const key = `${row.lineId}|${row.destId}|${row.eta}|${row.rawPlatform}`;
                if (seenRows.has(key)) return;
                seenRows.add(key);
                rows.push(row);
            });
        });

        // Direction pass 2: platforms on these railways are direction-bound,
        // so rows the confident signals missed (mid-line short workings like
        // "to Whitechapel" that route destinations can't place) inherit the
        // direction already resolved for other trains on the same platform.
        // Placeholder platforms ("Platform Unknown") are not physical
        // platforms and must neither teach nor inherit a direction.
        const platformDirs = new Map<string, string>();
        rows.forEach(r => {
            if (!r.direction || isUnassignedPlatform(r.rawPlatform)) return;
            const seen = platformDirs.get(r.rawPlatform);
            if (seen === undefined) platformDirs.set(r.rawPlatform, r.direction);
            // Mixed-direction platforms (Romford Platform 5) must not donate.
            else if (seen !== r.direction) platformDirs.set(r.rawPlatform, '');
        });
        rows.forEach(r => {
            if (!r.direction) r.direction = platformDirs.get(r.rawPlatform) || '';
        });
        // Pass 3: if every resolved train on a line goes one way, the
        // unresolved ones go that way too — TfL gave us no signal to split
        // on, and inventing a split is worse than none (the pre-board path
        // bucketed exactly like this via its single default).
        const uniformDirByLine = new Map<string, string>();
        rows.forEach(r => {
            if (!r.direction) return;
            const seen = uniformDirByLine.get(r.lineId);
            if (seen === undefined) uniformDirByLine.set(r.lineId, r.direction);
            else if (seen !== r.direction) uniformDirByLine.set(r.lineId, '');
        });
        rows.forEach(r => {
            if (!r.direction) r.direction = uniformDirByLine.get(r.lineId) || '';
        });
        // Pass 4: at a terminus every departure leaves in the line's single
        // departing direction (route-derived, so only when the route is
        // trusted here); 'outbound' is the last-resort default.
        const departingDirByLine = new Map<string, string | null>();
        rows.forEach(r => {
            if (r.direction) return;
            if (routeTrusted(r.lineId)) {
                if (!departingDirByLine.has(r.lineId)) {
                    departingDirByLine.set(r.lineId, resolveDepartingDirection(naptanId, r.lineId));
                }
                r.direction = departingDirByLine.get(r.lineId) || 'outbound';
            } else {
                r.direction = 'outbound';
            }
        });

        const lines: Record<string, LinePredictions> = {};
        rows.forEach(r => {
            if (!lines[r.lineId]) {
                lines[r.lineId] = {
                    id: r.lineId,
                    name: this.lineDisplayName(r.lineId, arrivals),
                    dirs: {}
                };
            }
            if (!lines[r.lineId].dirs[r.direction]) {
                lines[r.lineId].dirs[r.direction] = { preds: [] };
            }
            lines[r.lineId].dirs[r.direction].preds.push({
                destId: r.destId,
                platform: r.platform,
                eta: r.eta,
                displayName: r.displayName
            });
        });

        // Any line the board could not serve (endpoint down, late-night gap
        // where the last trains are all still inbound, a mode the board
        // doesn't know) falls back to its countdown arrivals — per line, so
        // one dead board never blanks the rest of the station.
        const uncovered = arrivals.filter(a => !lines[(a.lineId || '').toLowerCase()]);
        if (uncovered.length > 0) {
            const uncoveredIds = [...new Set(uncovered.map(a => (a.lineId || '').toLowerCase()))];
            console.warn(`PRED: ⚠️ [${this.name}] No usable board rows for ${uncoveredIds.join(',')} at ${naptanId} — serving countdown arrivals for them.`);
            const fallbackLines = await this.countdownFallback.buildStationPredictions({ ...ctx, arrivals: Promise.resolve(uncovered) });
            Object.assign(lines, fallbackLines);
        }

        return lines;
    }

    /** Filters one raw board entry; null when it must not reach the board. */
    private toBoardRow(
        naptanId: string,
        lineId: string,
        modeName: string,
        entry: any,
        directionByPlatform: Map<string, string>,
        directionByDestination: Map<string, string>,
        routeTrusted: (lineId: string) => boolean,
    ): BoardRow | null {
        // Entries carry no lineId today; if TfL ever starts sending one,
        // trust it over our per-line attribution.
        if (entry.lineId && entry.lineId.toLowerCase() !== lineId) return null;

        if (ElizabethOvergroundPredictionSource.SKIPPED_DEPARTURE_STATUSES.has(entry.departureStatus)) return null;

        // Trains still inbound to a terminus have no departure time yet —
        // their future departure appears as a separate entry once TfL
        // assigns the return working, so dropping these loses nothing.
        const eta = entry.estimatedTimeOfDeparture || entry.scheduledTimeOfDeparture || '';
        if (!eta) return null;

        // A "departure to here" is an arrival wearing the wrong hat; the
        // board never shows one on tfl.gov.uk either.
        if (entry.destinationNaptanId === naptanId) return null;

        // TfL curates its own board's lifecycle: a Delayed train keeps its
        // stale timestamps until it actually leaves (verified live: a
        // delayed Shenfield train tfl.gov.uk still showed 2.7 min after its
        // timestamp). Exempt Delayed rows from the skew filter; it still
        // drops long-departed OnTime rows the board hasn't expired.
        if (entry.departureStatus !== 'Delayed' && isLongDeparted(eta)) return null;

        const rawPlatform = (entry.platformName || '').trim();
        const platform = formatPlatform(modeName, rawPlatform);
        // Board rows are deliberately NOT passed through isFarFutureUnassigned:
        // that rule exists for countdown snapshot noise, but board rows are
        // TfL-curated timetable — the board just withholds platforms until
        // ~15min out. Dropping them under-showed the horizon vs both prod and
        // tfl.gov.uk (verified live: Hackney Central 16:31, Highbury 16:38
        // departures present on countdown+tfl.gov.uk, missing from us).

        // Direction pass 1 — confident signals only. The departures feed has
        // no direction field, so: destination→direction learned from countdown
        // arrivals FIRST — it mirrors prod's per-train raw labels and drops
        // conflicting destinations, so it reproduces prod's bucketing even
        // where TfL labels are inconsistent per platform (Romford: Gidea Park
        // workings inbound + Shenfield trains outbound on the SAME Platform 5;
        // a platform-first lookup flipped the Shenfield group vs prod) →
        // "inbound" in the platform text → platform→direction map (conflict-
        // dropped, real platforms only) → the route direction whose
        // destination list contains this train's destination (works at any
        // hour, unlike the learned maps).
        const direction = directionByDestination.get(entry.destinationNaptanId || '')
            || (rawPlatform.toLowerCase().includes('inbound') ? 'inbound' : '')
            || (isUnassignedPlatform(rawPlatform) ? '' : directionByPlatform.get(rawPlatform) || '')
            || (routeTrusted(lineId) ? resolveDirectionTowards(lineId, entry.destinationNaptanId) : '');

        return {
            lineId,
            eta,
            rawPlatform,
            platform,
            destId: entry.destinationNaptanId || 'unknown',
            // Same cleaner as the countdown source, so "Reading Rail
            // Station" renders identically from either feed.
            displayName: cleanDestinationName(entry.destinationName),
            direction,
        };
    }

    /**
     * Display name parity: prefer the lineName the countdown arrivals carry
     * (what the pre-factory response always used), then the replicated line
     * metadata, then a capitalised lineId as the last resort.
     */
    private lineDisplayName(lineId: string, arrivals: any[]): string {
        const fromArrivals = arrivals.find(a => (a.lineId || '').toLowerCase() === lineId)?.lineName;
        return fromArrivals
            || DataCacheService.getLineById(lineId)?.name
            || capitalize(lineId);
    }

    /**
     * The departures feed carries no direction field, but on these railways
     * physical platforms are direction-bound — so learn each platform's
     * direction from the Countdown arrivals that DO carry one.
     */
    private inferDirectionsByPlatform(arrivals: any[]): Map<string, string> {
        const directionByPlatform = new Map<string, string>();
        arrivals.forEach(a => {
            const platform = (a.platformName || '').trim();
            if (isUnassignedPlatform(platform) || !a.direction) return; // placeholder, not a physical platform
            const seen = directionByPlatform.get(platform);
            if (seen === undefined) directionByPlatform.set(platform, a.direction);
            // TfL labels can disagree on one physical platform (Romford Platform
            // 5); a platform seen with both directions teaches nothing.
            else if (seen !== a.direction) directionByPlatform.set(platform, '');
        });
        return directionByPlatform;
    }

    /**
     * Learn destination→direction from the countdown arrivals that carry a
     * direction. Independent of platforms and the route cache, so it also
     * covers mid-line short workings (e.g. "to Whitechapel") that route
     * termini lists can't place. Destinations seen with conflicting
     * directions are dropped as ambiguous.
     */
    private inferDirectionsByDestination(arrivals: any[]): Map<string, string> {
        const directionByDestination = new Map<string, string>();
        arrivals.forEach(a => {
            const dest = a.destinationNaptanId;
            if (!dest || !a.direction) return;
            const seen = directionByDestination.get(dest);
            if (seen === undefined) directionByDestination.set(dest, a.direction);
            else if (seen !== a.direction) directionByDestination.set(dest, '');
        });
        return directionByDestination;
    }
}
