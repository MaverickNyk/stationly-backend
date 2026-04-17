import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatDestination } from '../utils/formatters';
import { LineInfo, LineRouteResponse, LineStatusResponse, TransportMode } from '../models';

import { GOOD_SERVICE_MESSAGES, TFL_LINE_COLORS } from '../utils/tflUtils';
import { DataCacheService } from '../services/dataCacheService';
import { LocalDbService } from '../services/localDbService';

function assignGoodServiceReason(statusSeverityDescription: string, currentReason?: string): string {
    if (statusSeverityDescription?.toLowerCase() === 'good service' && (!currentReason || currentReason.trim() === '')) {
        const index = Math.floor(Math.random() * GOOD_SERVICE_MESSAGES.length);
        return GOOD_SERVICE_MESSAGES[index];
    }
    return currentReason || '';
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
            
            // 1. Try Memory Cache first (SQLite populated)
            let routeData = DataCacheService.getRoute(lineId);
            
            if (routeData) {
                console.log(`DATA: 🔵 Cache HIT for route (lineId: ${lineId})`);
            } else {
                console.log(`DATA: ⚪ Cache MISS for route (lineId: ${lineId}). Checking Firestore...`);
                // 2. Try Firestore if not in local cache (only if quota allows)
                try {
                    const doc = await db.collection('routes').doc(lineId).get();
                    if (doc.exists) {
                        routeData = doc.data() as LineRouteResponse;
                    }
                } catch (fsErr) {
                    console.warn(`DATA: ⚠️ Firestore Route lookup failed (likely quota).`);
                }
            }

            // 3. TfL API fallback — fetch, parse, and save
            if (!routeData) {
                console.log(`DATA: ⚪ Fetching route from TfL API for ${lineId}...`);
                try {
                    const raw = await TflApiClient.getLineRoute(lineId);
                    const sectionsArray: any[] = Array.isArray(raw) ? raw : (raw?.routeSections || []);

                    // Group routeSections by direction, collect unique destinations
                    const dirMap: Record<string, { id: string; name: string }[]> = {};
                    sectionsArray.forEach((section: any) => {
                        const dir: string = (section.direction || 'outbound').toLowerCase();
                        if (!dirMap[dir]) dirMap[dir] = [];
                        if (section.destination && !dirMap[dir].find(d => d.id === section.destination)) {
                            dirMap[dir].push({ id: section.destination, name: section.destinationName || section.destination });
                        }
                    });

                    const directions = Object.entries(dirMap).map(([direction, destinations]) => ({ direction, destinations }));
                    routeData = { directions, lastUpdatedTime: new Date().toISOString() };

                    // Save to Firestore
                    await db.collection('routes').doc(lineId).set(routeData);
                    console.log(`DATA: ✅ Saved route for ${lineId} to Firestore (${directions.length} directions)`);
                } catch (tflErr) {
                    console.warn(`DATA: ⚠️ TfL route fetch failed for ${lineId}:`, tflErr);
                }
            }

            if (!routeData) {
                console.warn(`DATA: ⚠️ No route data for ${lineId}. Returning generic directions.`);
                return res.json([{ id: "inbound", label: "Inbound" }, { id: "outbound", label: "Outbound" }]);
            }

            // If station is provided, collect which directions it actually serves for this line
            let stationDirections: Set<string> | null = null;
            if (station && mode) {
                const repr = DataCacheService.getAllStations().find(
                    (s: any) => s.naptanId === station || s.id === station
                );
                if (repr) {
                    const groupKey = DataCacheService.getGroupKey(repr);
                    const siblings = DataCacheService.getAllStations().filter(
                        (s: any) => DataCacheService.getGroupKey(s) === groupKey
                    );
                    const dirs = new Set<string>();
                    for (const sib of siblings) {
                        const lineData = (sib.modes as any)?.[mode]?.lines?.[lineId];
                        (lineData?.directions || []).forEach((d: string) => dirs.add(d.toLowerCase()));
                    }
                    if (dirs.size > 0) stationDirections = dirs;
                }
            }

            // Map the routeData for SDUI so it receives a flat array of formatted directions
            const sduiMappedDirections = (routeData.directions || [])
                .filter((dir: any) => !stationDirections || stationDirections.has((dir.direction || '').toLowerCase()))
                .map((dir: any) => {
                const dirName = dir.direction ? (dir.direction.charAt(0).toUpperCase() + dir.direction.slice(1)) : '';
                let label = `${dirName} towards`;
                if (dir.destinations && dir.destinations.length > 0) {
                    const destNames = dir.destinations.map((d: any) => formatDestination(d.name)).join('\n');
                    label = `${dirName} towards\n${destNames}`;
                }
                return {
                    id: dir.direction,
                    label: label
                };
            });

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

            // 1. Check in-memory cache freshness (30s TTL)
            let cachedStatuses = DataCacheService.getLineStatuses(modeStr);
            if (lineId && !String(lineId).includes('{')) {
                cachedStatuses = cachedStatuses.filter((s: any) => s.id === lineId);
            }

            const isFresh = cachedStatuses.length > 0 &&
                cachedStatuses.every((s: any) => s.lastUpdatedTime && (Date.now() - new Date(s.lastUpdatedTime).getTime()) < 30000);

            if (isFresh) {
                console.log(`STATUS: 🔵 Cache HIT for ${modeStr} statuses (${cachedStatuses.length} results)`);
                return res.json(cachedStatuses);
            }

            // 2. Fetch fresh data from TfL
            console.log(`STATUS: ⚪ Cache MISS/OLD for ${modeStr} statuses. Fetching from TfL...`);
            const rawStatuses = await TflApiClient.getLineStatuses(modeStr);

            const collectionRef = db.collection('lineStatuses');
            const batch = db.batch();
            const nowIso = new Date().toISOString();

            rawStatuses.forEach(ls => {
                const status: LineStatusResponse = {
                    id: ls.id,
                    name: ls.name,
                    statusSeverityDescription: ls.lineStatuses[0]?.statusSeverityDescription || "Unknown",
                    reason: assignGoodServiceReason(
                        ls.lineStatuses[0]?.statusSeverityDescription,
                        ls.lineStatuses[0]?.reason
                    ),
                    mode: ls.modeName,
                    lastUpdatedTime: nowIso
                };

                // 3. Update in-memory cache immediately
                DataCacheService.setLineStatus(ls.id, status);

                // 4. Save to Firestore (batch)
                batch.set(collectionRef.doc(ls.id), status);
            });

            await batch.commit();

            // 5. Save to SQLite (background, non-blocking)
            setImmediate(async () => {
                for (const ls of rawStatuses) {
                    const status = DataCacheService.getLineStatuses().find((s: any) => s.id === ls.id);
                    if (status) await LocalDbService.upsertLineStatus(ls.id, status);
                }
            });

            console.log(`STATUS: ✅ Saved fresh ${modeStr} statuses (${rawStatuses.length} lines)`);

            // Return filtered results
            let results = DataCacheService.getLineStatuses(modeStr);
            if (lineId && !String(lineId).includes('{')) {
                results = results.filter((s: any) => s.id === lineId);
            }
            return res.json(results);
        } catch (error) {
            console.error("Error fetching line statuses:", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
}
