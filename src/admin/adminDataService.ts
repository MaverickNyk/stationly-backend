import { db } from '../config/firebase';
import { LocalDbService } from '../services/localDbService';
import { toEpochMs } from '../utils/timestamps';
import { readSupportMoneyEntries } from '../services/userService';
import { AdminMirror, isLeaderWorker } from './adminMirror';

/**
 * Read service for the admin portal's Users + Waitlist views. Follows the
 * same master→slave→cache model as the rest of the backend:
 *   - Firestore  = master
 *   - SQLite     = slave replica (the `users` / `user_waitlist` tables)
 *   - in-memory  = cache (the arrays below)
 *
 * The portal must NOT generate Firestore reads on normal use:
 *   - At boot we warm the in-memory cache from the SQLite slave (0 reads).
 *   - `getUsers()` / `getWaitlist()` / `getUserDetail()` serve that cache → 0 reads.
 *   - A read from master happens ONLY on an explicit Refresh (or first-ever
 *     load when the slave is empty), then is written back to the slave.
 *
 * `refreshUsers` reads the full user docs, so sessions + subscribed stations
 * are cached too — the per-user detail view costs zero extra reads.
 */

export interface DeviceSession {
    deviceId: string;
    platform?: string;
    osVersion?: string;
    model?: string;
    appVersion?: string;
    firstSeen?: string;
    lastSeen?: string;
}

export interface SubscribedStation {
    id: string;
    name: string;
    line: string;
    mode: string;
    direction?: string;
}

/**
 * What the account has given, from its `supportMoney` ledger. `entries` keep
 * the txn ids so payments can be matched to platforms server-side; the
 * controllers strip them before anything reaches the browser.
 */
export interface AdminUserSupport {
    count: number;
    totalMinor: number;
    lastAtMs: number;
    /** The payments themselves (newest first, capped), so each can be matched to a platform. */
    entries?: Array<{ txnId: string; atMs: number; amountMinor: number; currency: string }>;
}

/** Full user record (detail view). */
export interface AdminUser {
    uid: string;
    email: string;
    displayName: string;
    photoURL: string;
    signInProvider: string;
    createdAt: number;
    updatedAt: number;
    lastLoggedInTime: number;
    loggedIn: boolean;
    emailVerified: boolean;
    stationCount: number;
    sessions: DeviceSession[];
    stations: SubscribedStation[];
    /** v1 `stations` entries left on an account that now uses `boards`. Not counted. */
    legacyStations?: SubscribedStation[];
    support: AdminUserSupport;
}

/** Trimmed shape for the list view (no sessions/stations payload). */
export interface AdminUserSummary {
    uid: string;
    email: string;
    displayName: string;
    createdAt: number;
    lastLoggedInTime: number;
    loggedIn: boolean;
    emailVerified: boolean;
    stationCount: number;
    signInProvider: string;
    /** Platforms the account has a device on, from `users/{uid}/devices`. */
    platforms: string[];
    /** Latest `lastSeen` across its devices, epoch ms (0 = never). */
    lastSeen: number;
    /** App version of the most recently seen device per platform. */
    versions: Record<string, string>;
    support: AdminUserSupport;
}

export interface AdminWaitlistRow {
    id: string;
    email: string;
    joinedAt: number;
}

export interface CachedResult<T> {
    rows: T[];
    cached: boolean;
    refreshedAt: number;
}

export class AdminDataService {
    private static users: AdminUser[] = [];
    private static waitlist: AdminWaitlistRow[] = [];
    private static usersRefreshedAt = 0;
    private static waitlistRefreshedAt = 0;
    private static warmed = false;
    // Detail for uids NOT in the list snapshot (rare fallback). Kept separate
    // from `users` so a single-doc fetch never pollutes the list cache.
    private static detailFallback = new Map<string, AdminUser>();

