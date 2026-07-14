import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { SubscriptionService } from '../services/subscriptionService';
import { Station, StationPredictionResponse, LinePredictions, DirectionPredictions } from '../models';
import { DataCacheService } from '../services/dataCacheService';
import { LocalDbService } from '../services/localDbService';
import { TFL_LINE_COLORS } from '../utils/tflUtils';
import { formatPlatform, getIconUrl } from '../utils/formatters';
import { nowMs } from '../utils/timestamps';

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
            console.error(`Error fetching predictions for ${naptanId}:`, error);
            return res.status(500).json({ error: "Failed to fetch predictions" });
        }
    }

    private static formatDisplayName(arrival: any): string {
        // iBus sends the literal string "null" in `towards` for buses while the
        // real destination sits in destinationName — treat it as absent.
        const towards = (arrival.towards || '').trim();
        const raw = (towards && towards.toLowerCase() !== 'null')
            ? towards
            : (arrival.destinationName || '');
        return raw
            .replace(/ Underground Station/g, '')
            .replace(/ Station/g, '')
            .replace(/ DLR/g, '')
            .trim();
    }

    // TfL only assigns platforms ~5–15 min before departure for these modes;
    // far-future unplatformed predictions from them are noise, not real board data.
    private static readonly LATE_PLATFORM_MODES = new Set(['overground', 'dlr', 'elizabeth-line']);

    private static isFarFutureUnassigned(modeName: string, platform: string, eta: string): boolean {
        if (!StationController.LATE_PLATFORM_MODES.has(modeName.toLowerCase())) return false;
        if (platform !== 'Platform not assigned') return false;
        const etaMin = (new Date(eta).getTime() - Date.now()) / 60_000;
        return etaMin > 20;
    }

    private static async fetchPredictions(naptanId: string, skipRefresh = false): Promise<StationPredictionResponse> {
        // Tier 1/2 — serve from the local ephemeral cache while still fresh
        // (<60s), so repeated calls within the window don't re-hit TfL. The
        // freshness window is enforced at read time, so a stale row is never
        // served even before the async purge runs.
        const cached = await LocalDbService.getFreshStationPreds(naptanId);
        if (cached) return cached as StationPredictionResponse;

        if (skipRefresh) {
            return {
                stationId: naptanId,
                lines: {},
                lastUpdatedTime: nowMs()
            } as any;
        }

        // Tier 4 — cache miss/stale → fetch live from TfL, then cache it.
        const fresh = await StationController.fetchPredictionsFromTfl(naptanId);
        await LocalDbService.upsertStationPreds(naptanId, fresh, nowMs());
        // Fire-and-forget housekeeping — drop rows older than 60s. Never blocks.
        void LocalDbService.purgeStaleStationPreds().catch(() => {});
        return fresh;
    }

    /**
     * At a terminus, the direction a train DEPARTS in is the one whose route
     * destinations do NOT include this station (trains leave towards the other
     * end of the line). Returns null when ambiguous (e.g. mid-line short
     * workings, loops, or no cached route) so callers can fall back.
     */
    private static resolveDepartingDirection(naptanId: string, lineId: string): string | null {
        const route = DataCacheService.getRoute(lineId);
        const dirs: any[] = route?.directions || [];
        const away = dirs.filter(d =>
            !(d.destinations || []).some((dest: any) => dest.id === naptanId));
        return away.length === 1 ? (away[0].direction || null) : null;
    }

    // TfL's expectedArrival is computed from a prediction snapshot that can lag
    // ~40-60s behind real time, so an approaching train routinely shows an
    // expectedArrival slightly in the past while its timeToStation is still
    // positive. 2 minutes is safely beyond that skew: anything older is a
    // genuinely departed train TfL hasn't expired yet, not a live one.
    // Must stay in lockstep with StationlySyncer's DataTransformationService.
    private static readonly DEPARTED_CUTOFF_MS = 2 * 60_000;

    private static isLongDeparted(eta: string): boolean {
        if (!eta) return false;
        const etaMs = new Date(eta).getTime();
        return Number.isFinite(etaMs) && etaMs < Date.now() - StationController.DEPARTED_CUTOFF_MS;
    }

    private static async fetchPredictionsFromTfl(naptanId: string): Promise<StationPredictionResponse> {
        console.log(`PRED: 📡 Fetching live signals for ${naptanId}...`);

        // 1. Fetch raw arrivals from TfL
        const arrivals = await TflApiClient.getArrivalsForStation(naptanId);

        // 2. Group by Line and Direction
        const lines: Record<string, LinePredictions> = {};

        // Departing direction is identical for every self-terminating arrival
        // on the same line — resolve once per line, not per arrival.
        const departingDirByLine = new Map<string, string | null>();

        arrivals.forEach(arrival => {
            const lineId = arrival.lineId.toLowerCase();
            const modeName = (arrival.modeName || '').toLowerCase();
            const rawPlatform = arrival.platformName || '';
            const platform = formatPlatform(modeName, rawPlatform);
            const eta = arrival.expectedArrival || '';

            // Overground/DLR/Elizabeth line: TfL doesn't assign platforms until ~5–15 min before
            // departure — skip far-future unplatformed arrivals before they enter the response.
            if (StationController.isFarFutureUnassigned(modeName, platform, eta)) return;

            // Drop trains TfL should have expired: >2 min past expectedArrival.
            if (StationController.isLongDeparted(eta)) return;

            // Terminus rule (mirrors tfl.gov.uk): a train whose destination is
            // this very station is arriving to turn around. It IS a future
            // departure, but its outbound destination is unknown until TfL
            // assigns the return working at the platform — so show it as
            // "Check Front of Train" (never drop it; keyed on the naptanId, not
            // the name). Its direction is re-bucketed to the line's single
            // departing direction here, since the raw entry carries none.
            const isSelfTerminating = !!arrival.destinationNaptanId && arrival.destinationNaptanId === naptanId;

            let direction = arrival.direction
                || (rawPlatform.toLowerCase().includes('inbound') ? 'inbound' : 'outbound');
            if (isSelfTerminating && !arrival.direction) {
                if (!departingDirByLine.has(lineId)) {
                    departingDirByLine.set(lineId, StationController.resolveDepartingDirection(naptanId, lineId));
                }
                direction = departingDirByLine.get(lineId) || direction;
            }

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
                destId: isSelfTerminating ? 'unknown' : (arrival.destinationNaptanId || 'unknown'),
                platform,
                eta,
                displayName: isSelfTerminating ? 'Check Front of Train' : StationController.formatDisplayName(arrival)
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
