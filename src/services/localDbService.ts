import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { toEpochMs } from '../utils/timestamps';

export class LocalDbService {
    private static db: sqlite3.Database | null = null;
    private static dbPath = path.resolve(process.cwd(), 'data', 'stationly.sqlite');

    static async initialize(): Promise<void> {
        if (this.db) return;

        // Ensure directory exists
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error("SQLITE: ❌ Failed to connect:", err);
                    reject(err);
                } else {
                    console.log("SQLITE: 📁 Connected specifically to local database.");
                    this.createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    private static async createTables(): Promise<void> {
        const queries = [
            `CREATE TABLE IF NOT EXISTS sync_metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS stations (
                id TEXT PRIMARY KEY,
                naptanId TEXT,
                commonName TEXT,
                lat REAL,
                lon REAL,
                lastUpdatedTime TEXT,
                raw_data TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS modes (
                id TEXT PRIMARY KEY,
                modeName TEXT,
                displayName TEXT,
                raw_data TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS api_keys (
                key TEXT PRIMARY KEY,
                clientId TEXT,
                tier TEXT,
                clientName TEXT,
                status TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS subscribed_stations (
                naptanId TEXT PRIMARY KEY,
                count INTEGER,
                lastUpdated TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS lines (
                id TEXT PRIMARY KEY,
                modeName TEXT,
                raw_data TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS routes (
                id TEXT PRIMARY KEY,
                raw_data TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS line_statuses (
                id TEXT PRIMARY KEY,
                mode TEXT,
                lastUpdatedTime TEXT,
                raw_data TEXT
            )`,
            // Ephemeral predictions cache — NOT replicated from Firestore.
            // Sourced from TfL, served from here for repeated calls within ~60s,
            // then purged. `lastUpdatedTime` is epoch millis (integer).
            `CREATE TABLE IF NOT EXISTS station_preds (
                stationId TEXT PRIMARY KEY,
                lastUpdatedTime INTEGER,
                raw_data TEXT
            )`,
            // Indexes for speed
            `CREATE INDEX IF NOT EXISTS idx_stations_naptan ON stations(naptanId)`,
            `CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(commonName)`,
            `CREATE INDEX IF NOT EXISTS idx_stations_coords ON stations(lat, lon)`,
            `CREATE INDEX IF NOT EXISTS idx_keys_status ON api_keys(status)`,
            `CREATE INDEX IF NOT EXISTS idx_lines_mode ON lines(modeName)`
        ];

        for (const query of queries) {
            await this.run(query);
        }
    }

    static run(query: string, params: any[] = []): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db?.run(query, params, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    static get<T>(query: string, params: any[] = []): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            this.db?.get(query, params, (err, row) => {
                if (err) reject(err);
                else resolve(row as T);
            });
        });
    }

    static all<T>(query: string, params: any[] = []): Promise<T[]> {
        return new Promise((resolve, reject) => {
            this.db?.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows as T[]);
            });
        });
    }

    // --- High Level Sync Helpers ---

    /**
     * Per-collection replication checkpoint as epoch millis (integer), or null
     * if never synced. Coerces via toEpochMs so a legacy ISO-string checkpoint
     * (left in sync_metadata by the pre-migration code) maps to an epoch instead
     * of being treated as "never synced" — which would force a full re-sync of
     * every collection on the first boot after deploy.
     */
    static async getLastSyncTime(collection: string): Promise<number | null> {
        const row = await this.get<{ value: string }>('SELECT value FROM sync_metadata WHERE key = ?', [`last_sync_${collection}`]);
        if (!row || row.value == null) return null;
        const ms = toEpochMs(row.value);
        return (ms != null && ms > 0) ? ms : null;
    }

    /**
     * Advance a collection's checkpoint to `ms` (epoch millis) — ATOMICALLY and
     * MONOTONICALLY. One statement, no read-before-write, so concurrent listener
     * callbacks can never race the checkpoint backwards: the conditional upsert
     * only overwrites when the incoming value is strictly newer.
     */
    static async updateLastSyncTime(collection: string, ms: number): Promise<void> {
        await this.run(
            `INSERT INTO sync_metadata (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value
             WHERE CAST(excluded.value AS INTEGER) > CAST(sync_metadata.value AS INTEGER)`,
            // Store the integer's string form (not the JS number) so the TEXT
            // column holds "1780…" not "1780….0" (the node driver serializes a
            // bound number as a REAL). CAST handles both, but this keeps it clean.
            [`last_sync_${collection}`, String(ms)]
        );
    }

    static async upsertStation(id: string, data: any): Promise<void> {
        const query = `INSERT OR REPLACE INTO stations (id, naptanId, commonName, lat, lon, lastUpdatedTime, raw_data) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.run(query, [
            id,
            data.naptanId || '',
            data.commonName || '',
            data.lat || 0,
            data.lon || 0,
            data.lastUpdatedTime || '',
            JSON.stringify(data)
        ]);
    }

    static async upsertMode(id: string, data: any): Promise<void> {
        await this.run('INSERT OR REPLACE INTO modes (id, modeName, displayName, raw_data) VALUES (?, ?, ?, ?)', [
            id,
            data.modeName,
            data.displayName,
            JSON.stringify(data)
        ]);
    }

    static async upsertApiKey(key: string, data: any): Promise<void> {
        await this.run('INSERT OR REPLACE INTO api_keys (key, clientId, tier, clientName, status) VALUES (?, ?, ?, ?, ?)', [
            key,
            data.clientId || data.id,
            data.tier || 'free',
            data.clientName || 'Unknown',
            data.status || 'active'
        ]);
    }

    static async updateSubscribedStation(naptanId: string, count: number): Promise<void> {
        if (count <= 0) {
            await this.run('DELETE FROM subscribed_stations WHERE naptanId = ?', [naptanId]);
        } else {
            await this.run('INSERT OR REPLACE INTO subscribed_stations (naptanId, count, lastUpdated) VALUES (?, ?, ?)', [
                naptanId,
                count,
                new Date().toISOString()
            ]);
        }
    }

    static async upsertLine(id: string, modeName: string, data: any): Promise<void> {
        await this.run('INSERT OR REPLACE INTO lines (id, modeName, raw_data) VALUES (?, ?, ?)', [
            id,
            modeName,
            JSON.stringify(data)
        ]);
    }

    static async upsertRoute(id: string, data: any): Promise<void> {
        await this.run('INSERT OR REPLACE INTO routes (id, raw_data) VALUES (?, ?)', [
            id,
            JSON.stringify(data)
        ]);
    }

    static async upsertLineStatus(id: string, data: any): Promise<void> {
        await this.run('INSERT OR REPLACE INTO line_statuses (id, mode, lastUpdatedTime, raw_data) VALUES (?, ?, ?, ?)', [
            id,
            data.mode || '',
            data.lastUpdatedTime || '',
            JSON.stringify(data)
        ]);
    }

    // --- Ephemeral predictions cache (local-only, ~60s TTL) ---

    /** Store a station's predictions with an epoch-millis stamp. */
    static async upsertStationPreds(stationId: string, data: any, ms: number): Promise<void> {
        await this.run('INSERT OR REPLACE INTO station_preds (stationId, lastUpdatedTime, raw_data) VALUES (?, ?, ?)', [
            stationId,
            ms,
            JSON.stringify(data)
        ]);
    }

    /**
     * Predictions for a station IF still fresh (within `maxAgeMs`, default 60s),
     * else null. The freshness is enforced at read time so a stale row is never
     * served even if the async purge hasn't run yet.
     */
    static async getFreshStationPreds(stationId: string, maxAgeMs: number = 60_000): Promise<any | null> {
        const cutoff = Date.now() - maxAgeMs;
        const row = await this.get<{ raw_data: string }>(
            'SELECT raw_data FROM station_preds WHERE stationId = ? AND lastUpdatedTime > ?',
            [stationId, cutoff]
        );
        return row ? JSON.parse(row.raw_data) : null;
    }

    /**
     * Delete predictions older than `maxAgeMs`. Housekeeping only — call as
     * fire-and-forget AFTER responding so it never blocks the read path.
     */
    static async purgeStaleStationPreds(maxAgeMs: number = 60_000): Promise<void> {
        const cutoff = Date.now() - maxAgeMs;
        await this.run('DELETE FROM station_preds WHERE lastUpdatedTime <= ?', [cutoff]);
    }
}
