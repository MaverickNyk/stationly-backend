import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatDestination } from '../utils/formatters';
import { LineInfo, LineRouteResponse, LineStatusResponse, TransportMode } from '../models';

import { GOOD_SERVICE_MESSAGES, TFL_LINE_COLORS } from '../utils/tflUtils';
import { DataCacheService } from '../services/dataCacheService';
import { LocalDbService } from '../services/localDbService';
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

/** Map a run of naptan ids to display names (cache fallback + formatting). */
function namesFor(ids: string[], stationNames: Record<string, string>): string[] {
    return ids
        .map(id => {
            if (stationNames[id]) return stationNames[id];
            const cached = DataCacheService.getAllStations().find((s: any) => s.naptanId === id);
            return cached?.commonName;
        })
        .filter((n): n is string => Boolean(n))
        .map(n => formatDestination(n));
}

/** Longest common ordered prefix across several stop lists — the shared trunk
 *  all branches travel before they diverge. Empty at a hard junction. */
function commonPrefix(lists: string[][]): string[] {
    if (lists.length === 0) return [];
    if (lists.length === 1) return lists[0];
    const out: string[] = [];
    const first = lists[0];
    for (let i = 0; i < first.length; i++) {
        const v = first[i];
        if (lists.every(l => l[i] === v)) out.push(v); else break;
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

function assignGoodServiceReason(statusSeverityDescription: string, currentReason?: string): string {
    if (statusSeverityDescription?.toLowerCase() === 'good service' && (!currentReason || currentReason.trim() === '')) {
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
    static async getLinesByMode(req: Request, res: Response) {
        try {
            const mode = req.params.mode;
            const station = req.query.station as string;
            
            // --- Filter by specific Station if provided (Discovery Mode) ---
            // Aggregates lines from ALL stops in the same group (icsCode / stationNaptan),
            // so that grouped bus stops show the full set of routes at that location.
            if (station && !station.includes('{station}')) {
                console.log(`DATA: 🔍 Filtering lines for station ${station} (Discovery Mode) using Cache`);
                const repr = DataCacheService.getAllStations().find(s => s.naptanId === station || (s as any).id === station);

                if (repr) {
                    const groupKey = DataCacheService.getGroupKey(repr);
                    const siblings = DataCacheService.getAllStations().filter(
                        s => DataCacheService.getGroupKey(s) === groupKey
                    );

                    const lineIdsAtStation = new Set<string>();
                    siblings.forEach(sib => {
                        const modeData = sib.modes?.[mode];
                        if (modeData) Object.keys(modeData.lines).forEach(id => lineIdsAtStation.add(id));
                    });

                    if (lineIdsAtStation.size > 0) {
                        const allLines = DataCacheService.getLinesByMode(mode);
                        const filteredLines = allLines
                            .filter(l => lineIdsAtStation.has(l.id))
                            .map(l => ({ ...l, label: l.name, color: TFL_LINE_COLORS[l.id] || null }));

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
                const sduiLines = cachedLines.map(l => ({
                    ...l,
                    label: l.name || l.label,
                    color: TFL_LINE_COLORS[l.id] || null
                }));
                return res.json(sduiLines.sort((a, b) => a.label.localeCompare(b.label)));
            }

            // Deep Fallback: Firestore
            const snapshot = await db.collection('lines').where('modeName', '==', mode).get();
            let lines: any[] = [];
            snapshot.forEach(doc => lines.push({ id: doc.id, ...doc.data() as any }));

            if (lines.length === 0) {
                const rawLines = await TflApiClient.getLinesByMode(mode);
                const nowIso = new Date().toISOString();
                const batch = db.batch();
                rawLines.forEach(l => {
                    const docRef = db.collection('lines').doc(l.id);
                    batch.set(docRef, { id: l.id, name: l.name, modeName: l.modeName, lastUpdatedTime: nowIso }, { merge: true });
                });
                await batch.commit();
                lines = rawLines.map(l => ({
                    id: l.id,
                    name: l.name,
                    modeName: l.modeName,
                    label: l.name,
                    color: TFL_LINE_COLORS[l.id] || null
                }));
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
     *                   label: { type: string, example: "Inbound towards\nCockfosters" }
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
                        lastUpdatedTime: new Date().toISOString()
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
                    routeData = { ...routeData, sequences, stationNames, lastUpdatedTime: new Date().toISOString() };
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
                const repr = DataCacheService.getAllStations().find(
                    (s: any) => s.naptanId === station || s.id === station
                );
                if (repr) {
                    const groupKey = DataCacheService.getGroupKey(repr);
                    DataCacheService.getAllStations()
                        .filter((s: any) => DataCacheService.getGroupKey(s) === groupKey)
                        .forEach((s: any) => { if (s.naptanId) stationIds.add(s.naptanId); });
                }
                stationIds.add(station); // always include the representative itself
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
                    const runs: { terminusId: string; stops: string[] }[] = [];
                    if (station && branches.length > 0) {
                        for (const branch of branches) {
                            let idx = -1;
                            for (const sid of stationIds) { idx = branch.indexOf(sid); if (idx >= 0) break; }
                            if (idx >= 0 && idx < branch.length - 1) {
                                runs.push({
                                    terminusId: branch[branch.length - 1],
                                    stops: namesFor(branch.slice(idx + 1), names),
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
                    const destChips = reachableDestinations.map((d: any) => {
                        const matching = runs
                            .filter(r => r.terminusId === d.id)
                            .sort((a, b) => b.stops.length - a.stops.length);
                        return {
                            id: d.id,
                            label: formatDestination(d.name),
                            name: formatDestination(d.name),
                            upcomingStations: matching[0]?.stops || [],
                        };
                    });

                    // DEFAULT timeline = the common trunk shared by ALL reachable
                    // branches. One branch → the whole branch; a hard junction →
                    // empty (client prompts the user to tap a destination).
                    const branchStopLists = destChips.map((d: any) => d.upcomingStations).filter((s: string[]) => s.length > 0);
                    const commonStations = runs.length > 0 ? commonPrefix(branchStopLists) : [];

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
            const { lineId, mode } = req.query;
            const modeStr = mode as string || 'tube';

            // 1. Try to read from in-memory Cache (synced in real-time with Firestore)
            let cachedStatuses = DataCacheService.getLineStatuses(modeStr);
            
            // 2. If Cache is empty (e.g., cold start/failed listener), load from SQLite
            if (cachedStatuses.length === 0) {
                console.log(`STATUS: 📁 Cache MISS for ${modeStr} statuses. Loading from local SQLite...`);
                try {
                    const localRows = await LocalDbService.all<{ raw_data: string }>(
                        'SELECT raw_data FROM line_statuses WHERE mode = ?',
                        [modeStr]
                    );
                    if (localRows.length > 0) {
                        localRows.forEach(row => {
                            const status = JSON.parse(row.raw_data);
                            DataCacheService.setLineStatus(status.id, status);
                        });
                        cachedStatuses = DataCacheService.getLineStatuses(modeStr);
                    }
                } catch (dbErr: any) {
                    console.warn(`STATUS: ⚠️ SQLite query failed: ${dbErr.message}`);
                }
            }

            // 3. If Cache and SQLite are BOTH empty, fetch from TfL as a last-resort fallback
            if (cachedStatuses.length === 0) {
                console.log(`STATUS: ⚪ Cold cache & SQLite miss. Fetching from TfL...`);
                const rawStatuses = await TflApiClient.getLineStatuses(modeStr);
                const nowIso = new Date().toISOString();

                for (const ls of rawStatuses) {
                    let selectedStatus = ls.lineStatuses?.[0];
                    if (ls.lineStatuses && ls.lineStatuses.length > 1) {
                        let maxPriority = -1;
                        for (const status of ls.lineStatuses) {
                            const severity = status.statusSeverity;
                            if (severity !== undefined && severity !== null) {
                                const priority = getSeverityPriority(Number(severity));
                                if (priority > maxPriority) {
                                    maxPriority = priority;
                                    selectedStatus = status;
                                }
                            }
                        }
                    }

                    const status: LineStatusResponse = {
                        id: ls.id,
                        name: ls.name,
                        statusSeverityDescription: selectedStatus?.statusSeverityDescription || "Unknown",
                        reason: assignGoodServiceReason(
                            selectedStatus?.statusSeverityDescription,
                            selectedStatus?.reason
                        ),
                        mode: ls.modeName,
                        lastUpdatedTime: nowIso
                    };

                    DataCacheService.setLineStatus(ls.id, status);
                    await LocalDbService.upsertLineStatus(ls.id, status);
                }
                cachedStatuses = DataCacheService.getLineStatuses(modeStr);
            }

            // Filter results by lineId if requested
            if (lineId && !String(lineId).includes('{')) {
                cachedStatuses = cachedStatuses.filter((s: any) => s.id === lineId);
            }

            return res.json(cachedStatuses);
        } catch (error) {
            console.error("Error fetching line statuses:", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
}
