import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatDestination } from '../utils/formatters';
import { LineInfo, LineRouteResponse, LineStatusResponse, TransportMode } from '../models';

import { GOOD_SERVICE_MESSAGES } from '../utils/tflUtils';
import { DataCacheService } from '../services/dataCacheService';

// Official TfL brand colors by line ID
const TFL_LINE_COLORS: Record<string, string> = {
    'bakerloo':           '#B36305',
    'central':            '#E32017',
    'circle':             '#FFD300',
    'district':           '#00782A',
    'hammersmith-city':   '#F3A9BB',
    'jubilee':            '#A0A5A9',
    'metropolitan':       '#9B0056',
    'northern':           '#000000',
    'piccadilly':         '#003688',
    'victoria':           '#0098D4',
    'waterloo-city':      '#95CDBA',
    'dlr':                '#00A4A7',
    'elizabeth':          '#6950A1',
    'london-overground':  '#EE7C0E', // legacy / fallback
    'lioness':            '#E2A12B', // Watford - Euston
    'mildmay':            '#1A6DB4', // Stratford - Richmond/Clapham Jct
    'windrush':           '#E2231A', // Clapham Jct - Highbury & Islington
    'weaver':             '#7B2D8B', // Liverpool St - Enfield/Cheshunt/Chingford
    'suffragette':        '#00843D', // Gospel Oak - Barking Riverside
    'liberty':            '#6B717E', // Romford - Upminster
    'tram':               '#84B817',
    'cable-car':          '#E21836',
};

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
            
            // --- NEW: Filter by specific Station if provided (Discovery Mode) ---
            if (station && !station.includes('{station}')) {
                console.log(`DATA: 🔍 Filtering lines for station ${station} (Discovery Mode) using Cache`);
                const stationData = DataCacheService.getAllStations().find(s => s.naptanId === station || s.id === station);
                
                if (stationData && stationData.modes && stationData.modes[mode]) {
                    const lineIdsAtStation = Object.keys(stationData.modes[mode].lines);
                    const allLines = DataCacheService.getLinesByMode(mode);
                    const filteredLines = allLines.filter(l => lineIdsAtStation.includes(l.id))
                        .map(l => ({ ...l, label: l.name, color: TFL_LINE_COLORS[l.id] || null }));
                    
                    if (filteredLines.length > 0) {
                        return res.json(filteredLines.sort((a, b) => a.label.localeCompare(b.label)));
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

            // Fallback: If still nothing, return basic directions
            if (!routeData) {
                console.warn(`DATA: ⚠️ No route data for ${lineId}. Returning generic directions.`);
                return res.json([{ id: "inbound", label: "Inbound" }, { id: "outbound", label: "Outbound" }]);
            }

            // Map the routeData for SDUI so it receives a flat array of formatted directions
            const sduiMappedDirections = (routeData.directions || []).map((dir: any) => {
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
            const modeStr = mode as string || 'tube'; // Default to tube if no mode provided
            
            // Check cache freshness (using a sample doc if filtering by mode)
            const collectionRef = db.collection('lineStatuses');
            let cacheCheckQuery: any = collectionRef;
            if (modeStr) cacheCheckQuery = cacheCheckQuery.where('mode', '==', modeStr);
            
            const snapshot = await cacheCheckQuery.limit(1).get();
            let needsRefresh = snapshot.empty;
            
            if (!snapshot.empty) {
                const latestDoc = snapshot.docs[0].data();
                const lastUpdated = new Date(latestDoc.lastUpdatedTime).getTime();
                if (Date.now() - lastUpdated > 30000) {
                    needsRefresh = true;
                }
            }

            if (needsRefresh) {
                console.log(`STATUS: ⚪ Cache MISS/OLD for ${modeStr} statuses. Fetching from TfL...`);
                const rawStatuses = await TflApiClient.getLineStatuses(modeStr);
                
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
                    const docRef = collectionRef.doc(ls.id);
                    batch.set(docRef, status);
                });
                
                await batch.commit();
                console.log(`STATUS: ✅ Saved fresh ${modeStr} statuses to Firestore`);
            }

            // Final query after potential refresh
            let query: any = collectionRef;
            if (mode) query = query.where('mode', '==', mode);
            if (lineId) query = query.where('id', '==', lineId);
            
            const finalSnapshot = await query.get();
            const results = finalSnapshot.docs.map((d: any) => d.data());
            
            return res.json(results);
        } catch (error) {
            console.error("Error fetching line statuses:", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
}
