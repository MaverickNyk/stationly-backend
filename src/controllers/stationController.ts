import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { SubscriptionService } from '../services/subscriptionService';
import { Station, StationPredictionResponse, LinePredictions, DirectionPredictions } from '../models';
import { DataCacheService } from '../services/dataCacheService';
import { TFL_LINE_COLORS } from '../utils/tflUtils';

function formatDistance(meters: number): string {
    const miles = meters / 1609.34;
    return miles < 0.1 ? `${meters}m` : `${miles.toFixed(1)} mi`;
}

function isBusStation(s: any): boolean {
    return s.modes && Object.keys(s.modes).includes('bus');
}

function lineTags(s: any, mode?: string): string[] | undefined {
    const modeData = mode ? s.modes?.[mode] : null;
    if (!modeData?.lines) return undefined;
    const colors = Object.keys(modeData.lines)
        .map((id: string) => TFL_LINE_COLORS[id])
        .filter((c): c is string => Boolean(c));
    return colors.length > 0 ? colors : undefined;
}

export class StationController {
    /**
     * @swagger
     * /stations/resolve:
     *   get:
     *     summary: Resolve exact stop from station group
     *     description: |
     *       Given the representative naptanId of a grouped station, plus a mode / line / direction,
     *       returns the exact physical stop (naptanId) within that group that serves the route.
     *       Used after the user has selected a grouped station, a line, and a direction.
     *     tags: [Stations]
     *     parameters:
     *       - { in: query, name: station,   required: true,  schema: { type: string } }
     *       - { in: query, name: mode,      required: true,  schema: { type: string } }
     *       - { in: query, name: line,      required: true,  schema: { type: string } }
     *       - { in: query, name: direction, required: true,  schema: { type: string } }
     *     responses:
     *       200:
     *         description: "{ naptanId: string }"
     */
    static resolveStation(req: Request, res: Response) {
        const { station, mode, line, direction } = req.query as Record<string, string>;
        if (!station || !mode || !line || !direction) {
            return res.status(400).json({ error: "station, mode, line and direction are required" });
        }
        const naptanId = DataCacheService.resolveStation(station, mode, line, direction);
        return res.json({ naptanId });
    }

    /**
     * @swagger
     * /stations/subscribed-ids:
     *   get:
     *     summary: Get Subscribed Station IDs
     *     tags: [Stations]
     *     responses:
     *       200:
     *         description: List of subscribed Naptan IDs
     */
    static getSubscribedStationIds(req: Request, res: Response) {
        if (!SubscriptionService.getIsReady()) {
            console.log("PRED: ⚠️ Subscription registry not yet ready, serving empty list.");
            return res.json([]);
        }
        const ids = SubscriptionService.getSubscribedStationIds();
        return res.json(ids);
    }

    /**
     * @swagger
     * /stations/predictions/{naptanId}:
     *   get:
     *     summary: Get Station Predictions
     *     tags: [Stations]
     */
    static async getStationPredictions(req: Request, res: Response) {
        const { naptanId } = req.params;
        try {
            const predictions = await StationController.fetchPredictions(naptanId);
            return res.json(predictions);
        } catch (error) {
            console.error(`Error fetching predictions for ${naptanId}:`, error);
            return res.status(500).json({ error: "Failed to fetch predictions" });
        }
    }

