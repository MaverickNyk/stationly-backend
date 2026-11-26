import { db } from '../config/firebase';
import { AdminMirror } from './adminMirror';
import { londonMonth, txnSource } from '../services/supportMoneyStatsService';
import { toEpochMs } from '../utils/timestamps';
import { correctedAmount, type AdminUser } from './adminDataService';

/**
 * What the admin console knows about how Stationly is used, across Android,
 * iOS and the web.
 *
 * Two sources, and they answer different questions:
 *
 *   1. DEVICES (`users/{uid}/devices`, already cached by AdminDataService).
 *      Which platforms each account has, which app version each device runs,
 *      and `lastSeen`. FREE: no Firestore read beyond the users refresh. But
 *      `lastSeen` is written on sign-in and session refresh, and only when the
 *      stored one is stale, so it lags real use by up to a day or two. Good for
 *      "who is on which platform and version", rough for "active today".
 *
 *   2. ACTIVITY. What people actually did: opens, boards, widgets, support
 *      steps, notifications. The true signal for activity and funnels. Read
 *      from the local copy AdminMirror keeps as uploads are stored, so it is
 *      FREE too; Firestore (`users/{uid}/activity`) is read only by the
 *      one-time history import. Uploads arrive in batches, often overnight, so
 *      the last day is always short.
 *
 * Both only see SIGNED-IN people. Someone using the app signed out has no
 * account and appears in neither.
 */

const DAY = 24 * 60 * 60 * 1000;
export type Platform = 'android' | 'ios' | 'web';
const PLATFORMS: Platform[] = ['android', 'ios', 'web'];

function asPlatform(p: unknown): Platform | null {
    const s = String(p ?? '').toLowerCase();
    return s === 'android' || s === 'ios' || s === 'web' ? s : null;
}

function num(v: unknown): number {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}

// ── 1. Devices overview (free) ────────────────────────────────────────────

export interface PlatformOverview {
    computedAt: number;
    usersRefreshedAt: number;
    totalUsers: number;
    /** Which platforms each account has ever had a device on. */
    segments: { androidOnly: number; iosOnly: number; both: number; webOnly: number; noDevice: number };
    /** Accounts with a device seen in the window, by platform; `both` = seen on Android AND iOS in it. */
    active: Record<'d1' | 'd7' | 'd30', { any: number; android: number; ios: number; web: number; both: number }>;
    /** App version per platform: devices seen in the last 30 days, and all devices. */
    versions: Record<Platform, Array<{ version: string; active30: number; all: number }>>;
    /** New accounts per ISO week (Monday), by the platform of their first device. */
    signupsByWeek: Array<{ week: string; android: number; ios: number; web: number; unknown: number }>;
    supporters: { ever: number; active: number };
    devices: { total: number; android: number; ios: number; web: number };
}

