import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatDestination } from '../utils/formatters';
import { LineInfo, LineRouteResponse, LineStatusResponse, TransportMode } from '../models';

import { GOOD_SERVICE_MESSAGES, TFL_LINE_COLORS, shortNameFor } from '../utils/tflUtils';
import { DataCacheService } from '../services/dataCacheService';
import { LocalDbService } from '../services/localDbService';
import { nowMs, toIso, toEpochMs } from '../utils/timestamps';
import { encodeRouteForFirestore, decodeRouteFromFirestore } from '../utils/routeEncoding';

/** Fetch ordered stop-ID sequences for each direction of a line from TfL. */
async function fetchSequences(
    lineId: string,
    directions: { direction: string }[]
): Promise<{ sequences: Record<string, string[][]>; stationNames: Record<string, string> }> {
    const sequences: Record<string, string[][]> = {};
    const stationNames: Record<string, string> = {};
    for (const dir of directions) {
        try {
            const d = dir.direction.toLowerCase();
            // Map circular/generic TfL directions to standard supported sequence parameters
            const tflDir = (d === 'clockwise' || d === 'all') ? 'inbound' : (d === 'anticlockwise' ? 'outbound' : d);

            const data = await TflApiClient.getLineRouteSequence(lineId, tflDir);
            sequences[dir.direction] = (data.orderedLineRoutes || []).map((r: any) => r.naptanIds || []);
            // Populate names from stations array
            (data.stations || []).forEach((s: any) => {
                const id = s.stationId || s.id;
                if (id && s.name) stationNames[id] = s.name;
            });
            // Also populate from stopPointSequences (more reliable ID↔name mapping)
            (data.stopPointSequences || []).forEach((seq: any) => {
                (seq.stopPoint || []).forEach((sp: any) => {
                    const id = sp.id || sp.naptanId;
                    if (id && sp.name && !stationNames[id]) stationNames[id] = sp.name;
                });
            });
        } catch {
            console.warn(`DATA: ⚠️ Could not fetch sequence for ${lineId}/${dir.direction}`);
        }
    }
    return { sequences, stationNames };
}

/** One stop on a route sequence, carrying the naptan id alongside the display
 *  name. The id is what clients MATCH on (a prediction's destination naptan);
 *  the name is only for display. They must never be derived separately — see
 *  [stopsFor]. */
export interface RouteStop {
    id: string;
    name: string;
}

/**
 * Map a run of naptan ids to {id, name} stops (cache fallback + formatting).
 *
 * This is the primitive; [namesFor] is derived from it so the two can never
 * drift — building an id list and a name list independently would misalign them
 * at any stop handled differently by one and not the other, and clients
 * index-match the two arrays.
 *
 * A stop whose name resolves to nothing is KEPT, falling back to its naptan id.
 * Dropping it was tolerable while this returned names only — a cosmetic gap in a
 * timeline. It is not tolerable now that `id` is the field clients match on: an
 * omitted stop reads as "this train does not call there", turning a missing
 * label into a wrong answer. An ugly label is the lesser failure.
 */
function stopsFor(ids: string[], stationNames: Record<string, string>): RouteStop[] {
    return ids.map(id => {
        const raw = stationNames[id]
            ?? DataCacheService.getAllStations().find((s: any) => s.naptanId === id)?.commonName;
        return { id, name: raw ? formatDestination(raw) : id };
    });
}

/** A destination chip: one reachable terminus and the run of stops to it. */
interface DestinationChip {
    id: string;
    label: string;
    name: string;
    upcomingStations: string[];
    upcomingStops: RouteStop[];
}

/** Display names only — the legacy shape, kept byte-identical for existing clients. */
function namesFor(ids: string[], stationNames: Record<string, string>): string[] {
    return stopsFor(ids, stationNames).map(s => s.name);
}

/**
 * Longest common ordered prefix across several stop lists — the shared trunk
 * all branches travel before they diverge. Empty at a hard junction.
 *
 * Compares on naptan id rather than display name: names are formatted strings
 * and two distinct stops can format to the same text, which would silently
 * over-extend the trunk past a real divergence.
 */
function commonPrefix(lists: RouteStop[][]): RouteStop[] {
    if (lists.length === 0) return [];
    // Copy: the single-branch result would otherwise alias that chip's own
    // upcomingStops array, so any later mutation of the trunk would corrupt it.
    if (lists.length === 1) return lists[0].slice();
    const out: RouteStop[] = [];
    const first = lists[0];
    for (let i = 0; i < first.length; i++) {
        const v = first[i];
        if (lists.every(l => l[i]?.id === v.id)) out.push(v); else break;
    }
    return out;
}

