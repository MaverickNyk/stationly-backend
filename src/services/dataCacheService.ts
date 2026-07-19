import { db } from '../config/firebase';
import { Station, TransportMode } from '../models';
import { LocalDbService } from './localDbService';
import { AuthMiddleware } from '../middleware/authMiddleware';
import { SubscriptionService } from './subscriptionService';
import { nowMs, toEpochMs } from '../utils/timestamps';

export class DataCacheService {
    private static stations: Map<string, Station> = new Map();
    private static modes: Map<string, TransportMode> = new Map();
    private static lines: Map<string, any> = new Map();
    private static routes: Map<string, any> = new Map();
    private static lineStatuses: Map<string, any> = new Map();
    private static isReady = false;

    /**
     * Initializes the cache by first loading from SQLite, then syncing with Firestore.
     */
    static async initialize() {
        console.log("CACHE: 📡 Initializing Data Cache...");

        try {
            // 1. Initialize SQLite
            await LocalDbService.initialize();

            // 2. Initialize Auth & Subscriptions (Persistent)
            await AuthMiddleware.initializeKeyRegistryListener();
            await SubscriptionService.initializeListener();

            // 3. Load Metadata from local DB for immediate response
            await this.loadFromLocal();

            const isProductionOrStaging = process.env.APP_ENV === 'production' || process.env.APP_ENV === 'staging';
            const isMasterInstance = process.env.NODE_APP_INSTANCE === undefined || process.env.NODE_APP_INSTANCE === '0';
            const shouldSync = isMasterInstance && isProductionOrStaging;

            if (shouldSync) {
                try {
                    await this.syncWithFirestore();
                    console.log("CACHE: ✅ Delta Sync completed.");
                } catch (syncErr) {
                    console.warn("CACHE: ⚠️ Firestore sync failed (quota likely), continuing with local data.");
                }
                this.isReady = true;
                this.setupRealtimeListeners();
            } else {
                const reason = !isProductionOrStaging ? "Running in local development mode" : `Cluster instance ${process.env.NODE_APP_INSTANCE}`;
                console.log(`CACHE: 🛸 ${reason} - Skipping Firestore sync, running in local read-only mode.`);
                this.isReady = true;
            }

        } catch (err) {
            console.error("CACHE: ❌ Initialization failed:", err);
        }
    }

    private static async loadFromLocal() {
        const localModes = await LocalDbService.all<{ raw_data: string }>('SELECT raw_data FROM modes');
        localModes.forEach(m => {
            const data = JSON.parse(m.raw_data) as TransportMode;
            this.modes.set(data.modeName, data);
        });

        const localStations = await LocalDbService.all<{ id: string, raw_data: string }>('SELECT id, raw_data FROM stations');
        localStations.forEach(s => {
            const data = JSON.parse(s.raw_data) as Station;
            this.stations.set(s.id, data);
        });

        const localLines = await LocalDbService.all<{ id: string, modeName: string, raw_data: string }>('SELECT id, modeName, raw_data FROM lines');
        localLines.forEach(l => {
            const data = JSON.parse(l.raw_data);
            this.lines.set(l.id, { ...data, id: l.id, modeName: l.modeName });
        });

        const localRoutes = await LocalDbService.all<{ id: string, raw_data: string }>('SELECT id, raw_data FROM routes');
        localRoutes.forEach(r => {
            const data = JSON.parse(r.raw_data);
            this.routes.set(r.id, data);
        });

        const localStatuses = await LocalDbService.all<{ id: string, raw_data: string }>('SELECT id, raw_data FROM line_statuses');
        localStatuses.forEach(s => {
            const data = JSON.parse(s.raw_data);
            this.lineStatuses.set(s.id, data);
        });

        console.log(`CACHE: 📁 Load from SQLite success. Modes: ${this.modes.size}, Stations: ${this.stations.size}, Lines: ${this.lines.size}, Routes: ${this.routes.size}, Statuses: ${this.lineStatuses.size}`);
    }

