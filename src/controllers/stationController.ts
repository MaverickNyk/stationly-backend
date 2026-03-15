import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { Station } from '../models';

export class StationController {
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