/** Maps raw TfL inbound/outbound directions to clean passenger-facing compass points for rail/tube modes. */
function getCompassDirection(lineId: string, direction: string, modeName?: string): string {
    const dirLower = direction.toLowerCase();
    const modeLower = (modeName || '').toLowerCase();

    // Buses: "Towards" is perfectly clear on its own, no inbound/outbound or compass direction needed
    if (modeLower === 'bus') {
        return 'Towards';
    }

    switch (lineId.toLowerCase()) {
        case 'victoria':
        case 'northern':
        case 'bakerloo':
        case 'piccadilly': // Piccadilly operates strictly under Northbound/Southbound platform signage
        case 'lioness':    // Overground Euston to Watford
        case 'weaver':     // Overground Liverpool St to Enfield/Cheshunt
            return dirLower === 'inbound' ? 'Southbound' : 'Northbound';
        case 'dlr':
            return dirLower === 'inbound' ? 'Northbound' : 'Southbound';
        case 'windrush':   // Overground Highbury to Croydon/Clapham
        case 'liberty':    // Overground Romford to Upminster
            return dirLower === 'inbound' ? 'Northbound' : 'Southbound';
        case 'mildmay':    // Overground Stratford to Richmond/Clapham
            return dirLower === 'inbound' ? 'Eastbound' : 'Westbound';
        case 'suffragette': // Overground Gospel Oak to Barking Riverside
            return dirLower === 'inbound' ? 'Westbound' : 'Eastbound';
        case 'circle':      // Circle operates as a loop (Inner / Outer Rail)
            return dirLower === 'inbound' ? 'Clockwise' : 'Anticlockwise';
        case 'district':
        case 'metropolitan':
            // Audited against live route data: TfL labels the WESTERN/outer termini
            // as 'inbound' on these lines, so inbound = Westbound — the opposite of
            // the default E/W rule:
            //   District:     inbound = Wimbledon/Richmond/Ealing Broadway/Kensington Olympia (Aldgate-side is Eastbound)
            //   Metropolitan: inbound = Amersham/Chesham/Watford/Uxbridge (Aldgate is the eastern end → Eastbound)
            // (Northern was checked too — it's already correct: inbound→Southbound = Morden.)
            return dirLower === 'inbound' ? 'Westbound' : 'Eastbound';
        case 'central':
        case 'jubilee':
        case 'hammersmith-city':
        case 'elizabeth':
        case 'waterloo-city':
        default:
            // Standard east/west mapping
            return dirLower === 'inbound' ? 'Eastbound' : 'Westbound';
    }
}

function assignGoodServiceReason(statusSeverityDescription: string, currentReason?: string, prevReason?: string): string {
    if (statusSeverityDescription?.toLowerCase() === 'good service' && (!currentReason || currentReason.trim() === '')) {
        if (prevReason && prevReason.trim() !== '') {
            return prevReason;
        }
        const index = Math.floor(Math.random() * GOOD_SERVICE_MESSAGES.length);
        return GOOD_SERVICE_MESSAGES[index];
    }
    return currentReason || '';
}

function getSeverityPriority(severity: number): number {
    switch (severity) {
        case 1:  // Closed
        case 2:  // Suspended
        case 16: // Not Running
        case 20: // Service Closed / No Service
            return 9;
        case 4:  // Planned Closure
            return 8;
        case 3:  // Part Suspended
        case 5:  // Part Closure
        case 11: // Part Closed
            return 7;
        case 6:  // Severe Delays
            return 6;
        case 7:  // Reduced Service
        case 8:  // Bus Service
        case 15: // Diverted
            return 5;
        case 9:  // Minor Delays
        case 14: // Change of frequency
        case 17: // Issues Reported
            return 4;
        case 12: // Exit Only
        case 13: // No Step Free Access
        case 19: // Information
            return 2;
        case 0:  // Special Service
            return 1;
        case 10: // Good Service
        case 18: // No Issues
        default:
            return 0;
    }
}

export class LineController {
    // ── Line-status tier-4 (TfL) freshness control ──
    /**
     * How long a mode may go unverified before the TfL fallback re-asks.
     *
     * 60s. This is a FALLBACK bound, not the liveness path — the Syncer's push
     * delivers changes within a poll cycle, and every push counts as a
     * verification (see `newestData` below), so with a healthy Syncer this
     * rarely fires at all. It only sets the worst case when the Syncer is down:
     * one TfL call per mode per minute, ~5 modes, well inside TflApiClient's
     * 210ms request spacing.
     *
     * Was 10 minutes, which was chosen to match the Syncer's Firestore
     * replication cadence — a mechanism that no longer exists.
     *
     * Env-overridable at boot, mirroring PREDICTION_CACHE_FRESH_MS.
     */
    private static readonly LINE_STATUS_TTL_MS =
        Number(process.env.LINE_STATUS_TTL_MS) > 0 ? Number(process.env.LINE_STATUS_TTL_MS) : 60 * 1000;
    /**
     * How often a mode may be re-asked because a SPECIFIC line is missing.
     *
     * Distinct from the TTL because it keys off `lastCheck` alone, not
     * `max(newestData, lastCheck)`: a Syncer happily pushing OTHER lines in the
     * mode keeps it "verified" and therefore not stale, while the line a client
     * actually asked for is still absent.
     */
    private static readonly MISSING_LINE_RETRY_MS = 60 * 1000;
    /** Last time we hit TfL for a mode — gates re-fetching even when the data
     *  watermark is old but unchanged, so we don't TfL-poll on every request. */
    private static lastTflRefreshByMode: Map<string, number> = new Map();
    /** In-flight refresh per mode, so a burst of requests collapses to one TfL call. */
    private static inFlightStatusRefresh: Map<string, Promise<LineStatusResponse[]>> = new Map();

