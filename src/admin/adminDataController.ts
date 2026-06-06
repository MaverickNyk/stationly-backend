import { Request, Response } from 'express';
import { AdminDataService } from './adminDataService';
import { DataCacheService } from '../services/dataCacheService';
import { LocalDbService } from '../services/localDbService';

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

    /** GET /admin/users — cached users; `?refresh=1` does one live read. */
    static async users(req: Request, res: Response) {
        const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
        try {
            const { rows, cached, refreshedAt } = await AdminDataService.getUsers({ refresh });
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
}