function mondayKey(ms: number): string {
    const d = new Date(ms);
    const day = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** Pure, so it is tested without Firestore. */
export function buildPlatformOverview(users: AdminUser[], now: number, usersRefreshedAt = 0, supportWindowMs = 31 * DAY): PlatformOverview {
    const segments = { androidOnly: 0, iosOnly: 0, both: 0, webOnly: 0, noDevice: 0 };
    const windows = { d1: DAY, d7: 7 * DAY, d30: 30 * DAY } as const;
    const active = {
        d1: { any: 0, android: 0, ios: 0, web: 0, both: 0 },
        d7: { any: 0, android: 0, ios: 0, web: 0, both: 0 },
        d30: { any: 0, android: 0, ios: 0, web: 0, both: 0 },
    };
    const ver: Record<Platform, Map<string, { active30: number; all: number }>> = {
        android: new Map(), ios: new Map(), web: new Map(),
    };
    const weeks = new Map<string, { android: number; ios: number; web: number; unknown: number }>();
    const devices = { total: 0, android: 0, ios: 0, web: 0 };
    let supportersEver = 0;
    let supportersActive = 0;

    for (const u of users) {
        const seen: Record<Platform, number> = { android: 0, ios: 0, web: 0 };
        const has = new Set<Platform>();
        let first: { at: number; p: Platform } | null = null;
        for (const s of u.sessions ?? []) {
            const p = asPlatform(s.platform);
            if (!p) continue;
            has.add(p);
            devices.total++; devices[p]++;
            const last = toEpochMs(s.lastSeen) ?? 0;
            seen[p] = Math.max(seen[p], last);
            const firstSeen = toEpochMs(s.firstSeen) || last;
            if (firstSeen && (!first || firstSeen < first.at)) first = { at: firstSeen, p };
            const v = (s.appVersion || 'unknown').trim() || 'unknown';
            const row = ver[p].get(v) ?? { active30: 0, all: 0 };
            row.all++;
            if (last && now - last < 30 * DAY) row.active30++;
            ver[p].set(v, row);
        }
        const a = has.has('android'), i = has.has('ios');
        if (a && i) segments.both++;
        else if (a) segments.androidOnly++;
        else if (i) segments.iosOnly++;
        else if (has.has('web')) segments.webOnly++;
        else segments.noDevice++;

        for (const [k, w] of Object.entries(windows) as Array<[keyof typeof windows, number]>) {
            const on = PLATFORMS.filter((p) => seen[p] && now - seen[p] < w);
            if (on.length) active[k].any++;
            for (const p of on) active[k][p]++;
            if (on.includes('android') && on.includes('ios')) active[k].both++;
        }

        if (u.createdAt) {
            const wk = mondayKey(u.createdAt);
            const row = weeks.get(wk) ?? { android: 0, ios: 0, web: 0, unknown: 0 };
            row[first?.p ?? 'unknown']++;
            weeks.set(wk, row);
        }

        if (u.support && u.support.count > 0) {
            supportersEver++;
            if (u.support.lastAtMs && now - u.support.lastAtMs < supportWindowMs) supportersActive++;
        }
    }

    const sortVersions = (m: Map<string, { active30: number; all: number }>) =>
        [...m.entries()].map(([version, r]) => ({ version, ...r }))
            .sort((x, y) => y.active30 - x.active30 || y.all - x.all);

    return {
        computedAt: now,
        usersRefreshedAt,
        totalUsers: users.length,
        segments,
        active,
        versions: { android: sortVersions(ver.android), ios: sortVersions(ver.ios), web: sortVersions(ver.web) },
        signupsByWeek: [...weeks.entries()].sort(([x], [y]) => x.localeCompare(y)).slice(-26)
            .map(([week, r]) => ({ week, ...r })),
        supporters: { ever: supportersEver, active: supportersActive },
        devices,
    };
}

// ── 2. Activity: one user, on demand ─────────────────────────────────────

export interface ActivityDoc {
    uid: string;
    date: string;
    deviceId?: string;
    platform?: string;
    appVersion?: string;
    events?: Array<{ id?: string; name?: string; t?: number; props?: Record<string, unknown> }>;
}

export interface UserActivityRow {
    t: number;
    name: string;
    props: Record<string, unknown>;
    platform: string;
    appVersion: string;
    deviceId: string;
}

const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function flattenActivity(docs: ActivityDoc[], limit = 3000): UserActivityRow[] {
    const rows: UserActivityRow[] = [];
    for (const d of docs) {
        for (const e of d.events ?? []) {
            if (!e?.name) continue;
            rows.push({
                t: num(e.t),
                name: String(e.name),
                props: e.props && typeof e.props === 'object' ? e.props : {},
                platform: asPlatform(d.platform) ?? String(d.platform ?? ''),
                appVersion: String(d.appVersion ?? ''),
                deviceId: String(d.deviceId ?? ''),
            });
        }
    }
    return rows.sort((a, b) => b.t - a.t).slice(0, limit);
}

// ── 3. Activity: everyone, aggregated (costed, cached) ───────────────────

/** Which prop to break each event down by. Anything else is just counted. */
const BREAKDOWN: Record<string, string> = {
    'support.asked': 'trigger',
    'support.ask_dismissed': 'trigger',
    'support.sheet_opened': 'from',
    'support.tier_tapped': 'tier',
    'support.purchase': 'result',
    'support.verified': 'outcome',
    'whats_new.dismissed': 'via',
    'notification.posted': 'type',
    'notification.opened': 'type',
    'notification.suppressed': 'reason',
    'notification.muted': 'type',
    'settings.home_layout': 'layout',
    'board.filtered': 'filter',
    'auth.logged_in': 'provider',
    'auth.forced_logout': 'path',
    'app.upgrade_required': 'installed',
    'sync.failed': 'stage',
    'widget.added': 'family',
};

/** Funnels, in order. A step names an event, optionally with one prop value. */
export const FUNNELS: Array<{ key: string; label: string; steps: Array<{ label: string; name: string; prop?: [string, string] }> }> = [
    {
        key: 'support', label: 'Support', steps: [
            { label: 'Asked', name: 'support.asked' },
            { label: 'Opened amounts', name: 'support.sheet_opened' },
            { label: 'Tapped an amount', name: 'support.tier_tapped' },
            { label: 'Store said purchased', name: 'support.purchase', prop: ['result', 'purchased'] },
            { label: 'Thank-you shown', name: 'support.thanks_shown' },
        ],
    },
    {
        key: 'whats_new', label: "What's new", steps: [
            { label: 'Shown', name: 'whats_new.shown' },
            { label: 'Tapped Support', name: 'whats_new.support_tapped' },
            { label: 'Opened amounts from it', name: 'support.sheet_opened', prop: ['from', 'whats_new'] },
        ],
    },
    {
        key: 'widgets', label: 'Widgets', steps: [
            { label: 'Opened the guide', name: 'widget.guide_opened' },
            { label: 'Added a widget', name: 'widget.added' },
        ],
    },
    {
        key: 'notifications', label: 'Notifications', steps: [
            { label: 'Shown', name: 'notification.posted' },
            { label: 'Opened', name: 'notification.opened' },
        ],
    },
];

type PlatformKey = Platform | 'unknown';

export interface UsageReport {
    computedAt: number;
    days: number;
    from: string;
    to: string;
    docsRead: number;
    accountsScanned: number;
    /** Accounts with any event in range, by platform; `both` = events from Android AND iOS. */
    activeUsers: { any: number; android: number; ios: number; web: number; both: number };
    daily: Array<{ date: string; android: number; ios: number; web: number; opens: number }>;
    events: Array<{ name: string; count: number; users: number; byPlatform: Record<string, number>; breakdown?: Record<string, number> }>;
    funnels: Array<{ key: string; label: string; steps: Array<{ label: string; users: Record<string, number> }> }>;
    versions: Record<string, Array<{ version: string; users: number }>>;
}

/** Pure aggregation over activity documents, so it is tested without Firestore. */
export function aggregateUsage(docs: ActivityDoc[], days: number, from: string, to: string, now: number): UsageReport {
    const activeBy: Record<PlatformKey, Set<string>> = { android: new Set(), ios: new Set(), web: new Set(), unknown: new Set() };
    const daily = new Map<string, { android: Set<string>; ios: Set<string>; web: Set<string>; opens: number }>();
    const ev = new Map<string, { count: number; users: Set<string>; byPlatform: Record<string, number>; breakdown: Record<string, number> }>();
    const stepUsers = new Map<string, Record<string, Set<string>>>(); // funnelKey#i → platform → uids
    const versions: Record<string, Map<string, Set<string>>> = {};

    const stepKey = (f: string, i: number) => `${f}#${i}`;

    for (const d of docs) {
        if (!d.date || d.date < from || d.date > to) continue;
        const p: PlatformKey = asPlatform(d.platform) ?? 'unknown';
        const evs = (d.events ?? []).filter((e) => e?.name);
        if (!evs.length) continue;
        activeBy[p].add(d.uid);

        const day = daily.get(d.date) ?? { android: new Set(), ios: new Set(), web: new Set(), opens: 0 };
        if (p !== 'unknown') day[p].add(d.uid);

        const v = String(d.appVersion || 'unknown');
        (versions[p] ??= new Map()).set(v, (versions[p].get(v) ?? new Set()).add(d.uid));

        for (const e of evs) {
            const name = String(e.name);
            const props = (e.props && typeof e.props === 'object' ? e.props : {}) as Record<string, unknown>;
            if (name === 'app.opened') day.opens++;
            const row = ev.get(name) ?? { count: 0, users: new Set<string>(), byPlatform: {}, breakdown: {} };
            row.count++;
            row.users.add(d.uid);
            row.byPlatform[p] = (row.byPlatform[p] ?? 0) + 1;
            const bk = BREAKDOWN[name];
            if (bk) {
                const val = String(props[bk] ?? '(none)').slice(0, 60);
                row.breakdown[val] = (row.breakdown[val] ?? 0) + 1;
            }
            ev.set(name, row);

            for (const f of FUNNELS) {
                f.steps.forEach((s, i) => {
                    if (s.name !== name) return;
                    if (s.prop && String(props[s.prop[0]] ?? '') !== s.prop[1]) return;
                    const k = stepKey(f.key, i);
                    const m = stepUsers.get(k) ?? {};
                    (m[p] ??= new Set()).add(d.uid);
                    (m.all ??= new Set()).add(d.uid);
                    stepUsers.set(k, m);
                });
            }
        }
        daily.set(d.date, day);
    }

    const all = new Set<string>();
    for (const s of Object.values(activeBy)) s.forEach((u) => all.add(u));
    const both = [...activeBy.android].filter((u) => activeBy.ios.has(u)).length;

    // Every date in range, so a quiet day reads as zero rather than missing.
    const dates: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); dateKey(t) <= to; t += DAY) dates.push(dateKey(t));

    return {
        computedAt: now,
        days, from, to,
        docsRead: docs.length,
        accountsScanned: 0,
        activeUsers: {
            any: all.size, android: activeBy.android.size, ios: activeBy.ios.size, web: activeBy.web.size, both,
        },
        daily: dates.map((date) => {
            const r = daily.get(date);
            return { date, android: r?.android.size ?? 0, ios: r?.ios.size ?? 0, web: r?.web.size ?? 0, opens: r?.opens ?? 0 };
        }),
        events: [...ev.entries()].map(([name, r]) => ({
            name, count: r.count, users: r.users.size, byPlatform: r.byPlatform,
            ...(Object.keys(r.breakdown).length ? { breakdown: r.breakdown } : {}),
        })).sort((a, b) => b.count - a.count),
        funnels: FUNNELS.map((f) => ({
            key: f.key, label: f.label,
            steps: f.steps.map((s, i) => {
                const m = stepUsers.get(stepKey(f.key, i)) ?? {};
                const users: Record<string, number> = {};
                for (const [k, set] of Object.entries(m)) users[k] = set.size;
                users.all ??= 0;
                return { label: s.label, users };
            }),
        })),
        versions: Object.fromEntries(Object.entries(versions).map(([p, m]) => [
            p, [...m.entries()].map(([version, s]) => ({ version, users: s.size })).sort((a, b) => b.users - a.users),
        ])),
    };
}