    static async warmFromSqlite(): Promise<void> {
        if (this.warmed) return;
        try {
            this.users = (await LocalDbService.allUsers()).map(rowToUser);
            this.usersRefreshedAt = Number(await AdminMirror.getMeta('users_version').catch(() => null)) || 0;
            this.waitlist = (await LocalDbService.allWaitlist()).map(rowToWaitlist);
            console.log(`ADMIN_DATA: 📁 Warmed from SQLite — users: ${this.users.length}, waitlist: ${this.waitlist.length}`);
        } catch (e) {
            console.warn('ADMIN_DATA: warm from SQLite failed', e);
        }
        this.warmed = true;
    }

    // ── Users ──────────────────────────────────────────────────────────

    /**
     * `refresh` re-reads ONLY the accounts that changed since the last sync
     * (see AdminMirror). `full` re-reads the whole collection, which is the
     * expensive path, kept for a deliberate resync.
     */
    static async getUsers(opts?: { refresh?: boolean; full?: boolean }): Promise<CachedResult<AdminUserSummary>> {
        await this.warmFromSqlite();
        await this.ensureFresh();
        const empty = this.users.length === 0 && this.usersRefreshedAt === 0;
        if (opts?.full || empty) await this.refreshUsers();
        else if (opts?.refresh) await this.syncChanged();
        return { rows: this.users.map(toSummary), cached: !(opts?.full || opts?.refresh || empty), refreshedAt: this.usersRefreshedAt };
    }

    /**
     * Another PM2 worker (the hourly job, or an admin refresh it served) may
     * have updated the shared SQLite slave. A local read, no Firestore.
     */
    private static async ensureFresh(): Promise<void> {
        const v = Number(await AdminMirror.getMeta('users_version').catch(() => null)) || 0;
        if (v > this.usersRefreshedAt) {
            this.users = (await LocalDbService.allUsers()).map(rowToUser);
            this.usersRefreshedAt = v;
            this.detailFallback.clear();
        }
    }

    private static syncing: Promise<{ synced: number; removed: number; reads: number }> | null = null;

    /**
     * Re-read only the accounts marked changed: one user doc plus one devices
     * query each. Accounts nobody touched cost nothing.
     */
    static syncChanged(): Promise<{ synced: number; removed: number; reads: number }> {
        this.syncing ??= (async () => {
            const upTo = Date.now();
            const uids = await AdminMirror.dirtyUids(upTo);
            let synced = 0, removed = 0, reads = 0;
            for (const uid of uids) {
                const ref = db.collection('users').doc(uid);
                const doc = await ref.get();
                reads++;
                if (!doc.exists) {
                    await LocalDbService.run('DELETE FROM users WHERE uid = ?', [uid]);
                    this.users = this.users.filter((u) => u.uid !== uid);
                    removed++;
                    continue;
                }
                const devs = await ref.collection('devices').get();
                reads += Math.max(1, devs.size);
                const user = mapUserDoc(uid, doc.data() || {}, devs.docs.map((d) => d.data()));
                await LocalDbService.upsertUser(toRow(user));
                const i = this.users.findIndex((u) => u.uid === uid);
                if (i >= 0) this.users[i] = user; else this.users.unshift(user);
                this.detailFallback.delete(uid);
                synced++;
            }
            await AdminMirror.clearDirty(uids, upTo);
            this.usersRefreshedAt = Date.now();
            await AdminMirror.setMeta('users_version', String(this.usersRefreshedAt));
            if (uids.length) console.log(`ADMIN_DATA: synced ${synced} changed accounts, removed ${removed}, ~${reads} reads`);
            return { synced, removed, reads };
        })().finally(() => { this.syncing = null; });
        return this.syncing;
    }

    /** Hourly on the leader worker: sync changed accounts, trim the activity copy. */
    static startHourlySync(): void {
        if (!isLeaderWorker()) return;
        const run = async () => {
            if (!LocalDbService.isOpen()) return;
            try { await this.warmFromSqlite(); await this.syncChanged(); }
            catch (e: any) { console.warn('ADMIN_DATA: hourly sync failed', e?.message); }
            try { await AdminMirror.purgeActivity(); } catch { /* next hour */ }
        };
        setTimeout(run, 60_000).unref();
        setInterval(run, 60 * 60_000).unref();
    }

