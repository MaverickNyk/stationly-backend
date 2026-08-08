import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient, UnknownStationError, TflUnavailableError } from '../client/TflApiClient';
import { SubscriptionService } from '../services/subscriptionService';
import { Station, StationPredictionResponse, LinePredictions, DirectionPredictions } from '../models';
import { DataCacheService } from '../services/dataCacheService';
import { TFL_LINE_COLORS } from '../utils/tflUtils';
import { getIconUrl } from '../utils/formatters';
import { nowMs } from '../utils/timestamps';
import { PredictionSourceFactory } from '../services/predictionSources/PredictionSourceFactory';
import { PredictionCache } from '../services/predictionCache';
import { StationStreamHub } from '../services/stationStreamHub';
import { readNaptan, aliasDisplayName } from '../services/predictionSources/predictionUtils';

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
        const { skipRefresh } = req.query;
        try {
            const predictions = await StationController.fetchPredictions(naptanId, skipRefresh === 'true');
            return res.json(predictions);
        } catch (error) {
            // A bad id is the caller's problem, not ours — 404 it rather than
            // returning 200 with an empty board named "Unknown Station", which
            // is indistinguishable from a real station outside service hours.
            // Nothing was cached, because the throw happened before broadcast().
            if (error instanceof UnknownStationError) {
                return res.status(404).json({
                    error: "Station not found",
                    message: `TfL does not recognise naptanId '${naptanId}'.`,
                    naptanId,
                });
            }
            // Upstream is down — say so, rather than returning 200 with an
            // empty board. An empty board is a CLAIM ("no trains here") and is
            // indistinguishable from a genuinely quiet station at 3am.
            if (error instanceof TflUnavailableError) {
                return res.status(503).json({
                    error: "Upstream unavailable",
                    message: "Could not reach TfL for this station. Please retry shortly.",
                    naptanId,
                });
            }
            console.error(`Error fetching predictions for ${naptanId}:`, error);
            return res.status(500).json({ error: "Failed to fetch predictions" });
        }
    }

    /**
     * Cache-then-TfL tiering for a single station. Public because the WebSocket
     * stream calls it directly to warm a cold station on subscribe — sharing
     * this method (rather than forking the logic) is what makes a stream
     * prefetch and a concurrent REST request collapse into ONE TfL call.
     */
    static async fetchPredictions(naptanId: string, skipRefresh = false): Promise<StationPredictionResponse> {
        // Tier 0 — the negative cache. An id TfL 404'd in the last few minutes
        // is refused from memory. Without this, every repeat of a dead id is a
        // fresh TfL call — the old fake-200 entry used to absorb them by
        // accident. Checked before skipRefresh so a dead id 404s even there.
        if (PredictionCache.isUnknown(naptanId)) throw new UnknownStationError(naptanId);

        // Tier 1 — the SHARED prediction cache. Populated both by our own TfL
        // fetches below AND by the Syncer's pushes (which already pull every
        // subscribed station every ~30s for the FCM/stream fan-out). That's the
        // saving: for any subscribed station, this usually hits and TfL is
        // never called. Freshness is asserted at read time, so a lapsed entry
        // is never served.
        //
        // Replaces the old SQLite `station_preds` table — see
        // services/predictionCache/README.md for why this is memory-only.
        const cached = PredictionCache.getFresh(naptanId);
        if (cached) return cached;

        if (skipRefresh) {
            return {
                stationId: naptanId,
                lines: {},
                lastUpdatedTime: nowMs()
            } as any;
        }

        // Tier 2 — miss or stale → fetch from TfL, write back so the next
        // caller AND any WebSocket subscriber of this station benefit.
        // Stations nobody has subscribed to are only ever populated this way,
        // since the Syncer doesn't poll them.
        //
        // getOrFetch, not a bare fetch: concurrent requests for the same cold
        // station share ONE TfL call instead of each starting their own. That
        // matters precisely when traffic spikes — same single-flight pattern as
        // LineController.inFlightStatusRefresh.
        try {
            return await PredictionCache.getOrFetch(
                naptanId,
                () => StationController.fetchPredictionsFromTfl(naptanId),
            );
        } catch (error) {
            // Feed the negative cache so the next request stops at tier 0.
            // Marked here, not in TflApiClient — the client stays cache-unaware.
            if (error instanceof UnknownStationError) PredictionCache.markUnknown(naptanId);
            throw error;
        }
    }

    private static async fetchPredictionsFromTfl(naptanId: string): Promise<StationPredictionResponse> {
        console.log(`PRED: 📡 Fetching live signals for ${naptanId}...`);

        // 1. Start the countdown arrivals fetch — every source builds from or
        //    falls back to them. Not awaited here: board sources overlap
        //    their own board calls with it.
        // Sources await this promise wherever they consume it, so the fetch
        // overlaps their own board calls — that overlap is why it is passed as a
        // promise rather than awaited here.
        const rawArrivals = TflApiClient.getArrivalsForStation(readNaptan(naptanId));

        // A transient TfL failure is downgraded to an empty list for the SOURCES
        // — ElizabethOvergroundPredictionSource awaits arrivals unconditionally
        // even though its real board comes from ArrivalDepartures, so letting
        // the rejection through would blank a board we successfully built.
        // The failure is remembered instead, and acted on after the build.
        //
        // A 404 still propagates: that one is a fact about the station, not a
        // transport failure.
        let arrivalsFailed = false;
        const arrivalsPromise: Promise<any[]> = rawArrivals.catch((err) => {
            if (err instanceof UnknownStationError) throw err;
            arrivalsFailed = true;
            return [];
        });
        // Without a handler attached at creation, a 404 rejection between here
        // and the `await` below surfaces as an unhandled rejection. This does
        // not swallow it — `await arrivalsPromise` still throws.
        arrivalsPromise.catch(() => { });

        // 2. One source per station, picked from its locally-stored mode set:
        //    pure elizabeth-line/overground stations get the rail-style
        //    departures board, everything else keeps the arrivals path.
        const station = DataCacheService.getStationById(naptanId);
        const source = PredictionSourceFactory.forStation(station);
        console.log(`PRED: 🔀 ${naptanId} → ${source.name} (local modes: ${station ? Object.keys(station.modes || {}).join(',') || 'none' : 'not in local db'})`);
        const lines = await source.buildStationPredictions({ naptanId, station, arrivals: arrivalsPromise });
        const arrivals = await arrivalsPromise;

        // 3. Sort predictions by ETA
        Object.values(lines).forEach((line: LinePredictions) => {
            Object.values(line.dirs).forEach((dir: DirectionPredictions) => {
                dir.preds.sort((a, b) => new Date(a.eta).getTime() - new Date(b.eta).getTime());
            });
        });

        // An error is not data. If TfL never answered AND we built nothing from
        // any other source, there is nothing worth keeping — so refuse before
        // the broadcast below, which would otherwise write an empty board into
        // the shared cache with a fresh `lut` (overwriting good data) and push
        // "no service here" to every subscriber of this station.
        //
        // Guarded on `lines` being empty so a station whose board came from
        // ArrivalDepartures still serves normally when only arrivals failed.
        if (arrivalsFailed && Object.keys(lines).length === 0) {
            throw new TflUnavailableError(naptanId);
        }

        const payload = {
            id: naptanId,
            name: aliasDisplayName(naptanId) || arrivals[0]?.stationName || station?.commonName || "Unknown Station",
            lut: new Date().toISOString(),
            lines
        };
        StationStreamHub.broadcast(naptanId, payload, 'rest');
        return payload;
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
                iconUrl: (s.modes && Object.keys(s.modes).includes('bus')) ? getIconUrl('bus') : null,
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

                // Apply mode filter so e.g. bus mode doesn't return tube stations
                if (modeFilter) {
                    stations = stations.filter(s => DataCacheService.stationServesMode(s, modeFilter));
                }

                // Cold-start: cache not ready yet — fall back to Firestore
                if (stations.length === 0 && !DataCacheService.getIsReady()) {
                    console.log(`CACHE: ⚪ Cache not ready for '${searchKey}', querying Firestore`);
                    const snapshot = await db.collection('stations')
                        .where('searchKeys', 'array-contains', String(searchKey))
                        .get();
                    stations = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                    if (modeFilter) {
                        stations = stations.filter(s => DataCacheService.stationServesMode(s, modeFilter));
                    }
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
                    iconUrl: isBusStation(s) ? getIconUrl('bus') : null,
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
                        if (!data.lat || !data.lon) return;
                        if (modeFilter && !DataCacheService.stationServesMode(data, modeFilter)) return;
                        stations.push({
                            ...data,
                            id: doc.id,
                            distance: DataCacheService.haversineMeters(startLat, startLon, data.lat, data.lon),
                        });
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
                    iconUrl: isBusStation(s) ? getIconUrl('bus') : null,
                    tags: lineTags(s, modeFilter),
                })));
            }

            // ── Mode-only fallback (no location) ───────────────────────────────────
            if (modeFilter) {
                const stations = DataCacheService.getAllStations()
                    .filter(s => DataCacheService.stationServesMode(s, modeFilter));
                return res.json(stations.slice(0, 50).map(s => ({
                    id: (s as any).id || s.naptanId,
                    label: s.commonName || (s as any).label || (s as any).id,
                })));
            }

            return res.json([]);
        } catch (error) {
            console.error('Error searching stations:', error);
            return res.status(500).json([]);
        }
    }
}
