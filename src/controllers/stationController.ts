import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { SubscriptionService } from '../services/subscriptionService';
import { Station, StationPredictionResponse, LinePredictions, DirectionPredictions } from '../models';
import { DataCacheService } from '../services/dataCacheService';

export class StationController {
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
     *       Unified station search endpoint. Served from in-memory cache (backed by SQLite).
     *       - **Text search**: Pass `searchKey` to search by station name or NaPTAN ID.
     *       - **Nearby search**: Pass `lat`, `lon`, and optional `radius` (km, default 2.41) to find nearby stations.
     *         Falls back to TfL API if results are sparse. Also aliased at `/stations/nearby`.
     *     tags: [Stations]
     *     parameters:
     *       - in: query
     *         name: searchKey
     *         schema: { type: string }
     *         description: Station name or NaPTAN ID to search.
     *       - in: query
     *         name: lat
     *         schema: { type: number }
     *       - in: query
     *         name: lon
     *         schema: { type: number }
     *       - in: query
     *         name: radius
     *         schema: { type: number }
     *         description: Search radius in km (max 2.41).
     *       - in: query
     *         name: mode
     *         schema: { type: string }
     *         description: Optional mode filter for nearby search (e.g. tube, bus).
     *     responses:
     *       200:
     *         description: List of matching stations.
     */
    static async searchStations(req: Request, res: Response) {
        const { searchKey, lat, lon, radius = 2.41, mode } = req.query;

        try {
            let stations: any[] = [];

            // 1. Semantic/Text Search
            if (searchKey && !String(searchKey).includes('{mode}')) {
                stations = DataCacheService.searchStationsByQuery(String(searchKey));
                
                // Firestore Fallback if cache is empty (initial load)
                if (stations.length === 0 && !DataCacheService.getIsReady()) {
                    console.log(`CACHE: ⚪ Cache not ready for searchKey '${searchKey}'. Checking Firestore...`);
                    const snapshot = await db.collection('stations')
                        .where('searchKeys', 'array-contains', String(searchKey))
                        .get();
                    stations = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                }

                stations.sort((a, b) => (a.commonName || "").localeCompare(b.commonName || ""));
                const sduiOptions = stations.slice(0, 50).map(s => ({
                    id: s.id || s.naptanId,
                    label: s.commonName || s.label || (s as any).name || s.id,
                    iconUrl: (s.modes && Object.keys(s.modes).includes('bus')) ? "https://img.icons8.com/color/48/bus.png" : null
                }));
                return res.json(sduiOptions);
            } 
            
            // 2. Nearby Search (Lat/Lon)
            else if (lat !== undefined && lon !== undefined) {
                const startLat = Number(lat);
                const startLon = Number(lon);
                
                if (isNaN(startLat) || isNaN(startLon)) {
                    console.log(`DATA: 📍 Nearby search ignored (NaN coords)`);
                    return res.json([]);
                }

                let radiusKm = Number(radius);
                if (radiusKm > 100) radiusKm = radiusKm / 1000;
                
                const MAX_RADIUS_KM = 2.41; 
                radiusKm = Math.min(radiusKm, MAX_RADIUS_KM);

                console.log(`DATA: 📍 Nearby search active: lat=${startLat}, lon=${startLon}, radius=${radiusKm}km, mode=${mode || 'ANY'}`);

                // Filter using in-memory cache
                stations = DataCacheService.getNearbyStations(startLat, startLon, radiusKm, mode as string);
                
                // Firestore Fallback if cache is empty (initial load)
                if (stations.length === 0 && !DataCacheService.getIsReady()) {
                    console.log(`CACHE: ⚪ Cache not ready for nearby search. Checking Firestore...`);
                    const snapshot = await db.collection('stations').get();
                    snapshot.forEach(doc => {
                        const data = doc.data() as Station;
                        if (data.lat && data.lon) {
                            const dLat = (data.lat - startLat) * (Math.PI / 180);
                            const dLon = (data.lon - startLon) * (Math.PI / 180);
                            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                                      Math.cos(startLat * (Math.PI / 180)) * Math.cos(data.lat * (Math.PI / 180)) *
                                      Math.sin(dLon / 2) * Math.sin(dLon / 2);
                            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                            const distance = 6371 * c;
                            if (distance <= radiusKm) {
                                stations.push({ ...data, id: doc.id, distance: Math.round(distance * 1000) });
                            }
                        }
                    });
                }

                // 3. Fallback to real TfL API if results are sparse
                if (stations.length < 5) {
                    console.log(`DATA: ⚪ Insufficient results (${stations.length}). Fetching from TfL API...`);
                    try {
                        const stopPoints = await TflApiClient.getNearbyStopPoints(startLat, startLon, radiusKm * 1000);
                        if (stopPoints && stopPoints.length > 0) {
                            const tflStations = stopPoints.map((sp: any) => ({
                                id: sp.naptanId,
                                label: `${sp.commonName || sp.name} (${sp.distance ? Math.round(sp.distance) : 0}m)`,
                                commonName: sp.commonName || sp.name,
                                naptanId: sp.naptanId,
                                lat: sp.lat,
                                lon: sp.lon,
                                distance: sp.distance ? Math.round(sp.distance) : 0,
                                modes: sp.modes || [],
                                stopType: sp.stopType || 'N/A'
                            }));
                            
                            const merged = [...stations];
                            tflStations.forEach((ts: any) => {
                                if (!merged.find(m => m.id === ts.id)) merged.push(ts);
                            });
                            stations = merged;

                            // Cache discoveries in Firestore (background)
                            setImmediate(async () => {
                                const batch = db.batch();
                                stopPoints.slice(0, 15).forEach((sp: any) => {
                                    const docRef = db.collection('stations').doc(sp.naptanId);
                                    batch.set(docRef, {
                                        naptanId: sp.naptanId,
                                        commonName: sp.commonName || sp.name,
                                        lat: sp.lat,
                                        lon: sp.lon,
                                        stopType: sp.stopType,
                                        modes: sp.modes || [],
                                        lastUpdated: new Date().toISOString()
                                    }, { merge: true });
                                });
                                await batch.commit();
                            });
                        }
                    } catch (err) {
                        console.error("TfL Fallback failed:", err);
                    }
                }

                // Final Sort: Closest first (Discovery requirement)
                stations.sort((a, b) => {
                    return (a.distance || 999999) - (b.distance || 999999);
                });
                
                const finalOptions = stations.slice(0, 25).map(s => {
                    const name = s.label || s.commonName || (s as any).name || s.id;
                    
                    // Convert meters to miles (1 mile = 1609.34 meters)
                    const distMeters = s.distance || 0;
                    const distMiles = distMeters / 1609.34;
                    const formattedDist = distMiles.toFixed(1);
                    
                    return {
                        id: s.id || s.naptanId,
                        label: name,
                        secondaryLabel: `${formattedDist} m`,
                        iconUrl: (s.modes && Object.keys(s.modes).includes('bus')) ? "https://img.icons8.com/color/48/bus.png" : null
                    };
                });

                return res.json(finalOptions);
            } 
            
            // 3. Mode Fallback (All stations for a mode if no location)
            else if (mode) {
                console.log(`DATA: 📋 Mode fallback search for: ${mode}`);
                stations = DataCacheService.getStationsByMode(mode as string);
                
                const fallbackOptions = stations.slice(0, 50).map(s => ({
                    id: s.id || s.naptanId,
                    label: s.label || s.commonName || (s as any).name || s.id,
                }));
                return res.json(fallbackOptions);
            } else {
                const searchOptions = stations.slice(0, 50).map(s => ({
                    id: s.id || s.naptanId,
                    label: s.label || s.commonName || (s as any).name || s.id,
                }));
                return res.json(searchOptions);
            }
        } catch (error) {
            console.error("Error searching stations:", error);
            return res.status(500).json([]);
        }
    }
}