    /**
     * Full detail for one user — from the cache (0 reads). Falls back to a
     * single Firestore doc read if the uid isn't cached (e.g. a stale slave),
     * which is the one and only read this path can incur.
     */
    static async getUserDetail(uid: string): Promise<AdminUser | null> {
        await this.warmFromSqlite();
        await this.ensureFresh();
        const hit = this.users.find((u) => u.uid === uid) || this.detailFallback.get(uid);
        if (hit) return hit;

        // Only reached if the uid isn't in the cached snapshot — one doc read,
        // then cached so a repeat view costs nothing.
        const doc = await db.collection('users').doc(uid).get();
        if (!doc.exists) return null;
        const devs = await db.collection('users').doc(uid).collection('devices').get();
        const mapped = mapUserDoc(uid, doc.data() || {}, devs.docs.map((d) => d.data()));
        this.detailFallback.set(uid, mapped);
        return mapped;
    }

    private static async refreshUsers(): Promise<void> {
        const snap = await db.collection('users').get();

        // ONE collection-group read for every account's devices, rather than a
        // per-user subcollection read inside the map. This runs over the whole
        // user base on an explicit admin refresh, so N+1 reads here would be N+1
        // Firestore reads — the exact cost this codebase's SQLite mirror exists
        // to avoid. The unfiltered group query needs no index; verified on
        // staging rather than assumed (`check_device_indexes.cjs`).
        const byUid = new Map<string, any[]>();
        const devSnap = await db.collectionGroup('devices').get();
        for (const d of devSnap.docs) {
            const account = d.ref.parent.parent;
            // Skips the retired ROOT `devices` collection, which a collection
            // group also matches until it is gone.
            if (!account) continue;
            const list = byUid.get(account.id) ?? [];
            list.push(d.data());
            byUid.set(account.id, list);
        }

        const upTo = Date.now();
        this.users = snap.docs.map((d) => mapUserDoc(d.id, d.data() || {}, byUid.get(d.id) ?? []));
        this.usersRefreshedAt = upTo;
        this.detailFallback.clear(); // fresh snapshot supersedes any fallbacks
        await LocalDbService.replaceUsers(this.users.map(toRow));
        // Everything is current now, so every earlier change mark is spent.
        await AdminMirror.clearDirty(await AdminMirror.dirtyUids(upTo), upTo).catch(() => undefined);
        await AdminMirror.setMeta('users_version', String(upTo)).catch(() => undefined);
        console.log(`ADMIN_DATA: FULL users read: ${snap.size} accounts + ${devSnap.size} devices`);
    }

    // ── Waitlist ───────────────────────────────────────────────────────

    static async getWaitlist(opts?: { refresh?: boolean }): Promise<CachedResult<AdminWaitlistRow>> {
        await this.warmFromSqlite();
        const mustFetch = opts?.refresh || (this.waitlist.length === 0 && this.waitlistRefreshedAt === 0);
        if (mustFetch) await this.refreshWaitlist();
        return { rows: this.waitlist, cached: !mustFetch, refreshedAt: this.waitlistRefreshedAt };
    }

    private static async refreshWaitlist(): Promise<void> {
        const snap = await db.collection('waitlist').get();
        this.waitlist = snap.docs.map((d) => {
            const x = d.data() || {};
            return { id: d.id, email: x.email || '', joinedAt: toEpochMs(x.joinedAt) ?? 0 };
        });
        this.waitlistRefreshedAt = Date.now();
        await LocalDbService.replaceWaitlist(this.waitlist);
    }

    // ── Dashboard counts (from cache; 0 reads) ──────────────────────────