// ── 4. Support money by month (from support_money_txns) ──────────────────

export type PayPlatform = 'android' | 'ios' | 'web' | 'app';

/**
 * Which platform a payment came from. The store routes say it outright (Play is
 * Android, the App Store is iOS) and so does the website's marker. A Stripe
 * card payment made from inside an app does not, so it is read off the payer's
 * devices: one platform means that one; both or none is `app` (unclear).
 */
export function paymentPlatform(source: string, accountPlatforms?: string[]): PayPlatform {
    if (source === 'google') return 'android';
    if (source === 'apple') return 'ios';
    if (source === 'web') return 'web';
    // A Stripe payment the website did not mark: paid from an app. A deleted
    // account (no owner) or one on both platforms cannot say which.
    const p = accountPlatforms ?? [];
    const a = p.includes('android'), i = p.includes('ios');
    if (a && !i) return 'android';
    if (i && !a) return 'ios';
    return 'app';
}

type Bucket = { minor: number; count: number };
export interface SupportMonthRow {
    month: string; raisedMinor: number; count: number;
    bySource: Record<string, Bucket>;
    byPlatform: Record<string, Bucket>;
}

/**
 * `owner` maps a txnId to the paying account's platforms (from the cached
 * ledgers, 0 reads). A Stripe payment with no owner was made without an
 * account, which only the website allows.
 */
