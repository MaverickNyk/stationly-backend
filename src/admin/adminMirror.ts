import { LocalDbService } from '../services/localDbService';

/**
 * Keeps the admin console's copies of accounts and activity up to date with
 * as few Firestore reads as possible.
 *
 * The backend is the only thing that writes `users/*`, so instead of
 * re-reading whole collections to find out what changed, it notes changes as
 * it makes them, in the local SQLite file every PM2 worker shares:
 *
 *   ACCOUNTS. Every write to an account marks its uid in `admin_dirty_users`
 *   (a local write, free). Once an hour the leader worker reads ONLY those
 *   accounts back from Firestore (the user doc plus its devices) and updates
 *   the `users` slave. An unchanged account costs nothing, ever. A full read
 *   of the collection is kept for an explicit "full resync" only.
 *
 *   ACTIVITY. Every event the apps upload is copied into `activity_mirror`
 *   as it is stored. Analytics and the per-user timeline read that copy, so
 *   they cost no Firestore reads at all. Firestore stays the master; the copy
 *   starts at deploy, and a one-time import fills in the history before it.
 *
 * Marking is fire-and-forget: a failure here must never fail the write that
 * caused it. The worst case of a lost mark is an account that looks stale
 * until its next write or the next full resync.
 */

/** Firestore keeps everything; the local copy only needs what the console shows (90-day view). */
/**
 * A mark is stamped this far in the FUTURE. Callers mark when a write starts,
 * and a sync that ran before the write finished would read the old account and
 * clear the mark, leaving it stale. A mark only becomes due once any write it
 * belongs to has long finished, and a later mark of the same account pushes it
 * out again.
 */
export const MARK_GRACE_MS = 60_000;

const KEEP_ACTIVITY_DAYS = 120;
const DAY = 24 * 3600_000;

let ready: Promise<void> | null = null;

function ensureTables(): Promise<void> {
    if (!LocalDbService.isOpen()) return Promise.reject(new Error('local db not open'));
    ready ??= (async () => {
        await LocalDbService.run('CREATE TABLE IF NOT EXISTS admin_dirty_users (uid TEXT PRIMARY KEY, at INTEGER)');
        await LocalDbService.run('CREATE TABLE IF NOT EXISTS admin_meta (k TEXT PRIMARY KEY, v TEXT)');
        await LocalDbService.run(`CREATE TABLE IF NOT EXISTS activity_mirror (
            id TEXT PRIMARY KEY, uid TEXT, date TEXT, deviceId TEXT, platform TEXT, appVersion TEXT,
            name TEXT, t INTEGER, props TEXT)`);
        await LocalDbService.run('CREATE INDEX IF NOT EXISTS activity_mirror_date ON activity_mirror (date)');
        await LocalDbService.run('CREATE INDEX IF NOT EXISTS activity_mirror_uid_t ON activity_mirror (uid, t)');
    })().catch((e) => { ready = null; throw e; });
    return ready;
}

export class AdminMirror {
    /** Note that an account changed. Never throws, never awaited by callers. */
    static markDirty(...uids: Array<string | null | undefined>): void {
        const list = uids.filter((u): u is string => typeof u === 'string' && u.length > 0);
        if (!list.length || !LocalDbService.isOpen()) return;
        const at = Date.now() + MARK_GRACE_MS;
        ensureTables()
            .then(() => Promise.all(list.map((uid) =>
                LocalDbService.run('INSERT OR REPLACE INTO admin_dirty_users (uid, at) VALUES (?, ?)', [uid, at]))))
            .catch((e) => console.warn('ADMIN_MIRROR: mark failed', e?.message));
    }

    static async dirtyUids(upTo: number): Promise<string[]> {
        await ensureTables();
        const rows = await LocalDbService.all<{ uid: string }>('SELECT uid FROM admin_dirty_users WHERE at <= ?', [upTo]);
        return rows.map((r) => r.uid);
    }

    /** Accounts changed and waiting, including ones still inside their grace period. */
    static async dirtyCount(): Promise<number> {
        if (!LocalDbService.isOpen()) return 0;
        await ensureTables();
        const r = await LocalDbService.get<{ n: number }>('SELECT COUNT(*) AS n FROM admin_dirty_users');
        return r?.n ?? 0;
    }