    /**
     * Collections replicated Firestore (master) → SQLite + memory (slave).
     * Each target owns its `apply` (memory + SQLite upsert) and `remove`
     * (memory + SQLite delete) so the delta + listener code stays generic.
     * `stationPredictions` is deliberately ABSENT — it's ephemeral, local-only.
     */
    private static replicationTargets(): Array<{
        name: string;
        apply: (id: string, data: any) => Promise<void>;
        remove: (id: string) => Promise<void>;
    }> {
        return [
            {
                name: 'modes',
                apply: async (id, data) => { this.modes.set(id, data as TransportMode); await LocalDbService.upsertMode(id, data); },
                remove: async (id) => { this.modes.delete(id); await LocalDbService.run('DELETE FROM modes WHERE id = ?', [id]); },
            },
            {
                name: 'lines',
                apply: async (id, data) => { this.lines.set(id, { ...data, id, modeName: data.modeName }); await LocalDbService.upsertLine(id, data.modeName, data); },
                remove: async (id) => { this.lines.delete(id); await LocalDbService.run('DELETE FROM lines WHERE id = ?', [id]); },
            },
            {
                name: 'routes',
                apply: async (id, data) => { this.routes.set(id, data); await LocalDbService.upsertRoute(id, data); },
                remove: async (id) => { this.routes.delete(id); await LocalDbService.run('DELETE FROM routes WHERE id = ?', [id]); },
            },
            {
                name: 'stations',
                apply: async (id, data) => { const m = { ...data, id: data.naptanId || id }; this.stations.set(id, m as Station); await LocalDbService.upsertStation(id, m); },
                remove: async (id) => { this.stations.delete(id); await LocalDbService.run('DELETE FROM stations WHERE id = ?', [id]); },
            },
            {
                name: 'lineStatuses',
                apply: async (id, data) => { this.lineStatuses.set(id, data); await LocalDbService.upsertLineStatus(id, data); },
                remove: async (id) => { this.lineStatuses.delete(id); await LocalDbService.run('DELETE FROM line_statuses WHERE id = ?', [id]); },
            },
        ];
    }

    private static async syncWithFirestore() {
        for (const t of this.replicationTargets()) {
            await this.deltaSync(t.name, t.apply, t.remove);
        }
    }

    /**
     * Boot delta: fetch everything changed since our integer checkpoint, apply
     * each change (soft-delete aware: `deleted === true` → remove), then advance
     * the checkpoint to the batch MAX in a single atomic write. A null checkpoint
     * means first boot → full load.
     */
    private static async deltaSync(
        name: string,
        apply: (id: string, data: any) => Promise<void>,
        remove: (id: string) => Promise<void>,
    ) {
        const checkpoint = await LocalDbService.getLastSyncTime(name);
        let query: any = db.collection(name);
        if (checkpoint != null) query = query.where('lastUpdatedTime', '>', checkpoint);

        const snapshot = await query.get();
        if (snapshot.empty) {
            console.log(`CACHE: 🏷️  [${name}] already up to date (checkpoint ${checkpoint ?? 'Never'}).`);
            return;
        }
        console.log(`CACHE: 📥 [${name}] ${snapshot.size} changed docs since ${checkpoint ?? 'Never'}.`);

        let maxTs: number | null = checkpoint;
        for (const doc of snapshot.docs) {
            const data = doc.data();
            if (data.deleted === true) await remove(doc.id);
            else await apply(doc.id, data);
            const ts = toEpochMs(data.lastUpdatedTime);
            if (ts != null && (maxTs == null || ts > maxTs)) maxTs = ts;
        }
        // Collections whose docs carry no timestamp: stamp "now" so we don't
        // re-download them on every boot.
        if (maxTs == null) maxTs = nowMs();
        await LocalDbService.updateLastSyncTime(name, maxTs);
    }

    private static setupRealtimeListeners() {
        for (const t of this.replicationTargets()) {
            this.listen(t.name, t.apply, t.remove);
        }
    }

    /**
     * Live listener. Processes each snapshot's changes SEQUENTIALLY (ordered,
     * no race) and advances the checkpoint to the batch MAX in one atomic write
     * — never per-document. Both Firestore `removed` and a soft-delete
     * (`deleted: true`) remove the row locally.
     */
    private static async listen(
        name: string,
        apply: (id: string, data: any) => Promise<void>,
        remove: (id: string) => Promise<void>,
    ) {
        // Baseline = the checkpoint the boot delta just advanced; falls back to
        // "now" so a never-synced collection doesn't full-download on listen.
        const baseline = (await LocalDbService.getLastSyncTime(name)) ?? nowMs();
        db.collection(name)
            .where('lastUpdatedTime', '>', baseline)
            .onSnapshot(async (snapshot) => {
                let maxTs: number | null = null;
                for (const change of snapshot.docChanges()) {
                    const data = change.doc.data();
                    const id = change.doc.id;
                    if (change.type === 'removed' || data.deleted === true) await remove(id);
                    else await apply(id, data);
                    const ts = toEpochMs(data.lastUpdatedTime);
                    if (ts != null && (maxTs == null || ts > maxTs)) maxTs = ts;
                }
                if (maxTs != null) await LocalDbService.updateLastSyncTime(name, maxTs);
            }, (err) => console.error(`CACHE: ❌ Listen failed on ${name}`, err));
    }