export function summariseSupportTxns(
    rows: Array<Record<string, unknown>>,
    months: string[],
    owner: (txnId: string) => string[] | undefined = () => undefined,
): SupportMonthRow[] {
    const out = new Map<string, SupportMonthRow>(months.map((m) => [m, { month: m, raisedMinor: 0, count: 0, bySource: {}, byPlatform: {} }]));
    for (const r of rows) {
        const m = out.get(String(r.month ?? ''));
        if (!m) continue;
        // GBP only: a total in mixed currencies would be a number that means nothing.
        if (String(r.currency ?? 'GBP').toUpperCase() !== 'GBP') continue;
        const txnId = String(r.txnId ?? '');
        const minor = Math.max(0, Math.floor(correctedAmount(txnId, num(r.amountMinor))));
        const src = String(r.source ?? txnSource(txnId));
        const plat = paymentPlatform(src, owner(txnId));
        m.raisedMinor += minor;
        m.count++;
        const s = (m.bySource[src] ??= { minor: 0, count: 0 });
        s.minor += minor; s.count++;
        const p = (m.byPlatform[plat] ??= { minor: 0, count: 0 });
        p.minor += minor; p.count++;
    }
    return months.map((m) => out.get(m)!);
}

function lastMonths(n: number, now: number): string[] {
    const out: string[] = [];
    const d = new Date(now);
    for (let i = 0; i < n; i++) {
        out.push(londonMonth(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 15)));
    }
    return out.reverse();
}

