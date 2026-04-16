import { db } from '../config/firebase';
import { Station, TransportMode } from '../models';
import { LocalDbService } from './localDbService';
import { AuthMiddleware } from '../middleware/authMiddleware';
import { SubscriptionService } from './subscriptionService';

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

            // 4. Perform Delta Sync with Firestore
            try {
                await this.syncWithFirestore();
                console.log("CACHE: ✅ Delta Sync completed.");
            } catch (syncErr) {
                console.warn("CACHE: ⚠️ Firestore sync failed (quota likely), continuing with local data.");
            }
            
            this.isReady = true;

            // 5. Set up real-time listeners for live updates while the server is running
            this.setupRealtimeListeners();

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

    private static async syncWithFirestore() {
        // Sync Modes
        await this.syncCollection('modes', (id, data) => LocalDbService.upsertMode(id, data));

        // Sync Lines
        await this.syncCollection('lines', (id, data) => LocalDbService.upsertLine(id, data.modeName, data));

        // Sync Routes
        await this.syncCollection('routes', (id, data) => LocalDbService.upsertRoute(id, data));

        // Sync Stations (The 20k rows part)
        await this.syncCollection('stations', (id, data) => LocalDbService.upsertStation(id, data));

        // Sync Line Statuses
        await this.syncCollection('lineStatuses', (id, data) => LocalDbService.upsertLineStatus(id, data));
    }

    private static async syncCollection(collectionName: string, upsertFunc: (id: string, data: any) => Promise<void>) {
        const lastSync = await LocalDbService.getLastSyncTime(collectionName);
        console.log(`CACHE: 🔄 Delta sync [${collectionName}]. Last sync: ${lastSync || 'Never'}`);

        let query = db.collection(collectionName) as any;
        if (lastSync) {
            // Only fetch what changed
            query = query.where('lastUpdatedTime', '>', lastSync);
        }

        const snapshot = await query.get();
        if (snapshot.empty) {
            console.log(`CACHE: 🏷️  Collection [${collectionName}] is already up to date.`);
            return;
        }

        console.log(`CACHE: 📥 Found ${snapshot.size} new/modified documents in [${collectionName}]. Applying deltas...`);

        let newestTime = lastSync || '';
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const id = doc.id;
            
            // Keep track of the newest timestamp for next sync
            if (data.lastUpdatedTime && data.lastUpdatedTime > newestTime) {
                newestTime = data.lastUpdatedTime;
            }

            // Update SQLite
            await upsertFunc(id, data);

            // Update In-Memory Map
            if (collectionName === 'modes') {
                this.modes.set(id, data as TransportMode);
            } else if (collectionName === 'lines') {
                this.lines.set(id, { ...data, id, modeName: data.modeName });
            } else if (collectionName === 'routes') {
                this.routes.set(id, data);
            } else if (collectionName === 'lineStatuses') {
                this.lineStatuses.set(id, data);
            } else {
                this.stations.set(id, { ...data, id: (data as any).naptanId || id } as Station);
            }
        }

        if (newestTime) {
            await LocalDbService.updateLastSyncTime(collectionName, newestTime);
        }
    }

    private static setupRealtimeListeners() {
        // Only listen for updates that happen *after* we boot.
        // Without this timestamp filter, onSnapshot fetches the ENTIRE collection (20K rows) on first load!
        const bootTime = new Date().toISOString();

        db.collection('modes').where('lastUpdatedTime', '>', bootTime).onSnapshot(snapshot => {
            snapshot.docChanges().forEach(async change => {
                const data = change.doc.data() as TransportMode;
                const id = change.doc.id;
                if (change.type === 'removed') {
                    this.modes.delete(id);
                    await LocalDbService.run('DELETE FROM modes WHERE id = ?', [id]);
                } else {
                    this.modes.set(id, data);
                    await LocalDbService.upsertMode(id, data);
                }
            });
        });

        db.collection('stations').where('lastUpdatedTime', '>', bootTime).onSnapshot(snapshot => {
            snapshot.docChanges().forEach(async change => {
                const data = change.doc.data() as Station;
                const id = change.doc.id;
                if (change.type === 'removed') {
                    this.stations.delete(id);
                    await LocalDbService.run('DELETE FROM stations WHERE id = ?', [id]);
                } else {
                    const mappedData = { ...data, id: data.naptanId || id };
                    this.stations.set(id, mappedData);
                    await LocalDbService.upsertStation(id, mappedData);
                }
            });
        });

        // Sync Lines
        db.collection('lines').where('lastUpdatedTime', '>', bootTime).onSnapshot(snapshot => {
            snapshot.docChanges().forEach(async change => {
                const data = change.doc.data();
                const id = change.doc.id;
                if (change.type === 'removed') {
                    this.lines.delete(id);
                    await LocalDbService.run('DELETE FROM lines WHERE id = ?', [id]);
                } else {
                    this.lines.set(id, { ...data, id, modeName: data.modeName });
                    await LocalDbService.upsertLine(id, data.modeName, data);
                }
            });
        });

        // Sync Routes
        db.collection('routes').where('lastUpdatedTime', '>', bootTime).onSnapshot(snapshot => {
            snapshot.docChanges().forEach(async change => {
                const data = change.doc.data();
                const id = change.doc.id;
                if (change.type === 'removed') {
                    this.routes.delete(id);
                    await LocalDbService.run('DELETE FROM routes WHERE id = ?', [id]);
                } else {
                    this.routes.set(id, data);
                    await LocalDbService.upsertRoute(id, data);
                }
            });
        });

        // Sync Line Statuses
        db.collection('lineStatuses').where('lastUpdatedTime', '>', bootTime).onSnapshot(snapshot => {
            snapshot.docChanges().forEach(async change => {
                const data = change.doc.data();
                const id = change.doc.id;
                if (change.type === 'removed') {
                    this.lineStatuses.delete(id);
                    await LocalDbService.run('DELETE FROM line_statuses WHERE id = ?', [id]);
                } else {
                    this.lineStatuses.set(id, data);
                    await LocalDbService.upsertLineStatus(id, data);
                }
            });
        });
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
     * Search stations by text (commonName / naptanId) OR by exact searchKey match (e.g. line ID "39").
     * Falls back to fuzzy (Levenshtein) matching so single-character typos still resolve.
     */
    static searchStationsByQuery(query: string): Station[] {
        const q = query.toLowerCase().trim();
        const all = this.getAllStations();

        // Exact searchKey match takes priority (bus route IDs like "39")
        const bySearchKey = all.filter(s =>
            Array.isArray((s as any).searchKeys) &&
            (s as any).searchKeys.some((k: string) => k.toLowerCase() === q)
        );
        if (bySearchKey.length > 0) return bySearchKey;

        // Substring match on commonName / naptanId
        const exact = all.filter(s =>
            (s.commonName || "").toLowerCase().includes(q) ||
            (s.naptanId || "").toLowerCase().includes(q)
        );
        if (exact.length > 0) return exact.slice(0, 50);

        // Fuzzy fallback: match individual words with small edit distance
        const qWords = q.split(/\s+/).filter(w => w.length > 2);
        if (qWords.length === 0) return [];
        return all.filter(s => {
            const nameWords = (s.commonName || "").toLowerCase().split(/[\s,\-\/]+/);
            return qWords.some(qw =>
                nameWords.some(nw => {
                    if (nw.includes(qw) || qw.includes(nw)) return true;
                    const maxDist = qw.length > 5 ? 2 : 1;
                    return this.levenshtein(qw, nw) <= maxDist;
                })
            );
        }).slice(0, 50);
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

    /** Returns all stations with coordinates, sorted nearest-first then A-Z. Optionally filtered by mode. */
    static getNearbyStations(lat: number, lon: number, mode?: string): any[] {
        const results: any[] = [];

        this.stations.forEach((data) => {
            if (!data.lat || !data.lon) return;
            if (mode && !(data.modes && Object.keys(data.modes).some(m => m.toLowerCase() === mode.toLowerCase()))) return;

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
                // Keep the closer stop as the representative for the group
                if ((s.distance ?? Infinity) < (existing.distance ?? Infinity)) {
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

    static getRoute(lineId: string): any | null {
        return this.routes.get(lineId) || null;
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