    /**
     * Warm a mode's statuses if they are cold or stale, otherwise do nothing.
     *
     * The staleness gate lives here rather than at the call sites so REST and
     * the WebSocket stream cannot drift apart on when TfL is worth asking —
     * and, more importantly, so a stream subscribe inherits ALL the existing
     * protection for free: single-flight per mode via `inFlightStatusRefresh`,
     * plus `lastTflRefreshByMode`, which caps a mode at one TfL call per
     * LINE_STATUS_TTL_MS no matter how many clients subscribe.
     *
     * That is why line status needs no StreamPrefetch equivalent. Predictions
     * are fetched per station, so N cold stations meant N calls and had to be
     * budgeted and capped; statuses are fetched per MODE, of which there are
     * about ten, already rate-gated and already deduplicated.
     *
     * Never throws: a TfL failure leaves whatever is cached in place, which is
     * the right outcome for both callers. It is REPORTED instead — the boolean
     * says whether the mode is usable afterwards, so the stream can tell a
     * client its board will stay blank rather than leaving it to guess. REST
     * ignores it and serves whatever is cached.
     */
    static async ensureLineStatuses(mode: string, requiredLineIds: string[] = []): Promise<boolean> {
        const cached = DataCacheService.getLineStatuses(mode);
        const newestData = cached.length
            ? Math.max(...cached.map((s: any) => toEpochMs(s.lastUpdatedTime) ?? 0))
            : 0;
        const lastCheck = LineController.lastTflRefreshByMode.get(mode) ?? 0;
        const stale = (Date.now() - Math.max(newestData, lastCheck)) > LineController.LINE_STATUS_TTL_MS;

        // A line we specifically need is absent, which neither check above
        // catches. The cache now fills from the Syncer's pushes, and those
        // carry only CHANGED lines — so after a backend restart it is routinely
        // non-empty yet missing most of the mode: "fresh" by timestamp, but
        // incomplete. Left to the staleness gate, a subscriber to an unchanged
        // line would wait up to LINE_STATUS_TTL_MS for its first paint.
        //
        // Only the stream passes ids; REST asks for a whole mode and is content
        // to let the staleness gate fill any gap.
        const missing = requiredLineIds.some((id) => !DataCacheService.getLineStatusById(id));
        // Floor, so a line TfL simply never reports cannot turn every subscribe
        // into a fetch. One attempt a minute is enough to self-heal.
        const mayRetryMissing = (Date.now() - lastCheck) > LineController.MISSING_LINE_RETRY_MS;

        if (cached.length !== 0 && !stale && !(missing && mayRetryMissing)) return true;

        const why = cached.length === 0 ? 'cold'
            : (missing ? 'missing a requested line' : `stale (>${LineController.LINE_STATUS_TTL_MS / 1000}s)`);
        console.log(`STATUS: ⏳ ${mode} statuses ${why} — refreshing from TfL...`);
        try {
            await LineController.refreshLineStatusesFromTfl(mode);
            return true;
        } catch (tflErr: any) {
            console.warn(`STATUS: ⚠️ TfL refresh failed for ${mode}: ${tflErr.message}`);
            return false;
        }
    }

