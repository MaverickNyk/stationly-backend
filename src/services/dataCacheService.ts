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

        console.log(`CACHE: 📁 Load from SQLite success. Modes: ${this.modes.size}, Stations: ${this.stations.size}, Lines: ${this.lines.size}, Routes: ${this.routes.size}`);
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

    /**
     * Search stations by text (commonName / naptanId) OR by exact searchKey match (e.g. line ID "39").
     * Exact searchKey match takes priority so bus route lookups work correctly.
     */
    static searchStationsByQuery(query: string): Station[] {
        const q = query.toLowerCase();
        const all = this.getAllStations();

        // First try exact match against the searchKeys array (e.g. line id "39")
        const bySearchKey = all.filter(s =>
            Array.isArray((s as any).searchKeys) &&
            (s as any).searchKeys.some((k: string) => k.toLowerCase() === q)
        );
        if (bySearchKey.length > 0) return bySearchKey;

        // Fall back to text search on commonName / naptanId
        return all.filter(s =>
            (s.commonName || "").toLowerCase().includes(q) ||
            (s.naptanId || "").toLowerCase().includes(q)
        ).slice(0, 50);
    }

    /**
     * Search stations by proximity
     */
    static getNearbyStations(lat: number, lon: number, radiusKm: number, mode?: string): any[] {
        const results: any[] = [];
        const startLat = lat;
        const startLon = lon;

        this.stations.forEach((data) => {
            if (data.lat && data.lon) {
                // Quick bounding box check for performance
                const diffLat = Math.abs(data.lat - startLat);
                if (diffLat > radiusKm / 111) return; // ~111km per degree lat

                const dLat = (data.lat - startLat) * (Math.PI / 180);
                const dLon = (data.lon - startLon) * (Math.PI / 180);
                const a =
                    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(startLat * (Math.PI / 180)) * Math.cos(data.lat * (Math.PI / 180)) *
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                const distance = 6371 * c; // KM

                if (distance <= radiusKm) {
                    const stopType = data.stopType || 'N/A';
                    const isMajor = stopType.includes('MetroStation') || stopType.includes('RailStation');

                    if (mode) {
                        const hasMode = data.modes && Object.keys(data.modes).some(m => m.toLowerCase() === mode.toLowerCase());
                        if (!hasMode) return;
                    }

                    results.push({
                        ...data,
                        label: data.commonName,
                        isMajor,
                        distance: Math.round(distance * 1000) // meters
                    });
                }
            }
        });

        return results;
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
}

