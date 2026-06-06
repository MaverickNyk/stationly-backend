import { db } from '../config/firebase';
import { LocalDbService } from '../services/localDbService';
import { toEpochMs } from '../utils/timestamps';

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
            this.waitlist = (await LocalDbService.allWaitlist()).map(rowToWaitlist);
            console.log(`ADMIN_DATA: 📁 Warmed from SQLite — users: ${this.users.length}, waitlist: ${this.waitlist.length}`);
        } catch (e) {
            console.warn('ADMIN_DATA: warm from SQLite failed', e);
        }
        this.warmed = true;
    }

    // ── Users ──────────────────────────────────────────────────────────

    static async getUsers(opts?: { refresh?: boolean }): Promise<CachedResult<AdminUserSummary>> {
        await this.warmFromSqlite();
        const mustFetch = opts?.refresh || (this.users.length === 0 && this.usersRefreshedAt === 0);
        if (mustFetch) await this.refreshUsers();
        return { rows: this.users.map(toSummary), cached: !mustFetch, refreshedAt: this.usersRefreshedAt };
    }

    /**
     * Full detail for one user — from the cache (0 reads). Falls back to a
     * single Firestore doc read if the uid isn't cached (e.g. a stale slave),
     * which is the one and only read this path can incur.
     */
    static async getUserDetail(uid: string): Promise<AdminUser | null> {
        await this.warmFromSqlite();
        const hit = this.users.find((u) => u.uid === uid) || this.detailFallback.get(uid);
        if (hit) return hit;

        // Only reached if the uid isn't in the cached snapshot — one doc read,
        // then cached so a repeat view costs nothing.
        const doc = await db.collection('users').doc(uid).get();
        if (!doc.exists) return null;
        const mapped = mapUserDoc(uid, doc.data() || {});
        this.detailFallback.set(uid, mapped);
        return mapped;
    }

    private static async refreshUsers(): Promise<void> {
        const snap = await db.collection('users').get();
        this.users = snap.docs.map((d) => mapUserDoc(d.id, d.data() || {}));
        this.usersRefreshedAt = Date.now();
        this.detailFallback.clear(); // fresh snapshot supersedes any fallbacks
        await LocalDbService.replaceUsers(this.users.map(toRow));
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

    static usersCount(): number { return this.users.length; }
    static activeUsersCount(): number { return this.users.filter((u) => u.loggedIn).length; }
    static waitlistCount(): number { return this.waitlist.length; }
    static lastRefreshed(): { users: number; waitlist: number } {
        return { users: this.usersRefreshedAt, waitlist: this.waitlistRefreshedAt };
    }
}

/** Firestore user doc → full AdminUser. */
function mapUserDoc(uid: string, x: any): AdminUser {
    const sessionsMap = (x.sessions && typeof x.sessions === 'object') ? x.sessions : {};
    const sessions: DeviceSession[] = Object.entries<any>(sessionsMap).map(([deviceId, s]) => ({
        deviceId,
        platform: s?.platform,
        osVersion: s?.osVersion,
        model: s?.model,
        appVersion: s?.appVersion,
        firstSeen: s?.firstSeen,
        lastSeen: s?.lastSeen,
    }));
    const stations: SubscribedStation[] = Array.isArray(x.stations)
        ? x.stations.map((s: any) => ({ id: s.id, name: s.name, line: s.line, mode: s.mode, direction: s.direction }))
        : [];
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
    };
}

function rowToWaitlist(r: any): AdminWaitlistRow {
    return { id: r.id, email: r.email || '', joinedAt: r.joinedAt || 0 };
}