    /**
     * Tier-4 line-status refresh: fetch live from TfL, change-detect against the
     * current cache, store ONLY changed statuses, and return the mode's
     * statuses. Single-flighted per mode.
     *
     * This is the FALLBACK path, not the live one. Liveness comes from the
     * Syncer pushing to POST /internal/line-status-updates; this covers a cold
     * cache and a Syncer that is down or delayed.
     */
    private static async refreshLineStatusesFromTfl(modeStr: string): Promise<LineStatusResponse[]> {
        const inFlight = LineController.inFlightStatusRefresh.get(modeStr);
        if (inFlight) return inFlight;

        const run = (async (): Promise<LineStatusResponse[]> => {
            const rawStatuses = await TflApiClient.getLineStatuses(modeStr);
            const nowTs = nowMs();
            const existing = new Map(
                DataCacheService.getLineStatuses(modeStr).map((s: any) => [s.id, s])
            );
            const changed: LineStatusResponse[] = [];

            for (const ls of rawStatuses) {
                let selectedStatus = ls.lineStatuses?.[0];
                if (ls.lineStatuses && ls.lineStatuses.length > 1) {
                    let maxPriority = -1;
                    for (const s of ls.lineStatuses) {
                        const severity = s.statusSeverity;
                        if (severity !== undefined && severity !== null) {
                            const priority = getSeverityPriority(Number(severity));
                            if (priority > maxPriority) { maxPriority = priority; selectedStatus = s; }
                        }
                    }
                }

                const newSeverity = selectedStatus?.statusSeverityDescription || "Unknown";
                const prev = existing.get(ls.id);
                const prevReason = prev?.statusSeverityDescription?.toLowerCase() === 'good service' ? prev.reason : undefined;
                const newReason = assignGoodServiceReason(selectedStatus?.statusSeverityDescription, selectedStatus?.reason, prevReason);

                // Change-detection: skip unchanged statuses so we don't churn the
                // cache, bump the watermark, or write to Firestore (which would
                // needlessly wake the syncer + every replica).
                if (prev
                    && prev.statusSeverityDescription === newSeverity
                    && (prev.reason || '') === (newReason || '')) {
                    continue;
                }

                const status: LineStatusResponse = {
                    id: ls.id,
                    name: ls.name,
                    statusSeverityDescription: newSeverity,
                    reason: newReason,
                    mode: ls.modeName,
                    lastUpdatedTime: nowTs,
                };
                DataCacheService.setLineStatus(ls.id, status, 'tfl');
                changed.push(status);
            }

            // Firestore write removed deliberately. It existed to replicate to
            // the Syncer and other instances, but statuses are now in-memory
            // per-process (exactly like PredictionCache) and the Syncer does its
            // own TfL polling, so the write bought nothing and cost a document
            // write per change. setLineStatus above has already stored each one
            // and fanned it out to subscribers.
            if (changed.length > 0) {
                console.log(`STATUS: ✅ ${modeStr}: ${changed.length} changed status(es) refreshed from TfL.`);
            }

            LineController.lastTflRefreshByMode.set(modeStr, nowTs);
            return DataCacheService.getLineStatuses(modeStr);
        })();

        LineController.inFlightStatusRefresh.set(modeStr, run);
        try { return await run; }
        finally { LineController.inFlightStatusRefresh.delete(modeStr); }
    }

    /**
     * @swagger
     * /lines/mode/{mode}:
     *   get:
     *     summary: Get Lines by Mode
     *     description: Retrieves all lines for a specific transport mode.
     *     tags: [Lines]
     *     parameters:
     *       - in: path
     *         name: mode
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: A list of lines for the given mode.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/LineInfo'
     */
    /**
     * The display fields every `/lines` response carries: `label`, `color` and
     * `shortName`.
     *
     * One function because `getLinesByMode` has FOUR return paths — station
     * discovery, the mode cache, the Firestore fallback and the TfL fallback —
     * and each built its own object literal with its own copy of the colour
     * lookup. Adding a field meant remembering all four, and a path that
     * forgot it would serve a line with no short name; the client would fall
     * back and nobody would notice until a rename made the fallback wrong.
     *
     * `shortName` is omitted rather than nulled when there isn't one (bus
     * routes), so the field's absence keeps its meaning on the wire — see
     * `shortNameFor`.
     */
    private static decorateLine(l: any) {
        const short = shortNameFor(l.id);
        return {
            ...l,
            label: l.name || l.label,
            color: TFL_LINE_COLORS[l.id] || null,
            ...(short ? { shortName: short } : {}),
        };
    }

