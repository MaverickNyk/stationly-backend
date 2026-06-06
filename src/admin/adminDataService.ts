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
 * Designed around the hard constraint that the portal must NOT generate
 * Firestore reads on normal use:
 *   - At boot we warm the in-memory cache from the SQLite slave (0 reads).
 *   - `getUsers()` / `getWaitlist()` serve that cache → 0 reads.
 *   - A read from master (Firestore) happens ONLY when the admin explicitly
 *     refreshes (or on the very first load, when the slave is empty), and the
 *     result is written back to the slave for future zero-read serving.
 *
 * So steady-state browsing is free; the admin pays exactly one collection
 * read each time they press "Refresh".
 */

export interface AdminUserRow {
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
    /** True when served from the local cache (no Firestore read happened). */
    cached: boolean;
    /** Epoch ms of the last Firestore refresh, or 0 if never refreshed. */
    refreshedAt: number;
}

export class AdminDataService {
    private static users: AdminUserRow[] = [];
    private static waitlist: AdminWaitlistRow[] = [];
    private static usersRefreshedAt = 0;
    private static waitlistRefreshedAt = 0;
    private static warmed = false;

    /** Load both slaves (SQLite) into the in-memory cache. Zero Firestore reads. */
    static async warmFromSqlite(): Promise<void> {
        if (this.warmed) return;
        try {
            const u = await LocalDbService.allUsers();
            this.users = u.map(rowToUser);
            const w = await LocalDbService.allWaitlist();
            this.waitlist = w.map(rowToWaitlist);
            console.log(`ADMIN_DATA: 📁 Warmed from SQLite — users: ${this.users.length}, waitlist: ${this.waitlist.length}`);
        } catch (e) {
            console.warn('ADMIN_DATA: warm from SQLite failed', e);
        }
        this.warmed = true;
    }

    // ── Users ──────────────────────────────────────────────────────────

    static async getUsers(opts?: { refresh?: boolean }): Promise<CachedResult<AdminUserRow>> {
        await this.warmFromSqlite();
        const mustFetch = opts?.refresh || (this.users.length === 0 && this.usersRefreshedAt === 0);
        if (mustFetch) await this.refreshUsers();
        return { rows: this.users, cached: !mustFetch, refreshedAt: this.usersRefreshedAt };
    }

    /** ONE Firestore read of the users collection → memory + SQLite. */
    private static async refreshUsers(): Promise<void> {
        const snap = await db.collection('users').get();
        this.users = snap.docs.map((d) => {
            const x = d.data() || {};
            const stations = Array.isArray(x.stations) ? x.stations : [];
            return {
                uid: d.id,
                email: x.email || '',
                displayName: x.displayName || '',
                createdAt: toEpochMs(x.createdAt) ?? 0,
                lastLoggedInTime: toEpochMs(x.lastLoggedInTime) ?? 0,
                loggedIn: x.loggedIn === true,
                emailVerified: x.emailVerified === true,
                stationCount: stations.length,
            };
        });
        this.usersRefreshedAt = Date.now();
        await LocalDbService.replaceUsers(this.users);
    }

    // ── Waitlist ───────────────────────────────────────────────────────

    static async getWaitlist(opts?: { refresh?: boolean }): Promise<CachedResult<AdminWaitlistRow>> {
        await this.warmFromSqlite();
        const mustFetch = opts?.refresh || (this.waitlist.length === 0 && this.waitlistRefreshedAt === 0);
        if (mustFetch) await this.refreshWaitlist();
        return { rows: this.waitlist, cached: !mustFetch, refreshedAt: this.waitlistRefreshedAt };
    }

    /** ONE Firestore read of the waitlist collection → memory + SQLite. */
    private static async refreshWaitlist(): Promise<void> {
        const snap = await db.collection('waitlist').get();
        this.waitlist = snap.docs.map((d) => {
            const x = d.data() || {};
            return {
                id: d.id,
                email: x.email || '',
                joinedAt: toEpochMs(x.joinedAt) ?? 0,
            };
        });
        this.waitlistRefreshedAt = Date.now();
        await LocalDbService.replaceWaitlist(this.waitlist);
    }

    // ── Lightweight counts for the dashboard (from memory; 0 reads) ──────

    static usersCount(): number {
        return this.users.length;
    }
    static activeUsersCount(): number {
        return this.users.filter((u) => u.loggedIn).length;
    }
    static waitlistCount(): number {
        return this.waitlist.length;
    }
    static lastRefreshed(): { users: number; waitlist: number } {
        return { users: this.usersRefreshedAt, waitlist: this.waitlistRefreshedAt };
    }
}

function rowToUser(r: any): AdminUserRow {
    return {
        uid: r.uid,
        email: r.email || '',
        displayName: r.displayName || '',
        createdAt: r.createdAt || 0,
        lastLoggedInTime: r.lastLoggedInTime || 0,
        loggedIn: r.loggedIn === 1,
        emailVerified: r.emailVerified === 1,
        stationCount: r.stationCount || 0,
    };
}

function rowToWaitlist(r: any): AdminWaitlistRow {
    return { id: r.id, email: r.email || '', joinedAt: r.joinedAt || 0 };
}