    static getIsReady(): boolean {
        return this.isReady;
    }

    static getAllModes(): TransportMode[] {
        return Array.from(this.modes.values());
    }

    static getAllStations(): Station[] {
        return Array.from(this.stations.values());
    }

    /** O(1)-ish station lookup by naptanId/id, built from the in-memory map. */
    static getStationById(id: string): Station | undefined {
        return this.stations.get(id);
    }

    /** Counts for the admin dashboard — all from memory, zero Firestore reads. */
    static counts(): { stations: number; lines: number; modes: number; routes: number; lineStatuses: number } {
        return {
            stations: this.stations.size,
            lines: this.lines.size,
            modes: this.modes.size,
            routes: this.routes.size,
            lineStatuses: this.lineStatuses.size,
        };
    }

    private static levenshtein(a: string, b: string): number {
        const m = a.length, n = b.length;
        const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
        for (let i = 1; i <= m; i++) {
            let prev = dp[0];
            dp[0] = i;
            for (let j = 1; j <= n; j++) {
                const tmp = dp[j];
                dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
                prev = tmp;
            }
        }
        return dp[n];
    }

    /**
     * Search stations by text. Three matching strategies, results unioned:
     *   1. **Exact searchKey** — bus route abbreviations (e.g. "39"), line
     *      IDs, ICS codes. Highest-confidence; surfaced FIRST in the list.
     *   2. **Case-insensitive substring** on commonName / naptanId. Most
     *      typical user typing — "sen" matches "Arsenal", "fie" matches
     *      "Southfields", "kings" matches "King's Cross".
     *   3. **Fuzzy** — small Levenshtein distance against per-word name
     *      tokens. Catches single-character typos ("sotuhfields"). Slowest
     *      and least precise so it runs LAST and only when the first two
     *      sieves yielded fewer than 50 results.
     *
     * The previous implementation early-returned after the searchKey
     * sieve, which silently hid the substring + fuzzy matches if any
     * station happened to use the query as its searchKey — masking valid
     * results like Southfields Underground Station for the query "fie".
     *
     * Output is hard-capped at 50 — anything more isn't actionable in a
     * picker UI. Stations appear at most once even if matched by multiple
     * sieves; dedup is by id+naptanId composite.
     */
    static searchStationsByQuery(query: string): Station[] {
        const q = query.toLowerCase().trim();
        if (!q) return [];
        const all = this.getAllStations();

        // Track membership by stable id so a station that matches multiple
        // sieves (e.g. searchKey AND substring) only appears once.
        const seen = new Set<string>();
        const exactKey: Station[]   = [];   // sieve 1
        const substring: Station[]  = [];   // sieve 2
        const fuzzy: Station[]      = [];   // sieve 3
        const idKey = (s: Station) => (s.naptanId || (s as any).id || s.commonName || "").toLowerCase();

        const tryPush = (bucket: Station[], s: Station) => {
            const k = idKey(s);
            if (!k || seen.has(k)) return;
            seen.add(k);
            bucket.push(s);
        };

        // ── 1. Exact searchKey ─────────────────────────────────────────
        for (const s of all) {
            const keys = (s as any).searchKeys;
            if (Array.isArray(keys) && keys.some((k: string) => k.toLowerCase() === q)) {
                tryPush(exactKey, s);
            }
        }

        // ── 2. Substring on commonName / naptanId ──────────────────────
        // No early-cap here. Otherwise alphabetical iteration through
        // 20k+ stations fills the cap with low-priority bus stops before
        // reaching e.g. Southfields Underground Station, hiding it from
        // results for queries like "fie" or "road".
        for (const s of all) {
            const name = (s.commonName || "").toLowerCase();
            const napt = (s.naptanId || "").toLowerCase();
            if (name.includes(q) || napt.includes(q)) tryPush(substring, s);
        }

        // ── 3. Fuzzy on name tokens — last-resort when nothing else hit ─
        // Only meaningful for typo recovery; skip if we already have
        // direct matches so fuzzy doesn't pollute the result with
        // tangentially-related stations.
        if (exactKey.length === 0 && substring.length === 0) {
            const qWords = q.split(/\s+/).filter(w => w.length > 2);
            if (qWords.length > 0) {
                for (const s of all) {
                    const nameWords = (s.commonName || "").toLowerCase().split(/[\s,\-\/]+/);
                    const ok = qWords.some(qw =>
                        nameWords.some(nw => {
                            if (nw.includes(qw) || qw.includes(nw)) return true;
                            const maxDist = qw.length > 5 ? 2 : 1;
                            return this.levenshtein(qw, nw) <= maxDist;
                        })
                    );
                    if (ok) tryPush(fuzzy, s);
                }
            }
        }

        // Rank within each sieve by station type so tube / rail surface
        // ABOVE bus stops with the same key — users typing "road" almost
        // always mean "Holloway Road Underground Station", not a random
        // bus pole on Foo Road.
        const rankSort = (a: Station, b: Station) => stationTypeRank(b) - stationTypeRank(a);
        exactKey.sort(rankSort);
        substring.sort(rankSort);
        fuzzy.sort(rankSort);

        return [...exactKey, ...substring, ...fuzzy].slice(0, 50);
    }