    static async getLinesByMode(req: Request, res: Response) {
        try {
            const mode = req.params.mode;
            const station = req.query.station as string;
            
            // --- Filter by specific Station if provided (Discovery Mode) ---
            // Aggregates lines from ALL stops in the same group (icsCode / stationNaptan),
            // so that grouped bus stops show the full set of routes at that location.
            if (station && !station.includes('{station}')) {
                console.log(`DATA: 🔍 Filtering lines for station ${station} (Discovery Mode) using Cache`);
                // Accepts the HUB id the client now stores as well as any
                // member naptan. Matching on naptanId alone stopped working the
                // moment clients held a StopArea id: no station document has
                // one as its own naptan, so this found nothing and fell through
                // to "every line on the mode".
                const siblings = DataCacheService.stationsInGroup(station);

                if (siblings.length > 0) {
                    const lineIdsAtStation = new Set<string>();
                    siblings.forEach(sib => {
                        const modeData = sib.modes?.[mode];
                        if (modeData) Object.keys(modeData.lines).forEach(id => lineIdsAtStation.add(id));
                    });

                    if (lineIdsAtStation.size > 0) {
                        const allLines = DataCacheService.getLinesByMode(mode);
                        const filteredLines = allLines
                            .filter(l => lineIdsAtStation.has(l.id))
                            .map(l => LineController.decorateLine(l));

                        if (filteredLines.length > 0) {
                            return res.json(filteredLines.sort((a, b) => a.label.localeCompare(b.label)));
                        }
                    }
                }
                console.warn(`DATA: ⚠️ No cached lines found for station ${station} matching mode ${mode}.`);
            }

            // Standard Path: Get all lines for mode from cache
            const cachedLines = DataCacheService.getLinesByMode(mode);
            if (cachedLines.length > 0) {
                const sduiLines = cachedLines.map(l => LineController.decorateLine(l));
                return res.json(sduiLines.sort((a, b) => a.label.localeCompare(b.label)));
            }

            // Deep Fallback: Firestore
            const snapshot = await db.collection('lines').where('modeName', '==', mode).get();
            let lines: any[] = [];
            snapshot.forEach(doc => lines.push({ id: doc.id, ...doc.data() as any }));

            if (lines.length === 0) {
                const rawLines = await TflApiClient.getLinesByMode(mode);
                const nowTs = nowMs();
                const batch = db.batch();
                rawLines.forEach(l => {
                    const docRef = db.collection('lines').doc(l.id);
                    batch.set(docRef, { id: l.id, name: l.name, modeName: l.modeName, lastUpdatedTime: nowTs }, { merge: true });
                });
                await batch.commit();
                lines = rawLines.map(l => LineController.decorateLine({
                    id: l.id, name: l.name, modeName: l.modeName,
                }));
            } else {
                // The Firestore documents are raw `{id, name, modeName}` and
                // were returned undecorated — so this path alone served no
                // colour and no label either. Same decoration as every other
                // path now, which is the point of having one.
                lines = lines.map(l => LineController.decorateLine(l));
            }

            return res.json(lines.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name)));
        } catch (error) {
            console.error(`Error fetching lines for mode ${req.params.mode}:`, error);
            return res.status(500).json([{ id: "piccadilly", label: "Piccadilly", name: "Piccadilly" }]);
        }
    }

    /**
     * @swagger
     * /lines/{lineId}/route:
     *   get:
     *     summary: Get Line Route
     *     description: Retrieves the ordered route of stations for a specific line, including branches.
     *     tags: [Lines]
     *     parameters:
     *       - in: path
     *         name: lineId
     *         required: true
     *         schema:
     *           type: string
     *       - in: query
     *         name: station
     *         required: false
     *         description: >
     *           Naptan id to make the sequence relative to. When supplied, every
     *           stop list starts at the stop AFTER this station and runs to its
     *           branch terminus, and directions not served from here are omitted.
     *         schema:
     *           type: string
     *       - in: query
     *         name: mode
     *         required: false
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: A list of directions and destinations for the line.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: object
     *                 properties:
     *                   id: { type: string, example: inbound }
     *                   directionName: { type: string, example: Southbound }
     *                   towards: { type: string, example: Russell Square }
     *                   label: { type: string, example: "Southbound towards Russell Square" }
     *                   secondaryLabel: { type: string, example: "Russell Square · Holborn" }
     *                   originStationId: { type: string, nullable: true, example: 940GZZLUKSX }
     *                   upcomingStations:
     *                     description: Display names of the shared trunk. Legacy shape.
     *                     type: array
     *                     items: { type: string }
     *                   upcomingStops:
     *                     description: >
     *                       Same stops as upcomingStations, same order and length,
     *                       carrying the naptan id. Index-aligned by construction.
     *                       Match on `id` — display names differ between the route
     *                       sequence and live predictions.
     *                     type: array
     *                     items:
     *                       type: object
     *                       properties:
     *                         id: { type: string, example: 940GZZLURSQ }
     *                         name: { type: string, example: Russell Square }
     *                   destinations:
     *                     type: array
     *                     items:
     *                       type: object
     *                       properties:
     *                         id: { type: string, example: 940GZZLUHR5 }
     *                         label: { type: string, example: Heathrow Terminal 5 }
     *                         name: { type: string, example: Heathrow Terminal 5 }
     *                         upcomingStations:
     *                           type: array
     *                           items: { type: string }
     *                         upcomingStops:
     *                           description: >
     *                             Full ordered run from the origin station to this
     *                             terminus, inclusive of the terminus, with naptan ids.
     *                           type: array
     *                           items:
     *                             type: object
     *                             properties:
     *                               id: { type: string }
     *                               name: { type: string }
     *       404:
     *         description: Route not found
     */
    static async getLineRoute(req: Request, res: Response) {
        try {
            const lineId = req.params.lineId;
            const { station, mode } = req.query as Record<string, string>;
            
            // Read cascade (see docs/DATA_CACHE_ARCHITECTURE.md):
            //   memory → SQLite (local slave) → Firestore (master) → TfL.
            // Each layer warms the faster ones so the next request is cheaper,
            // and we only ever touch Firestore/TfL on a genuine miss.

            // 1. In-memory serving layer.
            let routeData: any = DataCacheService.getRoute(lineId);
            if (routeData) {
                console.log(`DATA: 🔵 Route memory HIT (${lineId})`);
            }

            // 2. SQLite slave — survives redeploy/memory-clear and avoids a
            //    Firestore read. Warm memory on hit.
            if (!routeData) {
                try {
                    const row = await LocalDbService.get<{ raw_data: string }>(
                        'SELECT raw_data FROM routes WHERE id = ?', [lineId]
                    );
                    if (row?.raw_data) {
                        routeData = JSON.parse(row.raw_data) as LineRouteResponse;
                        DataCacheService.setRoute(lineId, routeData);
                        console.log(`DATA: 📁 Route SQLite HIT (${lineId})`);
                    }
                } catch {
                    console.warn(`DATA: ⚠️ Route SQLite read failed (${lineId})`);
                }
            }

            // 3. Firestore master — only if the local slave missed. Back-fill
            //    memory + SQLite (the onSnapshot listener won't fire for a doc
            //    whose lastUpdatedTime predates boot).
            if (!routeData) {
                console.log(`DATA: ⚪ Route local MISS (${lineId}) — checking Firestore…`);
                try {
                    const doc = await db.collection('routes').doc(lineId).get();
                    if (doc.exists) {
                        routeData = doc.data() as LineRouteResponse;
                        DataCacheService.setRoute(lineId, routeData);
                        await LocalDbService.upsertRoute(lineId, routeData);
                        console.log(`DATA: ☁️ Route Firestore HIT (${lineId})`);
                    }
                } catch (fsErr) {
                    console.warn(`DATA: ⚠️ Firestore route lookup failed (likely quota).`);
                }
            }

            // 3. TfL API fallback — fetch route + sequences inline
            if (!routeData) {
                console.log(`DATA: ⚪ Fetching route from TfL API for ${lineId}...`);
                try {
                    const raw = await TflApiClient.getLineRoute(lineId);
                    const sectionsArray: any[] = Array.isArray(raw) ? raw : (raw?.routeSections || []);

                    const dirMap: Record<string, { id: string; name: string }[]> = {};
                    sectionsArray.forEach((section: any) => {
                        const dir: string = (section.direction || 'outbound').toLowerCase();
                        if (!dirMap[dir]) dirMap[dir] = [];
                        if (section.destination && !dirMap[dir].find(d => d.id === section.destination)) {
                            dirMap[dir].push({ id: section.destination, name: section.destinationName || section.destination });
                        }
                    });

                    const directions = Object.entries(dirMap).map(([direction, destinations]) => ({ direction, destinations }));
                    const { sequences, stationNames } = await fetchSequences(lineId, directions);

                    const lineInfo = DataCacheService.getLinesByMode(mode || '').find(l => l.id === lineId);
                    const lineName = lineInfo?.name || (lineId.charAt(0).toUpperCase() + lineId.slice(1));
                    const resolvedMode = mode || lineInfo?.modeName || '';

                    routeData = {
                        id: lineId,
                        name: lineName,
                        modeName: resolvedMode,
                        directions,
                        sequences,
                        stationNames,
                        lastUpdatedTime: nowMs()
                    };

                    // Warm THIS instance's memory immediately so concurrent
                    // requests don't re-hit TfL, then persist to the Firestore
                    // MASTER asynchronously (don't block the response). The routes
                    // onSnapshot listener fans the write out to SQLite + memory
                    // (incl. other cluster instances) — see DATA_CACHE_ARCHITECTURE.md.
                    DataCacheService.setRoute(lineId, routeData);
                    db.collection('routes').doc(lineId)
                        .set(encodeRouteForFirestore(routeData), { merge: true })
                        .then(() => console.log(`DATA: ✅ Persisted route ${lineId} to Firestore (listener syncs SQLite+memory)`))
                        .catch(e => console.warn(`DATA: ⚠️ Route Firestore persist failed for ${lineId}: ${e?.message || e}`));
                } catch (tflErr) {
                    console.warn(`DATA: ⚠️ TfL route fetch failed for ${lineId}:`, tflErr);
                }
            }

            if (!routeData) {
                console.warn(`DATA: ⚠️ No route data for ${lineId}. Returning generic directions.`);
                return res.json([{ id: "inbound", label: "Inbound" }, { id: "outbound", label: "Outbound" }]);
            }

            // Reconstruct sequences from the Firestore-safe `sequencesJson` string
            // (Firestore can't store the raw nested arrays). No-op for routes that
            // already carry in-memory `sequences` (fresh TfL build); routes loaded
            // from Firestore/cache without it fall through to the TfL re-enrich below.
            routeData = decodeRouteFromFirestore(routeData);

            // Inline-enrich cached routes missing sequences or sparse stationNames
            // (must be synchronous so the first request already has next-stop data)
            const nameCount = Object.keys(routeData.stationNames || {}).length;
            if ((!routeData.sequences || nameCount < 10) && routeData.directions?.length > 0) {
                try {
                    console.log(`DATA: 🔄 Enriching sequences inline for ${lineId} (nameCount=${nameCount})`);
                    const { sequences, stationNames } = await fetchSequences(lineId, routeData.directions);
                    routeData = { ...routeData, sequences, stationNames, lastUpdatedTime: nowMs() };
                    DataCacheService.setRoute(lineId, routeData);
                    // Persist to Firestore master only (async); the listener syncs
                    // SQLite + memory. Don't block the response.
                    setImmediate(() => {
                        db.collection('routes').doc(lineId)
                            .set(encodeRouteForFirestore(routeData), { merge: true })
                            .catch(() => { /* non-critical */ });
                    });
                    console.log(`DATA: ✅ Inline-enriched sequences for ${lineId}`);
                } catch {
                    console.warn(`DATA: ⚠️ Could not enrich sequences inline for ${lineId}`);
                }
            }

            // Resolve the station's individual stop IDs (grouped station → sibling naptanIds)
            const stationIds = new Set<string>();
            if (station) {
                DataCacheService.stationsInGroup(station)
                    .forEach((s: any) => { if (s.naptanId) stationIds.add(s.naptanId); });
                // Include the caller's own id only if it names a real stop. It
                // used to be added unconditionally as "the representative", and
                // that is now wrong: the client sends a HUB, and a StopArea id
                // in a set of fetchable stops would be looked up against mode
                // metadata no station document has.
                if (stationIds.size === 0) stationIds.add(station);
            }

            // Filter directions to those the station actually serves (mode metadata)
            let stationDirections: Set<string> | null = null;
            if (station && mode) {
                const dirs = new Set<string>();
                for (const sid of stationIds) {
                    const stn = DataCacheService.getAllStations().find((s: any) => s.naptanId === sid);
                    const lineData = (stn?.modes as any)?.[mode]?.lines?.[lineId];
                    (lineData?.directions || []).forEach((d: string) => dirs.add(d.toLowerCase()));
                }
                if (dirs.size > 0) stationDirections = dirs;
            }

            const sduiMappedDirections = (routeData.directions || [])
                .filter((dir: any) => !stationDirections || stationDirections.has((dir.direction || '').toLowerCase()))
                .map((dir: any) => {
                    const branches: string[][] = routeData.sequences?.[dir.direction] || [];
                    const names: Record<string, string> = routeData.stationNames || {};

                    // Per-branch downstream RUNS from the user's station:
                    // { terminusId, stops[] }. A junction (e.g. Earl's Court) yields
                    // several runs — one per branch leaving the station.
                    //
                    // `stops` carries {id, name} pairs rather than names alone: a
                    // client filtering "show me trains that call at X" has to match
                    // the naptan id a prediction reports, and display names do not
                    // survive that comparison (the route sequence says
                    // "Hammersmith (Dist&Picc Line)" where a prediction says
                    // "Hammersmith"). The name list is derived from these pairs so
                    // the two arrays stay index-aligned.
                    const runs: { terminusId: string; stops: RouteStop[] }[] = [];
                    if (station && branches.length > 0) {
                        for (const branch of branches) {
                            let idx = -1;
                            for (const sid of stationIds) { idx = branch.indexOf(sid); if (idx >= 0) break; }
                            if (idx >= 0 && idx < branch.length - 1) {
                                runs.push({
                                    terminusId: branch[branch.length - 1],
                                    stops: stopsFor(branch.slice(idx + 1), names),
                                });
                            }
                        }
                    }

                    // Reachable destinations = downstream branch termini. With a
                    // station filter and nothing reachable, this direction isn't
                    // served from here → drop it entirely.
                    let reachableDestinations = dir.destinations || [];
                    if (station && branches.length > 0 && dir.destinations?.length > 0) {
                        const reachableIds = new Set(runs.map(r => r.terminusId));
                        if (reachableIds.size > 0) {
                            reachableDestinations = dir.destinations.filter((d: any) => reachableIds.has(d.id));
                        } else {
                            return null;
                        }
                    }

                    // Each destination chip carries ITS OWN branch stops in
                    // `upcomingStations`, so the client can swap the timeline when
                    // the chip is tapped. If several runs share a terminus, take
                    // the longest (most informative).
                    const destChips: DestinationChip[] = reachableDestinations.map((d: any) => {
                        const matching = runs
                            .filter(r => r.terminusId === d.id)
                            .sort((a, b) => b.stops.length - a.stops.length);
                        const stops: RouteStop[] = matching[0]?.stops || [];
                        return {
                            id: d.id,
                            label: formatDestination(d.name),
                            name: formatDestination(d.name),
                            // Legacy shape — unchanged values, unchanged order.
                            upcomingStations: stops.map(s => s.name),
                            // ADDITIVE: same stops, same order, with naptan ids.
                            // Index-aligned with `upcomingStations` by construction.
                            // Existing clients parse with ignoreUnknownKeys and skip it.
                            upcomingStops: stops,
                        };
                    });

                    // DEFAULT timeline = the common trunk shared by ALL reachable
                    // branches. One branch → the whole branch; a hard junction →
                    // empty (client prompts the user to tap a destination).
                    // Computed from the {id, name} pairs, so the trunk is matched
                    // on naptan id rather than on formatted display text.
                    const branchStopLists = destChips
                        .map(d => d.upcomingStops)
                        .filter(s => s.length > 0);
                    const commonStops = runs.length > 0 ? commonPrefix(branchStopLists) : [];
                    const commonStations = commonStops.map(s => s.name);

                    // 'towards' priority (unchanged): the stop's TfL Towards →
                    // first common stop → first reachable terminus.
                    let towardsLabel = '';
                    if (stationIds.size > 0) {
                        for (const sid of stationIds) {
                            const stn = DataCacheService.getAllStations().find(s => s.naptanId === sid);
                            if (stn && stn.towards) {
                                const lineDetails = stn.modes?.[routeData.modeName]?.lines?.[lineId];
                                const servesDir = lineDetails?.directions?.some((d: string) => d.toLowerCase() === dir.direction.toLowerCase());
                                if (servesDir) { towardsLabel = stn.towards; break; }
                            }
                        }
                    }
                    if (!towardsLabel && commonStations.length > 0) towardsLabel = commonStations[0];
                    if (!towardsLabel && reachableDestinations.length > 0) towardsLabel = formatDestination(reachableDestinations[0].name);

                    const compassDir = getCompassDirection(lineId, dir.direction, routeData.modeName);
                    const label = towardsLabel
                        ? (routeData.modeName === 'bus' ? `Towards ${towardsLabel}` : `${compassDir} towards ${towardsLabel}`)
                        : compassDir;

                    return {
                        id: dir.direction,
                        directionName: compassDir,
                        towards: towardsLabel,
                        label,
                        secondaryLabel: commonStations.join(' · '),
                        destinations: destChips,          // each chip has its own branch stops
                        upcomingStations: commonStations, // default timeline = shared trunk
                        // ADDITIVE: the trunk with naptan ids, index-aligned with
                        // `upcomingStations`.
                        upcomingStops: commonStops,
                        // The station this sequence is relative to. Every stop list
                        // above starts at the stop AFTER this one, so a client
                        // reading a cached payload can tell which origin it was
                        // built for instead of inferring it from the request it no
                        // longer has.
                        originStationId: station || null,
                    };
                })
                .filter((d: any): d is Exclude<any, null> => d !== null);

            return res.json(sduiMappedDirections);
        } catch (error) {
            console.error(`Error fetching line route for lineId ${req.params.lineId}:`, error);
            return res.status(500).json([{ id: "inbound", label: "Inbound" }, { id: "outbound", label: "Outbound" }]);
        }
    }

    /**
     * @swagger
     * /lines/status:
     *   get:
     *     summary: Get line statuses
     *     description: Retrieves the latest status for all TFL transport lines. Supports filtering by lineId and mode.
     *     tags: [Lines]
     *     parameters:
     *       - in: query
     *         name: lineId
     *         schema:
     *           type: string
     *       - in: query
     *         name: mode
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: A list of line statuses.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/LineStatus'
     */
    static async getLineStatuses(req: Request, res: Response) {
        try {
            const { lineId, mode, skipRefresh } = req.query;
            const shouldSkipRefresh = skipRefresh === 'true';

            // A concrete line, as opposed to the literal `{lineId}` swagger
            // placeholder the docs UI sends.
            const wantedLine = lineId && !String(lineId).includes('{') ? String(lineId) : undefined;
            const known = wantedLine ? DataCacheService.getLineById(wantedLine) : undefined;

            // Unknown line → 404, matching what the station endpoint does for an
            // unknown naptanId. We hold the full line set in memory, so this is a
            // Map lookup — and it saves the caller from a 200 with an empty array,
            // which is indistinguishable from "this line has no status yet".
            if (wantedLine && !known) {
                return res.status(404).json({
                    error: "Line not found",
                    message: `No line with id '${wantedLine}'.`,
                    lineId: wantedLine,
                });
            }

            // Prefer the line's OWN mode over the query param. Statuses are
            // cached and fetched per mode, so asking for a bus line without
            // specifying `mode` used to search the default 'tube' set and
            // silently return nothing.
            const modeStr = known?.modeName || (mode as string) || 'tube';

            // 1. In-memory cache — the ONLY store. Fed by the Syncer pushing to
            //    /internal/line-status-updates, and by the TfL fallback below.
            //    The Firestore listener and the SQLite tier were both removed:
            //    the listener billed a document read per change forever, and
            //    once it was gone SQLite was persisting data nothing read back.
            let cachedStatuses = DataCacheService.getLineStatuses(modeStr);

            // 2. Refresh from TfL when the cache is EMPTY or STALE (>60s) —
            //    the safety net for a delayed or down Syncer. Single-flighted
            //    per mode and change-detected; see ensureLineStatuses.
            if (!shouldSkipRefresh) {
                // Passing the specific line matters: the cache fills from the
                // Syncer's pushes, which carry only CHANGED lines, so after a
                // backend restart the mode is routinely non-empty yet missing
                // most of it. Without this a request for an unchanged line
                // returned [] until the staleness gate happened to trip.
                await LineController.ensureLineStatuses(modeStr, wantedLine ? [wantedLine] : []);
                cachedStatuses = DataCacheService.getLineStatuses(modeStr);
            }

            if (wantedLine) {
                cachedStatuses = cachedStatuses.filter((s: any) => s.id === wantedLine);
            }

            // API boundary: the watermark is an integer internally; clients
            // (e.g. the mobile LineStatus.lastUpdatedTime: String) expect ISO.
            // `toEpochMs` first because producers disagree on the type — the
            // Syncer's ingest sends epoch millis (a Java Long), the TfL fallback
            // sets nowMs() — and coercing both here keeps the wire shape stable.
            return res.json(cachedStatuses.map((s: any) => ({
                ...s,
                lastUpdatedTime: toIso(toEpochMs(s.lastUpdatedTime)),
            })));
        } catch (error) {
            console.error("Error fetching line statuses:", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
}