    /** The full cached users, for the insights views. Call after `getUsers()`. */
    static allUsers(): AdminUser[] { return this.users; }
    static usersCount(): number { return this.users.length; }
    static activeUsersCount(): number { return this.users.filter((u) => u.loggedIn).length; }
    static waitlistCount(): number { return this.waitlist.length; }
    static lastRefreshed(): { users: number; waitlist: number } {
        return { users: this.usersRefreshedAt, waitlist: this.waitlistRefreshedAt };
    }
}

/** Firestore user doc → full AdminUser. */
function mapUserDoc(uid: string, x: any, deviceRows: any[] = []): AdminUser {
    // ⚠️ Sessions now come from `users/{uid}/devices`, NOT from `x.sessions`.
    //
    // The field name on AdminUser is deliberately unchanged so the admin view
    // above it does not move. What changed is only where the value is read from.
    //
    // Getting this wrong would not have errored. `refreshUsers` reads full user
    // documents, so an admin left pointing at the deleted map would simply have
    // reported EVERY account as having no devices at all — a silent, plausible,
    // completely wrong answer.
    const sessions: DeviceSession[] = deviceRows.map((r: any) => ({
        deviceId: r.deviceId,
        platform: r.platform,
        osVersion: r.osVersion,
        model: r.model,
        appVersion: r.appVersion,
        // Epoch ms on the merged row where the map held ISO strings. The admin's
        // own `toEpochMs` coercion downstream accepts both, so this is presented
        // as-is rather than reformatted into a string it would only re-parse.
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
    }));
    // Both board lists: the v1 `stations` array and the v2 `boards` (iOS and
    // Android 2.0). Reading only `stations` showed every v2 account as having none.
    const legacy: SubscribedStation[] = Array.isArray(x.stations)
        ? x.stations.map((s: any) => ({ id: s.id, name: s.name, line: s.line, mode: s.mode, direction: s.direction }))
        : [];
    const boards: SubscribedStation[] = Array.isArray(x.boards)
        ? x.boards.filter((b: any) => b && b.id).map((b: any) => {
            const sel = Array.isArray(b.selections) ? b.selections : [];
            const lines = [...new Set(sel.map((z: any) => z?.line).filter(Boolean))] as string[];
            const modes = [...new Set(sel.map((z: any) => z?.mode).filter(Boolean))] as string[];
            const dirs = [...new Set(sel.map((z: any) => z?.direction).filter(Boolean))] as string[];
            return { id: b.id, name: b.name || b.id, line: lines.join(', '), mode: modes.join(', '), direction: dirs.join(' · ') || undefined };
        })
        : [];
    // An account with a `boards` list (iOS, Android 2.0) shows THAT, as the
    // phone does. Its v1 `stations` list can still hold entries 2.0 never
    // cleared (one per line and direction), which are not boards; they are
    // kept apart as `legacyStations` rather than added to the count.
    const hasBoards = Array.isArray(x.boards);
    const stations = hasBoards ? boards : legacy;
    const legacyStations = hasBoards ? legacy : [];
    return {
        uid,
        email: x.email || '',
        displayName: x.displayName || '',
        photoURL: x.photoURL || '',
        signInProvider: x.signInProvider || '',
        createdAt: toEpochMs(x.createdAt) ?? 0,
        updatedAt: toEpochMs(x.updatedAt) ?? 0,
        lastLoggedInTime: toEpochMs(x.lastLoggedInTime) ?? 0,
        loggedIn: x.loggedIn === true,
        emailVerified: x.emailVerified === true,
        stationCount: stations.length,
        sessions,
        stations,
        legacyStations,
        support: supportOf(x.supportMoney),
    };
}

/**
 * Apple payments recorded before the milliunits fix were stored 1000 times too
 * big (£12 as 1,200,000 pence). No real contribution is over £1,000, so an
 * Apple amount at least that large and a whole multiple of 1000 is one of
 * those, and is shown divided back. The stored ledger is left as it is.
 */
export function correctedAmount(txnId: string, amountMinor: number): number {
    if (txnId.startsWith('apple_') && amountMinor >= 100_000 && amountMinor % 1000 === 0) return amountMinor / 1000;
    return amountMinor;
}

