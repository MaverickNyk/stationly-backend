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
            // Admin notification send-log — LOCAL ONLY, deliberately NOT in
            // Firestore. An audit trail of admin pushes costs zero Firestore
            // reads/writes by living here on disk alongside the replication
            // cache. `createdAt` is epoch millis (integer). Raw FCM tokens are
            // NEVER stored — `audienceSummary` is redacted/aggregated.
            `CREATE TABLE IF NOT EXISTS admin_notifications (
                id TEXT PRIMARY KEY,
                createdAt INTEGER,
                audienceType TEXT,
                audienceSummary TEXT,
                payloadType TEXT,
                title TEXT,
                body TEXT,
                severity TEXT,
                successCount INTEGER,
                failureCount INTEGER,
                messageId TEXT,
                ok INTEGER
            )`,
            // Master→slave replicas of the `users` and `waitlist` Firestore
            // collections (Firestore = master, these SQLite tables = slave, the
            // in-memory copies in AdminDataService = cache). Persisted locally so
            // the admin portal serves them with ZERO per-request Firestore reads;
            // refreshed from master only on explicit demand. Only the fields the
            // portal displays are mirrored (minimal PII).
            `CREATE TABLE IF NOT EXISTS users (
                uid TEXT PRIMARY KEY,
                email TEXT,
                displayName TEXT,
                photoURL TEXT,
                signInProvider TEXT,
                createdAt INTEGER,
                updatedAt INTEGER,
                lastLoggedInTime INTEGER,
                loggedIn INTEGER,
                emailVerified INTEGER,
                stationCount INTEGER,
                sessions TEXT,
                stations TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS user_waitlist (
                id TEXT PRIMARY KEY,
                email TEXT,
                joinedAt INTEGER
            )`,
            // Indexes for speed
            `CREATE INDEX IF NOT EXISTS idx_stations_naptan ON stations(naptanId)`,
            `CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(commonName)`,
            `CREATE INDEX IF NOT EXISTS idx_stations_coords ON stations(lat, lon)`,
            `CREATE INDEX IF NOT EXISTS idx_keys_status ON api_keys(status)`,
            `CREATE INDEX IF NOT EXISTS idx_lines_mode ON lines(modeName)`,
            `CREATE INDEX IF NOT EXISTS idx_admin_notif_created ON admin_notifications(createdAt DESC)`
        ];

        for (const query of queries) {
            await this.run(query);
        }
        await this.migrate();
    }

    /**
     * Idempotent column additions for tables that already exist on a deployed
     * box (CREATE TABLE IF NOT EXISTS won't add new columns to an old table).
     * Each ALTER throws "duplicate column" on a fresh DB that already has it —
     * harmless, so we swallow it. The `users` slave is re-populated from the
     * master on refresh, so no data backfill is needed.
     */
    private static async migrate(): Promise<void> {
        const adds = [
            'ALTER TABLE users ADD COLUMN photoURL TEXT',
            'ALTER TABLE users ADD COLUMN signInProvider TEXT',
            'ALTER TABLE users ADD COLUMN updatedAt INTEGER',
            'ALTER TABLE users ADD COLUMN sessions TEXT',
            'ALTER TABLE users ADD COLUMN stations TEXT',
        ];
        for (const a of adds) {
            try { await this.run(a); } catch { /* column already exists */ }
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

    // --- Admin notification send-log (local-only audit trail) ---

    /** Append one send to the local audit log. `createdAt` is epoch millis. */
    static async insertAdminNotification(entry: {
        id: string;
        createdAt: number;
        audienceType: string;
        audienceSummary: string;
        payloadType: string;
        title: string;
        body: string;
        severity: string;
        successCount: number;
        failureCount: number;
        messageId: string;
        ok: boolean;
    }): Promise<void> {
        await this.run(
            `INSERT OR REPLACE INTO admin_notifications
             (id, createdAt, audienceType, audienceSummary, payloadType, title, body, severity, successCount, failureCount, messageId, ok)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                entry.id, entry.createdAt, entry.audienceType, entry.audienceSummary,
                entry.payloadType, entry.title, entry.body, entry.severity,
                entry.successCount, entry.failureCount, entry.messageId, entry.ok ? 1 : 0,
            ]
        );
    }

    /** Most-recent sends first. Limit is clamped to a sane range. */
    static async listAdminNotifications(limit: number = 50): Promise<any[]> {
        const lim = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
        return this.all(
            `SELECT id, createdAt, audienceType, audienceSummary, payloadType, title, body, severity, successCount, failureCount, messageId, ok
             FROM admin_notifications ORDER BY createdAt DESC LIMIT ?`,
            [lim]
        );
    }

    /**
     * Keep only the most-recent `keep` rows. Fire-and-forget housekeeping so
     * the audit log can't grow unbounded on a long-lived instance.
     */
    static async purgeAdminNotifications(keep: number = 500): Promise<void> {
        await this.run(
            `DELETE FROM admin_notifications WHERE id NOT IN (
                SELECT id FROM admin_notifications ORDER BY createdAt DESC LIMIT ?
            )`,
            [Math.max(keep, 1)]
        );
    }

    // --- users / waitlist slave replicas (master = Firestore) ---

    /**
     * Run `fn`'s writes inside a single SQLite transaction — atomic (a failed
     * bulk replace never leaves the table half-written) and much faster than
     * autocommit-per-row for large snapshots.
     */
    private static async inTransaction(fn: () => Promise<void>): Promise<void> {
        await this.run('BEGIN');
        try {
            await fn();
            await this.run('COMMIT');
        } catch (e) {
            await this.run('ROLLBACK').catch(() => { /* nothing to roll back */ });
            throw e;
        }
    }

    /** Wholesale replace the local `users` slave from a master snapshot (atomic). */
    static async replaceUsers(rows: Array<{
        uid: string; email: string; displayName: string;
        photoURL: string; signInProvider: string;
        createdAt: number; updatedAt: number; lastLoggedInTime: number;
        loggedIn: boolean; emailVerified: boolean; stationCount: number;
        sessions: string; stations: string;
    }>): Promise<void> {
        await this.inTransaction(async () => {
            await this.run('DELETE FROM users');
            for (const r of rows) {
                await this.run(
                    `INSERT OR REPLACE INTO users
                     (uid, email, displayName, photoURL, signInProvider, createdAt, updatedAt,
                      lastLoggedInTime, loggedIn, emailVerified, stationCount, sessions, stations)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [r.uid, r.email, r.displayName, r.photoURL, r.signInProvider, r.createdAt, r.updatedAt,
                     r.lastLoggedInTime, r.loggedIn ? 1 : 0, r.emailVerified ? 1 : 0, r.stationCount,
                     r.sessions, r.stations]
                );
            }
        });
    }

    static async allUsers(): Promise<any[]> {
        return this.all(
            `SELECT uid, email, displayName, photoURL, signInProvider, createdAt, updatedAt,
                    lastLoggedInTime, loggedIn, emailVerified, stationCount, sessions, stations
             FROM users ORDER BY createdAt DESC`
        );
    }

    /** Wholesale replace the local `user_waitlist` slave from a master snapshot (atomic). */
    static async replaceWaitlist(rows: Array<{
        id: string; email: string; joinedAt: number;
    }>): Promise<void> {
        await this.inTransaction(async () => {
            await this.run('DELETE FROM user_waitlist');
            for (const r of rows) {
                await this.run(
                    `INSERT OR REPLACE INTO user_waitlist (id, email, joinedAt) VALUES (?, ?, ?)`,
                    [r.id, r.email, r.joinedAt]
                );
            }
        });
    }

    static async allWaitlist(): Promise<any[]> {
        return this.all(`SELECT id, email, joinedAt FROM user_waitlist ORDER BY joinedAt DESC`);
    }
}