    /** Haversine distance in metres between two WGS-84 coordinates. */
    static haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371000;
        const dLat = (lat2 - lat1) * (Math.PI / 180);
        const dLon = (lon2 - lon1) * (Math.PI / 180);
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
            Math.sin(dLon / 2) ** 2;
        return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
    }

    /**
     * Returns true if a station serves the given mode.
     * Primary check: station.modes keys. Fallback: any line in searchKeys has that modeName.
     * The fallback handles modes like elizabeth-line where stations lack modes metadata.
     */
    static stationServesMode(station: Station, mode: string): boolean {
        const modeLower = mode.toLowerCase();
        if (station.modes && Object.keys(station.modes).some(m => m.toLowerCase() === modeLower)) {
            return true;
        }
        const searchKeys: string[] = (station as any).searchKeys || [];
        return searchKeys.some(key => {
            const line = this.lines.get(key);
            return line?.modeName?.toLowerCase() === modeLower;
        });
    }

    /** Returns all stations with coordinates, sorted nearest-first then A-Z. Optionally filtered by mode. */
    static getNearbyStations(lat: number, lon: number, mode?: string): any[] {
        const results: any[] = [];

        this.stations.forEach((data) => {
            if (!data.lat || !data.lon) return;
            if (mode && !this.stationServesMode(data, mode)) return;

            const stopType = data.stopType || '';
            results.push({
                ...data,
                label: data.commonName,
                isMajor: stopType.includes('MetroStation') || stopType.includes('RailStation'),
                distance: this.haversineMeters(lat, lon, data.lat, data.lon),
            });
        });

        results.sort((a, b) => {
            const d = a.distance - b.distance;
            return d !== 0 ? d : (a.commonName || '').localeCompare(b.commonName || '');
        });

        return results;
    }

    /**
     * Returns the grouping key for a station.
     * Priority: icsCode → stationNaptan → commonName (for stops missing TfL group keys) → naptanId.
     * Using commonName catches bus poles that share the same stop name but lack icsCode/stationNaptan.
     */
    static getGroupKey(station: Station): string {
        return (station as any).icsCode || (station as any).stationNaptan
            || station.commonName?.trim()
            || station.naptanId;
    }

    /**
     * Groups a flat list of stations by their grouping key.
     * The representative (first / closest) is kept as the entry; member naptanIds are collected.
     */
    static groupStations(stations: any[]): any[] {
        const groups = new Map<string, any>();
        for (const s of stations) {
            const key = (s as any).icsCode || (s as any).stationNaptan
                || s.commonName?.trim()
                || s.naptanId;
            const memberId = s.naptanId || s.id;
            if (!groups.has(key)) {
                groups.set(key, { ...s, members: memberId ? [memberId] : [] });
            } else {
                const existing = groups.get(key)!;
                if (memberId && !existing.members.includes(memberId)) {
                    existing.members.push(memberId);
                }
                // Choose the more "discoverable" stop as the representative
                // for a grouped location. Priority order:
                //   1. Closer to the user, if both have GPS distance.
                //   2. Higher rank station type (tube > rail > overground >
                //      … > bus stop). A bus pole at the same TfL ICS code
                //      as Southfields Underground would previously win
                //      because it was added to the map first; now the tube
                //      station always wins because the user typing "south"
                //      almost certainly wants the named station, not its
                //      adjacent bus pole.
                const sCloser = (s.distance ?? Infinity) < (existing.distance ?? Infinity)
                const tied = (s.distance ?? Infinity) === (existing.distance ?? Infinity)
                const sBetterType = tied && stationTypeRank(s) > stationTypeRank(existing)
                if (sCloser || sBetterType) {
                    groups.set(key, { ...s, members: existing.members });
                }
            }
        }
        return Array.from(groups.values());
    }

    /**
     * Resolve the exact physical stop (naptanId) for a station group + mode + line + direction.
     * Looks through all siblings sharing the same icsCode/stationNaptan and returns the one
     * that serves the requested line in the requested direction.
     * Falls back to the supplied representativeId if no better match is found.
     */
    static resolveStation(representativeId: string, mode: string, lineId: string, direction: string): string {
        const repr = Array.from(this.stations.values()).find(
            s => s.naptanId === representativeId || (s as any).id === representativeId
        );
        if (!repr) return representativeId;

        const groupKey = this.getGroupKey(repr);
        const siblings = Array.from(this.stations.values()).filter(
            s => this.getGroupKey(s) === groupKey
        );

        const dirLower = direction.toLowerCase();
        for (const sib of siblings) {
            const modeData = (sib.modes as any)?.[mode];
            if (!modeData) continue;
            const lineData = modeData.lines?.[lineId];
            if (!lineData) continue;
            const dirs: string[] = lineData.directions || [];
            if (dirs.length === 0 || dirs.some((d: string) => d.toLowerCase() === dirLower)) {
                return sib.naptanId || (sib as any).id || representativeId;
            }
        }

        return representativeId;
    }

    static getStationsByLine(lineId: string): Station[] {
        return this.getAllStations()
            .filter(s => (s.searchKeys || []).includes(lineId));
    }

    static getLinesByMode(mode: string): any[] {
        return Array.from(this.lines.values())
            .filter(l => l.modeName === mode);
    }

    static getLineById(id: string): any | undefined {
        return this.lines.get(id);
    }

    static getRoute(lineId: string): any | null {
        return this.routes.get(lineId) || null;
    }

    static setRoute(lineId: string, data: any): void {
        this.routes.set(lineId, data);
    }

    static getStationsByMode(mode: string): Station[] {
        return Array.from(this.stations.values())
            .filter(s => s.modes && Object.keys(s.modes).includes(mode));
    }

    static getLineStatuses(mode?: string): any[] {
        const all = Array.from(this.lineStatuses.values());
        if (!mode) return all;
        return all.filter(s => s.mode === mode);
    }

    static setLineStatus(id: string, data: any): void {
        this.lineStatuses.set(id, data);
    }
}

