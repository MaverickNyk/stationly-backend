import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

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

    static async getLastSyncTime(collection: string): Promise<string | null> {
        const row = await this.get<{ value: string }>('SELECT value FROM sync_metadata WHERE key = ?', [`last_sync_${collection}`]);
        return row ? row.value : null;
    }

    static async updateLastSyncTime(collection: string, time: string): Promise<void> {
        await this.run('INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)', [`last_sync_${collection}`, time]);
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
}
