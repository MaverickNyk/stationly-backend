import { Request, Response } from 'express';
import { AdminDataService } from './adminDataService';
import { DataCacheService } from '../services/dataCacheService';
import { LocalDbService } from '../services/localDbService';
import { AdminInsightsService, buildPlatformOverview } from './adminInsightsService';
import { AdminMirror } from './adminMirror';

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * Read-only data views for the admin portal: dashboard stats, users,
 * waitlist, and subscribed stations.
 *
 * Firestore-read budget (deliberate):
 *   - `/stats`, `/subscribed-stations`         → 0 reads (memory + SQLite)
 *   - `/users`, `/waitlist` (normal load)      → 0 reads (memory + SQLite)
 *   - `/users`, `/waitlist` with `?refresh=1`  → exactly 1 collection read,
 *                                                then re-cached for free serving
 *
 * No `@swagger` (stays off the OpenAPI docs); admin-key + optional CF Access
 * gated by the router middleware.
 */
export class AdminDataController {
    /** GET /admin/stats — dashboard counts, all from memory/SQLite (0 reads). */
    static async stats(_req: Request, res: Response) {
        try {
            await AdminDataService.warmFromSqlite();
            const cacheCounts = DataCacheService.counts();
            const subs = await LocalDbService.all<{ naptanId: string }>(
                'SELECT naptanId FROM subscribed_stations'
            );
            const recent = await LocalDbService.listAdminNotifications(5);
            const refreshed = AdminDataService.lastRefreshed();

            return res.json({
                transport: {
                    stations: cacheCounts.stations,
                    lines: cacheCounts.lines,
                    modes: cacheCounts.modes,
                    lineStatuses: cacheCounts.lineStatuses,
                },
                subscribedStations: subs.length,
                users: {
                    total: AdminDataService.usersCount(),
                    active: AdminDataService.activeUsersCount(),
                    refreshedAt: refreshed.users,
                },
                waitlist: {
                    total: AdminDataService.waitlistCount(),
                    refreshedAt: refreshed.waitlist,
                },
                recentNotifications: recent,
            });
        } catch (e: any) {
            console.warn('ADMIN_DATA: stats failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /**
     * GET /admin/users/:uid — full detail for one user (profile + device
     * sessions + subscribed stations). Served from cache (0 reads); falls back
     * to a single doc read only if the uid isn't cached.
     */
    static async userDetail(req: Request, res: Response) {
        const uid = (req.params.uid || '').trim();
        if (!uid) return res.status(400).json({ error: 'Bad Request', message: 'uid is required' });
        try {
            const user = await AdminDataService.getUserDetail(uid);
            if (!user) return res.status(404).json({ error: 'Not Found', message: 'No such user' });
            // The payment entries carry store order ids; the console needs only the totals.
            const { entries: _entries, ...support } = user.support ?? { count: 0, totalMinor: 0, lastAtMs: 0 };
            return res.json({ ...user, support });
        } catch (e: any) {
            console.warn('ADMIN_DATA: userDetail failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /**
     * GET /admin/users — cached users (0 reads). `?refresh=1` re-reads only the
     * accounts changed since the last sync; `?full=1` re-reads the whole
     * collection (the costly path, for a deliberate resync).
     */
    static async users(req: Request, res: Response) {
        const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
        const full = req.query.full === '1' || req.query.full === 'true';
        try {
            const { rows, cached, refreshedAt } = await AdminDataService.getUsers({ refresh, full });
            return res.json({ items: rows, count: rows.length, cached, refreshedAt });
        } catch (e: any) {
            console.warn('ADMIN_DATA: users failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /** GET /admin/waitlist — cached waitlist; `?refresh=1` does one live read. */
    static async waitlist(req: Request, res: Response) {
        const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
        try {
            const { rows, cached, refreshedAt } = await AdminDataService.getWaitlist({ refresh });
            return res.json({ items: rows, count: rows.length, cached, refreshedAt });
        } catch (e: any) {
            console.warn('ADMIN_DATA: waitlist failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /**
     * GET /admin/subscribed-stations — the global subscribed-stations registry
     * (naptanId + subscriber count) joined with station metadata for names.
     * Entirely from memory/SQLite — zero Firestore reads.
     */
    static async subscribedStations(_req: Request, res: Response) {
        try {
            const subs = await LocalDbService.all<{ naptanId: string; count: number }>(
                'SELECT naptanId, count FROM subscribed_stations ORDER BY count DESC'
            );
            const items = subs.map((s) => {
                const station: any = DataCacheService.getStationById(s.naptanId);
                return {
                    naptanId: s.naptanId,
                    count: s.count,
                    commonName: station?.commonName || null,
                    lat: station?.lat ?? null,
                    lon: station?.lon ?? null,
                    modes: station?.modes ? Object.keys(station.modes) : [],
                };
            });
            return res.json({ items, count: items.length });
        } catch (e: any) {
            console.warn('ADMIN_DATA: subscribed-stations failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /**
     * GET /admin/analytics/overview — platform split, active accounts by
     * platform (from device lastSeen), app versions, signups. 0 reads: built
     * from the cached users + devices.
     */
    static async platformOverview(_req: Request, res: Response) {
        try {
            await AdminDataService.getUsers();
            const refreshed = AdminDataService.lastRefreshed();
            return res.json(buildPlatformOverview(AdminDataService.allUsers(), Date.now(), refreshed.users));
        } catch (e: any) {
            console.warn('ADMIN_DATA: platform overview failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /** GET /admin/analytics/usage?days=7 — everyone's activity, from the local copy (0 reads). */
    static async usage(req: Request, res: Response) {
        const days = clampInt(req.query.days, 1, 120, 7);
        try {
            return res.json({ days, report: await AdminInsightsService.usage(days) });
        } catch (e: any) {
            console.warn('ADMIN_DATA: usage failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /** POST /admin/analytics/import-activity {days, force} — one-time history import (costed). */
    static async importActivity(req: Request, res: Response) {
        try {
            const r = await AdminInsightsService.importHistory(clampInt(req.body?.days, 1, 120, 120), req.body?.force === true);
            return res.json({ ok: true, ...r });
        } catch (e: any) {
            return res.status(409).json({ ok: false, message: e?.message ?? 'import failed' });
        }
    }

    /** GET /admin/sync-status — how fresh the accounts copy is and what is waiting to sync. */
    static async syncStatus(_req: Request, res: Response) {
        try {
            await AdminDataService.getUsers();
            return res.json({
                usersRefreshedAt: AdminDataService.lastRefreshed().users,
                changedWaiting: await AdminMirror.dirtyCount(),
                activity: await AdminMirror.activityStats(),
            });
        } catch (e: any) {
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /** GET /admin/users/:uid/activity?days=14 — one account's trail, newest first. */
    static async userActivity(req: Request, res: Response) {
        const uid = (req.params.uid || '').trim();
        if (!uid) return res.status(400).json({ error: 'Bad Request', message: 'uid is required' });
        try {
            return res.json(await AdminInsightsService.userActivity(uid, clampInt(req.query.days, 1, 90, 14)));
        } catch (e: any) {
            console.warn('ADMIN_DATA: user activity failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }

    /** GET /admin/support/summary?months=6 — money given per month and route, against the monthly cost. */
    static async supportSummary(req: Request, res: Response) {
        try {
            const cost = clampInt(process.env.SUPPORT_MONEY_MONTHLY_COST_MINOR, 0, 100_000_000, 0);
            await AdminDataService.getUsers();
            const users = AdminDataService.allUsers();
            const supporters = users
                .filter((u) => u.support?.count > 0)
                .map((u) => {
                    const platforms = [...new Set(u.sessions.map((x) => String(x.platform ?? '').toLowerCase()).filter(Boolean))].sort();
                    const { entries: _e, ...support } = u.support;
                    return { uid: u.uid, email: u.email, displayName: u.displayName, platforms, ...support };
                })
                .sort((a, b) => b.lastAtMs - a.lastAtMs);
            const summary = await AdminInsightsService.support(clampInt(req.query.months, 1, 12, 6), cost, users);
            return res.json({ ...summary, supporters });
        } catch (e: any) {
            console.warn('ADMIN_DATA: support summary failed', e?.message);
            return res.status(500).json({ error: 'Internal Server Error', message: e?.message });
        }
    }
}