/**
 * Rank a station by how prominent it should appear in a user's search
 * result. Higher = preferred representative when multiple stations
 * share a `groupStations` key (e.g. a tube station and its adjacent
 * bus stops both keyed by the same TfL ICS code).
 *
 * Heuristic: TfL naptanId prefixes are stable:
 *   - "940GZ..."  → tube (Underground)
 *   - "910G..."   → National Rail / Overground / Elizabeth line
 *   - "9300..."   → Tram
 *   - "490..."    → London bus stop
 *   - "4000..."   → outside-London bus stop
 *
 * Tube and rail stations beat bus stops because users typing a station
 * name almost always mean the named station, not the bus pole outside.
 */
function stationTypeRank(station: any): number {
    const id = String(station?.naptanId || station?.id || "").toUpperCase();
    return when_(id, [
        ["940GZ", 50],   // tube
        ["910G",  40],   // rail / overground / elizabeth
        ["930G",  35],   // DLR
        ["9300",  30],   // tram
        ["490",   10],   // London bus
        ["4000",  8],    // out-of-London bus
        ["1500",  7],    // bus mode misc
    ], 0);
}

function when_<T>(value: string, table: Array<[string, T]>, fallback: T): T {
    for (const [prefix, result] of table) {
        if (value.startsWith(prefix)) return result;
    }
    return fallback;
}