// ── Service ──────────────────────────────────────────────────────────────

type MirrorRow = { uid: string; date: string; deviceId: string; platform: string; appVersion: string; name: string; t: number; props: string };

const parseProps = (s: string): Record<string, unknown> => {
    try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/** Mirror rows → the per-device-per-day documents the pure functions take. */
export function rowsToDocs(rows: MirrorRow[]): ActivityDoc[] {
    const docs = new Map<string, ActivityDoc>();
    for (const r of rows) {
        const k = `${r.uid}|${r.date}|${r.deviceId}|${r.platform}`;
        let d = docs.get(k);
        if (!d) {
            d = { uid: r.uid, date: r.date, deviceId: r.deviceId, platform: r.platform, appVersion: r.appVersion, events: [] };
            docs.set(k, d);
        }
        d.events!.push({ name: r.name, t: r.t, props: parseProps(r.props) });
    }
    return [...docs.values()];
}

export class AdminInsightsService {
    /** Seams for tests. */
    static mirrorReader: (from: string, to: string, uid?: string) => Promise<MirrorRow[]> =
        (from, to, uid) => AdminMirror.activityRows(from, to, uid);
    static txnReader: (months: string[]) => Promise<Array<Record<string, unknown>>> = async (months) => {
        const snap = await db.collection('support_money_txns').where('month', 'in', months).get();
        return snap.docs.map((d) => d.data());
    };

    /** One account's trail from the local copy. 0 Firestore reads. */
    static async userActivity(uid: string, days: number, now = Date.now()) {
        const from = dateKey(now - (days - 1) * DAY);
        const rows = await this.mirrorReader(from, dateKey(now + DAY), uid);
        return { uid, days, from, events: flattenActivity(rowsToDocs(rows)), mirror: await AdminMirror.activityStats() };
    }

    /** Everyone's activity for the last `days` days, from the local copy. 0 Firestore reads. */
    static async usage(days: number, now = Date.now()): Promise<UsageReport & { mirror: { rows: number; oldest: string | null; importedAt: number } }> {
        const from = dateKey(now - (days - 1) * DAY);
        const to = dateKey(now);
        const docs = rowsToDocs(await this.mirrorReader(from, to));
        const report = aggregateUsage(docs, days, from, to, now);
        report.accountsScanned = new Set(docs.map((d) => d.uid)).size;
        return { ...report, mirror: await AdminMirror.activityStats() };
    }

    private static importing: Promise<{ docs: number; events: number }> | null = null;

    /**
     * ONE-TIME: copy the activity uploaded before the local copy existed. One
     * unfiltered collection-group read (no index needed), so it costs one read
     * per activity document ever stored. Refuses a second run unless forced.
     */
    static importHistory(days: number, force: boolean, now = Date.now()): Promise<{ docs: number; events: number }> {
        this.importing ??= (async () => {
            if (!force && Number(await AdminMirror.getMeta('activity_imported_at'))) {
                throw new Error('History was already imported. It only needs doing once.');
            }
            const from = dateKey(now - (days - 1) * DAY);
            const snap = await db.collectionGroup('activity').get();
            let docs = 0, events = 0;
            for (const d of snap.docs) {
                const x = d.data() as any;
                const uid = d.ref.parent.parent?.id;
                if (!uid || typeof x.date !== 'string' || x.date < from || !Array.isArray(x.events)) continue;
                const evs = x.events.filter((e: any) => e && typeof e.id === 'string' && typeof e.name === 'string' && Number.isFinite(e.t));
                await AdminMirror.recordActivity({ uid, deviceId: String(x.deviceId ?? ''), platform: x.platform, appVersion: x.appVersion, events: evs });
                docs++; events += evs.length;
            }
            await AdminMirror.setMeta('activity_imported_at', String(now));
            console.log(`ADMIN_INSIGHTS: imported activity history: ${snap.size} docs read, ${docs} in range, ${events} events`);
            return { docs, events };
        })().finally(() => { this.importing = null; });
        return this.importing;
    }

    /**
     * Money by month, route and platform, plus the latest payments. Platforms
     * come from matching each payment to its account in `users` (0 reads).
     */
    static async support(months: number, costMinor: number, users: AdminUser[] = [], now = Date.now()) {
        const keys = lastMonths(Math.min(12, Math.max(1, months)), now);
        const byTxn = new Map<string, AdminUser>();
        for (const u of users) for (const e of u.support?.entries ?? []) if (e.txnId) byTxn.set(e.txnId, u);
        const platformsOf = (u: AdminUser) => [...new Set((u.sessions ?? []).map((x) => String(x.platform ?? '').toLowerCase()).filter(Boolean))];
        const owner = (txnId: string) => { const u = byTxn.get(txnId); return u ? platformsOf(u) : undefined; };
        const rows = await this.txnReader(keys);

        // Every payment we know of: the accounts' own ledgers (all time, 0 reads)
        // plus the monthly-total rows, which add the website's no-account ones.
        // The ledgers go back before the monthly total existed, and also hold
        // store test purchases the total leaves out.
        const all = new Map<string, { txnId: string; atMs: number; amountMinor: number; source: string; uid: string | null }>();
        for (const u of users) for (const e of u.support?.entries ?? []) {
            if (e.currency !== 'GBP' || !e.txnId) continue;
            all.set(e.txnId, { txnId: e.txnId, atMs: e.atMs, amountMinor: e.amountMinor, source: txnSource(e.txnId), uid: u.uid });
        }
        for (const r of rows) {
            const txnId = String(r.txnId ?? '');
            if (!txnId || all.has(txnId) || String(r.currency ?? 'GBP').toUpperCase() !== 'GBP') continue;
            all.set(txnId, { txnId, atMs: num(r.atMs), amountMinor: correctedAmount(txnId, num(r.amountMinor)), source: String(r.source ?? txnSource(txnId)), uid: null });
        }
        const payments = [...all.values()].sort((a, b) => b.atMs - a.atMs).map((p) => {
            const u = p.uid ? users.find((x) => x.uid === p.uid) : undefined;
            return {
                atMs: p.atMs, amountMinor: Math.max(0, p.amountMinor), source: p.source,
                platform: paymentPlatform(p.source, u ? platformsOf(u) : undefined),
                uid: u?.uid ?? null, name: u ? (u.displayName || u.email) : null,
            };
        });
        const allTime: Record<string, { minor: number; count: number }> = {};
        for (const p of payments) {
            const b = (allTime[p.platform] ??= { minor: 0, count: 0 });
            b.minor += p.amountMinor; b.count++;
        }
        return {
            costMinor, currency: 'GBP', thisMonth: londonMonth(now),
            months: summariseSupportTxns(rows, keys, owner),
            recent: payments.slice(0, 50),
            allTime,
        };
    }
}