function supportOf(raw: unknown): AdminUserSupport {
    const entries = readSupportMoneyEntries(raw).map((e) => ({ ...e, amountMinor: correctedAmount(e.txnId, e.amountMinor) }));
    return {
        count: entries.length,
        totalMinor: entries.filter((e) => e.currency === 'GBP').reduce((a, e) => a + Math.max(0, e.amountMinor), 0),
        lastAtMs: entries[0]?.atMs ?? 0,
        entries: entries.slice(0, 100).map((e) => ({ txnId: e.txnId, atMs: e.atMs, amountMinor: e.amountMinor, currency: e.currency })),
    };
}

/** SQLite row → full AdminUser. */
function rowToUser(r: any): AdminUser {
    const parse = <T>(s: any, fallback: T): T => {
        if (typeof s !== 'string' || !s) return fallback;
        try { return JSON.parse(s) as T; } catch { return fallback; }
    };
    return {
        uid: r.uid,
        email: r.email || '',
        displayName: r.displayName || '',
        photoURL: r.photoURL || '',
        signInProvider: r.signInProvider || '',
        createdAt: r.createdAt || 0,
        updatedAt: r.updatedAt || 0,
        lastLoggedInTime: r.lastLoggedInTime || 0,
        loggedIn: r.loggedIn === 1,
        emailVerified: r.emailVerified === 1,
        stationCount: r.stationCount || 0,
        sessions: parse<DeviceSession[]>(r.sessions, []),
        stations: parse<SubscribedStation[]>(r.stations, []),
        legacyStations: parse<SubscribedStation[]>(r.legacyStations, []),
        support: parse<AdminUserSupport>(r.support, { count: 0, totalMinor: 0, lastAtMs: 0 }),
    };
}

/** Full AdminUser → SQLite row (sessions/stations as JSON). */
function toRow(u: AdminUser) {
    return {
        uid: u.uid,
        email: u.email,
        displayName: u.displayName,
        photoURL: u.photoURL,
        signInProvider: u.signInProvider,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        lastLoggedInTime: u.lastLoggedInTime,
        loggedIn: u.loggedIn,
        emailVerified: u.emailVerified,
        stationCount: u.stationCount,
        sessions: JSON.stringify(u.sessions),
        stations: JSON.stringify(u.stations),
        support: JSON.stringify(u.support),
        legacyStations: JSON.stringify(u.legacyStations ?? []),
    };
}

function toSummary(u: AdminUser): AdminUserSummary {
    return {
        uid: u.uid,
        email: u.email,
        displayName: u.displayName,
        createdAt: u.createdAt,
        lastLoggedInTime: u.lastLoggedInTime,
        loggedIn: u.loggedIn,
        emailVerified: u.emailVerified,
        stationCount: u.stationCount,
        signInProvider: u.signInProvider,
        ...deviceSummary(u.sessions),
        support: { count: u.support?.count ?? 0, totalMinor: u.support?.totalMinor ?? 0, lastAtMs: u.support?.lastAtMs ?? 0 },
    };
}

function deviceSummary(sessions: DeviceSession[]): { platforms: string[]; lastSeen: number; versions: Record<string, string> } {
    const platforms = new Set<string>();
    const newest: Record<string, number> = {};
    const versions: Record<string, string> = {};
    let lastSeen = 0;
    for (const s of sessions ?? []) {
        const p = String(s.platform ?? '').toLowerCase();
        if (!p) continue;
        platforms.add(p);
        const seen = toEpochMs(s.lastSeen) ?? 0;
        lastSeen = Math.max(lastSeen, seen);
        if (s.appVersion && seen >= (newest[p] ?? -1)) { newest[p] = seen; versions[p] = s.appVersion; }
    }
    return { platforms: [...platforms].sort(), lastSeen, versions };
}

function rowToWaitlist(r: any): AdminWaitlistRow {
    return { id: r.id, email: r.email || '', joinedAt: r.joinedAt || 0 };
}
