import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { SubscriptionService } from '../services/subscriptionService';
import { Station, StationPredictionResponse, LinePredictions, DirectionPredictions, PredictionItem } from '../models';
import { formatDestination, formatPlatform } from '../utils/formatters';

export class StationController {
    /**
     * @swagger
     * /stations/subscribed-ids:
     *   get:
     *     summary: Get Subscribed Station IDs
     *     description: Returns a list of all Naptan IDs that have at least one active user subscription. Respond with zero Firestore reads using in-memory cache.
     *     tags: [Stations]
     *     responses:
     *       200:
     *         description: List of subscribed Naptan IDs
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: string
     */
    static getSubscribedStationIds(req: Request, res: Response) {
        if (!SubscriptionService.getIsReady()) {
            console.log("PRED: ⚠️ Subscription registry not yet ready, serving empty list.");
            return res.json([]);
        }
        return res.json(SubscriptionService.getSubscribedStationIds());
    }

    /**
     * @swagger
     * /stations/predictions/{naptanId}:
     *   get:
     *     summary: Get Station Predictions
     *     description: Retrieves real-time arrival predictions for a station. Returns cached results if updated within 30 seconds.
     *     tags: [Stations]
     *     parameters:
     *       - in: path
     *         name: naptanId
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Station predictions
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/StationPredictionResponse'
     */
    static async getStationPredictions(req: Request, res: Response) {
        try {
            const naptanId = req.params.naptanId;
            const docRef = db.collection('stationPredictions').doc(naptanId);
            const doc = await docRef.get();

            if (doc.exists) {
                const data = doc.data() as StationPredictionResponse;
                const lastUpdated = new Date(data.lut).getTime();
                const now = Date.now();

                if (now - lastUpdated < 30000) {
                    console.log(`PRED: 🟢 Firestore HIT for predictions (naptanId: ${naptanId})`);
                    return res.json(data);
                }
            }

            console.log(`PRED: ⚪ Firestore MISS/OLD for predictions (naptanId: ${naptanId}). Fetching from TfL...`);
            const rawArrivals = await TflApiClient.getArrivalsForStation(naptanId);
            
            if (!rawArrivals || rawArrivals.length === 0) {
                console.log(`PRED: ⚠️ TfL returned zero results for ${naptanId}. Clearing any stale cache.`);
                if (doc.exists) await docRef.delete();
                
                return res.status(404).json({ 
                    error: "No active predictions available for this station at this time",
                    id: naptanId 
                });
            }

            const stationName = rawArrivals[0].stationName || "Unknown Station";
            const predictionsMap: Record<string, LinePredictions> = {};

            rawArrivals.forEach(arr => {
                const lineId = arr.lineId;
                const direction = arr.direction || (arr.platformName.toLowerCase().includes('inbound') ? 'inbound' : 'outbound');
                const dirKey = direction.charAt(0).toUpperCase() + direction.slice(1).toLowerCase();

                if (!predictionsMap[lineId]) {
                    predictionsMap[lineId] = {
                        id: lineId,
                        name: arr.lineName,
                        dirs: {}
                    };
                }

                if (!predictionsMap[lineId].dirs[dirKey]) {
                    predictionsMap[lineId].dirs[dirKey] = { preds: [] };
                }

                predictionsMap[lineId].dirs[dirKey].preds.push({
                    destId: arr.destinationNaptanId,
                    platform: formatPlatform(arr.modeName, arr.platformName),
                    eta: arr.expectedArrival,
                    displayName: formatDestination(arr.towards || arr.destinationName)
                });
            });

            // Sort predictions by ETA
            Object.values(predictionsMap).forEach(line => {
                Object.values(line.dirs).forEach(dir => {
                    dir.preds.sort((a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime());
                });
            });

            const response: StationPredictionResponse = {
                id: naptanId,
                name: stationName,
                lut: new Date().toISOString(),
                lines: predictionsMap
            };

            // Async update firestore
            setImmediate(async () => {
                try {
                    await docRef.set(response);
                    console.log(`PRED: ✅ Saved fresh predictions for ${naptanId}`);
                } catch (err) {
                    console.error("Failed to save predictions to Firestore", err);
                }
            });

            return res.json(response);
        } catch (error) {
            console.error(`Error fetching predictions for ${req.params.naptanId}:`, error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
    /**
     * @swagger
     * /stations/line/{lineId}:
     *   get:
     *     summary: Get Stations on Line
     *     description: Retrieves all stations associated with a specific line.
     *     tags: [Stations]
     *     parameters:
     *       - in: path
     *         name: lineId
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: A list of stations for the given line.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/Station'
     */
    static async getStationsByLine(req: Request, res: Response) {
        try {
            const lineId = req.params.lineId;
            const snapshot = await db.collection('stations')
                .where('searchKeys', 'array-contains', lineId.toLowerCase())
                .get();
            const stations: (Station & { id: string; label: string })[] = [];
            snapshot.forEach(doc => {
                const data = doc.data() as Station;
                stations.push({
                    ...data,
                    id: data.naptanId || doc.id,
                    label: data.commonName
                });
            });
            stations.sort((a, b) => (a.label || a.commonName).localeCompare(b.label || b.commonName));
            return res.json(stations);
        } catch (error) {
            console.error(`Error fetching stations for lineId ${req.params.lineId}:`, error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }

    /**
     * @swagger
     * /stations/search:
     *   get:
     *     summary: Search Stations
     *     description: Search stations by mode, line, direction, or combination. Optionally filter by location.
     *     tags: [Stations]
     *     parameters:
     *       - in: query
     *         name: searchKey
     *         description: "Search key. Examples: 'tube' (all tube stations), 'northern' (all northern line), 'tube_northern' (tube + northern), 'northern_inbound' (northern line inbound)"
     *         schema:
     *           type: string
     *       - in: query
     *         name: lat
     *         schema:
     *           type: number
     *       - in: query
     *         name: lon
     *         schema:
     *           type: number
     *       - in: query
     *         name: radius
     *         schema:
     *           type: number
     *           default: 1.0
     *     responses:
     *       200:
     *         description: A list of stations matching the search criteria.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/Station'
     */
    static async searchStations(req: Request, res: Response) {
        try {
            const searchKey = req.query.searchKey as string;
            const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
            const lon = req.query.lon ? parseFloat(req.query.lon as string) : undefined;
            const radius = req.query.radius ? parseFloat(req.query.radius as string) : 1.0;

            if (searchKey) {
                const snapshot = await db.collection('stations')
                    .where('searchKeys', 'array-contains', searchKey.toLowerCase())
                    .get();
                let stations: (Station & { id: string; label: string })[] = [];

                snapshot.forEach(doc => {
                    const data = doc.data() as Station;
                    stations.push({
                        ...data,
                        id: data.naptanId || doc.id,
                        label: data.commonName
                    });
                });

                // Cache Miss: Fallback to TfL API
                if (stations.length === 0) {
                    console.log(`DATA: ⚪ Firestore MISS for stations (searchKey: ${searchKey}). Resolving via fallback...`);
                    const parts = searchKey.split('_');
                    const lineIdCandidate = parts[0];
                    if (lineIdCandidate) {
                        try {
                            const stopPoints = await TflApiClient.getStopPointsByLine(lineIdCandidate);
                            if (stopPoints && stopPoints.length > 0) {
                                // For ephemeral UI response, we don't filter stopType strictly here
                                // to ensure the user at least sees SOMETHING if the mode is unknown.
                                (stations as any) = stopPoints.map(sp => ({
                                    naptanId: sp.naptanId,
                                    commonName: sp.commonName,
                                    lat: sp.lat,
                                    lon: sp.lon,
                                    stopType: sp.stopType,
                                    id: sp.naptanId,
                                    label: sp.commonName
                                }));

                                // Push to DB asynchronously (don't block the UI)
                                setImmediate(async () => {
                                    const batch = db.batch();
                                    // But for DB persistence, we should be cleaner
                                    stopPoints.forEach(sp => {
                                        const docRef = db.collection('stations').doc(sp.naptanId);
                                        const searchKeys = [lineIdCandidate.toLowerCase()];
                                        if (parts[1]) searchKeys.push(`${lineIdCandidate}_${parts[1]}`.toLowerCase());

                                        batch.set(docRef, {
                                            naptanId: sp.naptanId,
                                            commonName: sp.commonName,
                                            lat: sp.lat,
                                            lon: sp.lon,
                                            stopType: sp.stopType,
                                            searchKeys: searchKeys,
                                            lastUpdatedTime: new Date().toISOString()
                                        }, { merge: true });
                                    });
                                    await batch.commit();
                                    console.log(`DATA: ✅ Discovered stations saved to Firestore for line: ${lineIdCandidate}`);
                                });
                            }
                        } catch (err) {
                            console.error("TfL StopPoint Fallback failed:", err);
                        }
                    }
                } else {
                    console.log(`DATA: 🟢 Firestore HIT for stations (searchKey: ${searchKey})`);
                }

                stations.sort((a, b) => (a.label || a.commonName).localeCompare(b.label || b.commonName));
                return res.json(stations);
            } else if (lat !== undefined && lon !== undefined) {
                if (radius <= 0) return res.status(400).json({ error: "Invalid radius" });

                const snapshot = await db.collection('stations').get();
                const stations: (Station & { id: string; label: string })[] = [];
                snapshot.forEach(doc => {
                    const data = doc.data() as Station;
                    if (data.lat && data.lon) {
                        const dLat = (data.lat - lat) * (Math.PI / 180);
                        const dLon = (data.lon - lon) * (Math.PI / 180);
                        const a =
                            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(lat * (Math.PI / 180)) * Math.cos(data.lat * (Math.PI / 180)) *
                            Math.sin(dLon / 2) * Math.sin(dLon / 2);
                        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                        const distance = 6371 * c;

                        if (distance <= radius) {
                            stations.push({
                                ...data,
                                id: data.naptanId || doc.id,
                                label: data.commonName
                            });
                        }
                    }
                });
                return res.json(stations);
            } else {
                return res.status(400).json({ error: "Missing required parameters" });
            }
        } catch (error) {
            console.error("Error searching stations:", error);
            return res.status(500).json([]);
        }
    }
}