    private static async fetchPredictions(naptanId: string): Promise<StationPredictionResponse> {
        console.log(`PRED: 📡 Fetching live signals for ${naptanId}...`);
        
        // 1. Fetch raw arrivals from TfL
        const arrivals = await TflApiClient.getArrivalsForStation(naptanId);
        
        // 2. Group by Line and Direction
        const lines: Record<string, LinePredictions> = {};
        
        arrivals.forEach(arrival => {
            const lineId = arrival.lineId.toLowerCase();
            const direction = arrival.direction || (arrival.platformName.toLowerCase().includes('inbound') ? 'inbound' : 'outbound');
            
            if (!lines[lineId]) {
                lines[lineId] = {
                    id: arrival.lineId,
                    name: arrival.lineName,
                    dirs: {}
                };
            }
            
            if (!lines[lineId].dirs[direction]) {
                lines[lineId].dirs[direction] = { preds: [] };
            }
            
            lines[lineId].dirs[direction].preds.push({
                destId: arrival.destinationNaptanId || 'unknown',
                platform: arrival.platformName,
                eta: arrival.expectedArrival,
                displayName: arrival.destinationName
            });
        });

        // 3. Sort predictions by ETA
        Object.values(lines).forEach((line: LinePredictions) => {
            Object.values(line.dirs).forEach((dir: DirectionPredictions) => {
                dir.preds.sort((a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime());
            });
        });

        return {
            id: naptanId,
            name: arrivals[0]?.stationName || "Unknown Station",
            lut: new Date().toISOString(),
            lines
        };
    }

    /**
     * @swagger
     * /stations/line/{lineId}:
     *   get:
     *     summary: Get Stations by Line
     *     description: Returns all stations on a given line. Served from in-memory cache (backed by SQLite). Falls back to Firestore if cache is not yet ready.
     *     tags: [Stations]
     *     parameters:
     *       - in: path
     *         name: lineId
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: List of stations on the line.
     */
    static async getStationsByLine(req: Request, res: Response) {
        const { lineId } = req.params;
        try {
            let stations = DataCacheService.getStationsByLine(lineId);

            // Fallback if cache not ready
            if (stations.length === 0 && !DataCacheService.getIsReady()) {
                const snapshot = await db.collection('stations')
                    .where('searchKeys', 'array-contains', lineId)
                    .get();

                stations = snapshot.docs.map(doc => {
                    const data = doc.data() as any;
                    return {
                        id: doc.id,
                        label: data.commonName || data.name || doc.id,
                        ...data
                    };
                });
            }

            const sduiOptions = stations.map(s => ({
                id: s.id || s.naptanId,
                label: s.commonName || s.label || (s as any).name || s.id,
                iconUrl: (s.modes && Object.keys(s.modes).includes('bus')) ? "https://img.icons8.com/color/48/bus.png" : null,
                color: null
            }));

            return res.json(sduiOptions);
        } catch (error) {
            return res.status(500).json({ error: "Failed to fetch stations" });
        }
    }

    /**
     * @swagger
     * /stations/search:
     *   get:
     *     summary: Search or Discover Nearby Stations
     *     description: |
     *       Unified station search endpoint served from the in-memory cache (backed by SQLite).
     *       - **Text search**: Pass `searchKey` to search by name or NaPTAN ID. Supports fuzzy matching.
     *       - **Nearby search**: Pass `lat` + `lon` to get all stations sorted by proximity.
     *         Also aliased at `/stations/nearby`.
     *     tags: [Stations]
     *     parameters:
     *       - in: query
     *         name: searchKey
     *         schema: { type: string }
     *         description: Station name or NaPTAN ID (supports fuzzy spelling).
     *       - in: query
     *         name: lat
     *         schema: { type: number }
     *       - in: query
     *         name: lon
     *         schema: { type: number }
     *       - in: query
     *         name: mode
     *         schema: { type: string }
     *         description: Optional mode filter (e.g. tube, bus).
     *     responses:
     *       200:
     *         description: List of matching stations as SDUI dropdown options.
     */
    static async searchStations(req: Request, res: Response) {
        const { searchKey, lat, lon, mode } = req.query;
        const modeFilter = mode ? String(mode) : undefined;

        try {
            // ── Text search ────────────────────────────────────────────────────────
            if (searchKey && !String(searchKey).includes('{')) {
                let stations: any[] = DataCacheService.searchStationsByQuery(String(searchKey));

                // Cold-start: cache not ready yet — fall back to Firestore
                if (stations.length === 0 && !DataCacheService.getIsReady()) {
                    console.log(`CACHE: ⚪ Cache not ready for '${searchKey}', querying Firestore`);
                    const snapshot = await db.collection('stations')
                        .where('searchKeys', 'array-contains', String(searchKey))
                        .get();
                    stations = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                }

                // Attach distances if caller supplied a location, then sort nearest-first
                const userLat = lat !== undefined ? Number(lat) : NaN;
                const userLon = lon !== undefined ? Number(lon) : NaN;
                if (!isNaN(userLat) && !isNaN(userLon)) {
                    stations = stations.map(s =>
                        s.lat && s.lon
                            ? { ...s, distance: DataCacheService.haversineMeters(userLat, userLon, s.lat, s.lon) }
                            : s
                    );
                    stations.sort((a, b) => (a.distance ?? 999999) - (b.distance ?? 999999));
                } else {
                    stations.sort((a, b) => (a.commonName || '').localeCompare(b.commonName || ''));
                }

                const grouped = DataCacheService.groupStations(stations);
                return res.json(grouped.slice(0, 50).map(s => ({
                    id: s.id || s.naptanId,
                    label: s.commonName || s.label || s.id,
                    iconUrl: isBusStation(s) ? 'https://img.icons8.com/color/48/bus.png' : null,
                    secondaryLabel: s.distance !== undefined ? formatDistance(s.distance) : undefined,
                    tags: lineTags(s, modeFilter),
                })));
            }

            // ── Nearby search ──────────────────────────────────────────────────────
            if (lat !== undefined && lon !== undefined) {
                const startLat = Number(lat);
                const startLon = Number(lon);
                if (isNaN(startLat) || isNaN(startLon)) return res.json([]);

                console.log(`DATA: 📍 Nearby: lat=${startLat}, lon=${startLon}, mode=${modeFilter ?? 'ANY'}`);

                let stations = DataCacheService.getNearbyStations(startLat, startLon, modeFilter);

                // Cold-start: cache not ready yet — fall back to Firestore
                if (stations.length === 0 && !DataCacheService.getIsReady()) {
                    console.log(`CACHE: ⚪ Cache not ready for nearby search, querying Firestore`);
                    const snapshot = await db.collection('stations').get();
                    snapshot.forEach(doc => {
                        const data = doc.data() as Station;
                        if (data.lat && data.lon) {
                            stations.push({
                                ...data,
                                id: doc.id,
                                distance: DataCacheService.haversineMeters(startLat, startLon, data.lat, data.lon),
                            });
                        }
                    });
                    stations.sort((a, b) => {
                        const d = a.distance - b.distance;
                        return d !== 0 ? d : (a.commonName || '').localeCompare(b.commonName || '');
                    });
                }

                const grouped = DataCacheService.groupStations(stations);
                grouped.sort((a, b) => {
                    const d = (a.distance ?? 999999) - (b.distance ?? 999999);
                    return d !== 0 ? d : (a.commonName || a.label || '').localeCompare(b.commonName || b.label || '');
                });

                return res.json(grouped.slice(0, 25).map(s => ({
                    id: s.id || s.naptanId,
                    label: s.label || s.commonName || s.id,
                    secondaryLabel: formatDistance(s.distance || 0),
                    iconUrl: isBusStation(s) ? 'https://img.icons8.com/color/48/bus.png' : null,
                    tags: lineTags(s, modeFilter),
                })));
            }

            // ── Mode-only fallback (no location) ───────────────────────────────────
            if (modeFilter) {
                const stations = DataCacheService.getStationsByMode(modeFilter);
                return res.json(stations.slice(0, 50).map(s => ({
                    id: s.id || s.naptanId,
                    label: s.commonName || s.label || s.id,
                })));
            }

            return res.json([]);
        } catch (error) {
            console.error('Error searching stations:', error);
            return res.status(500).json([]);
        }
    }
}