    /** Clears marks made at or before `upTo`; a mark made during the sync survives for the next one. */
    static async clearDirty(uids: string[], upTo: number): Promise<void> {
        await ensureTables();
        for (const uid of uids) {
            await LocalDbService.run('DELETE FROM admin_dirty_users WHERE uid = ? AND at <= ?', [uid, upTo]);
        }
    }

    static async getMeta(k: string): Promise<string | null> {
        if (!LocalDbService.isOpen()) return null;
        await ensureTables();
        return (await LocalDbService.get<{ v: string }>('SELECT v FROM admin_meta WHERE k = ?', [k]))?.v ?? null;
    }

    static async setMeta(k: string, v: string): Promise<void> {
        await ensureTables();
        await LocalDbService.run('INSERT OR REPLACE INTO admin_meta (k, v) VALUES (?, ?)', [k, v]);
    }

    // ── Activity ─────────────────────────────────────────────────────────

    /** Copy stored events. Idempotent on the client's event id. Never throws. */
    static async recordActivity(input: {
        uid: string; deviceId: string; platform?: string; appVersion?: string;
        events: Array<{ id: string; name: string; t: number; props?: Record<string, unknown> }>;
    }): Promise<void> {
        if (!LocalDbService.isOpen() || !input.events.length) return;
        try {
            await ensureTables();
            // Multi-row statements, 100 rows each: one commit per chunk rather
            // than per row, and no BEGIN on the shared connection to collide
            // with another upload arriving at the same moment.
            for (let i = 0; i < input.events.length; i += 100) {
                const chunk = input.events.slice(i, i + 100);
                const params: unknown[] = [];
                for (const e of chunk) {
                    params.push(`${input.uid}:${e.id}`, input.uid, new Date(e.t).toISOString().slice(0, 10), input.deviceId,
                        input.platform ?? '', input.appVersion ?? '', e.name, e.t, JSON.stringify(e.props ?? {}));
                }
                await LocalDbService.run(
                    `INSERT OR IGNORE INTO activity_mirror (id, uid, date, deviceId, platform, appVersion, name, t, props)
                     VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                    params);
            }
        } catch (e: any) {
            console.warn('ADMIN_MIRROR: activity copy failed', e?.message);
        }
    }

    /** Mirror rows dated `from`..`to` (YYYY-MM-DD), optionally for one account. */
    static async activityRows(from: string, to: string, uid?: string): Promise<Array<{
        uid: string; date: string; deviceId: string; platform: string; appVersion: string; name: string; t: number; props: string;
    }>> {
        await ensureTables();
        return uid
            ? LocalDbService.all('SELECT * FROM activity_mirror WHERE uid = ? AND date >= ? AND date <= ? ORDER BY t DESC LIMIT 5000', [uid, from, to])
            : LocalDbService.all('SELECT uid, date, deviceId, platform, appVersion, name, t, props FROM activity_mirror WHERE date >= ? AND date <= ?', [from, to]);
    }

    /** An account was deleted: drop its local activity too. Never throws. */
    static forgetUser(uid: string): void {
        if (!uid || !LocalDbService.isOpen()) return;
        ensureTables()
            .then(() => LocalDbService.run('DELETE FROM activity_mirror WHERE uid = ?', [uid]))
            .catch((e) => console.warn('ADMIN_MIRROR: forget failed', e?.message));
    }

    static async purgeActivity(now = Date.now()): Promise<void> {
        await ensureTables();
        const cutoff = new Date(now - KEEP_ACTIVITY_DAYS * DAY).toISOString().slice(0, 10);
        await LocalDbService.run('DELETE FROM activity_mirror WHERE date < ?', [cutoff]);
    }

    static async activityStats(): Promise<{ rows: number; oldest: string | null; importedAt: number }> {
        if (!LocalDbService.isOpen()) return { rows: 0, oldest: null, importedAt: 0 };
        await ensureTables();
        const r = await LocalDbService.get<{ n: number; oldest: string | null }>('SELECT COUNT(*) AS n, MIN(date) AS oldest FROM activity_mirror');
        return { rows: r?.n ?? 0, oldest: r?.oldest ?? null, importedAt: Number(await this.getMeta('activity_imported_at')) || 0 };
    }
}

/** The one PM2 worker that runs scheduled jobs (same rule as DataCacheService). */
export const isLeaderWorker = () => process.env.NODE_APP_INSTANCE === undefined || process.env.NODE_APP_INSTANCE === '0';
