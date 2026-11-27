/**
 * Who an email goes to. Resolved from the admin console's cached copy of every
 * account (AdminDataService: memory + SQLite slave), so building and
 * previewing an audience costs 0 Firestore reads, however often the filter
 * changes. The only extra input is the opt-out list (EmailOptOuts, cached).
 *
 * `resolveAudience` is pure over its inputs, so it is unit-tested without
 * Firestore.
 */
import type { AdminUser, AdminWaitlistRow, SubscribedStation } from '../adminDataService';
import { firstNameOf } from './emailRender';
import { toEpochMs } from '../../utils/timestamps';
import type { EmailCategory } from './emailDoc';

export type Platform = 'android' | 'ios' | 'web' | 'none';

export interface AudienceFilter {
    /** users = Stationly accounts; waitlist = waitlist rows; none = only `customEmails`. */
    source: 'users' | 'waitlist' | 'none';
    /** Any of. 'none' = account with no device on record. */
    platforms?: Platform[];
    appVersion?: { platform: 'android' | 'ios'; op: 'lt' | 'lte' | 'eq' | 'gte' | 'gt'; value: string };
    signedIn?: 'any' | 'yes' | 'no';
    activeWithinDays?: number;
    inactiveForDays?: number;
    joinedAfter?: string;
    joinedBefore?: string;
    boards?: 'any' | 'with' | 'without';
    /** Board station ids (naptan / hub). Matches if ANY board is at one of them. */
    stations?: string[];
    /** With `stations`: the board must also carry one of these lines. */
    lines?: string[];
    /** With `stations`: the board must also track one of these directions. */
    directions?: string[];
    supporter?: 'any' | 'yes' | 'no';
    emailVerified?: 'any' | 'yes';
    providers?: string[];
    excludeAppleRelay?: boolean;
    /** Added on top of the filter (or alone, with source 'none'). */
    customEmails?: string[];
    excludeEmails?: string[];
}

export interface Recipient {
    email: string;
    firstName: string;
    uid?: string;
    displayName?: string;
    source: 'user' | 'waitlist' | 'custom';
    platforms?: string[];
    versions?: Record<string, string>;
    lastSeen?: number;
    joined?: number;
    /** Station NAMES this recipient matched (for {{station}}). */
    stations?: string[];
}

export interface AudienceResult {
    recipients: Recipient[];
    excluded: Array<{ reason: string; count: number }>;
}

export const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const DAY = 86_400_000;

export function normaliseEmail(e: string): string {
    return String(e || '').trim().toLowerCase();
}

/** Parse a pasted list: commas, semicolons, spaces or new lines. */
export function parseEmailList(input: string | string[] | undefined): string[] {
    const raw = Array.isArray(input) ? input.join('\n') : String(input || '');
    return [...new Set(raw.split(/[\s,;]+/).map(normaliseEmail).filter(Boolean))];
}

/** Compare dotted versions numerically ("2.0.10" > "2.0.9"). */
export function compareVersions(a: string, b: string): number {
    const pa = String(a || '').split(/[.\-+ ]/).map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
    const pb = String(b || '').split(/[.\-+ ]/).map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

export interface UserFacts {
    platforms: string[];
    versions: Record<string, string>;
    lastSeen: number;
}

/** The fields the filter needs, derived the same way the Users table does. */
export function factsOf(u: AdminUser): UserFacts {
    const platforms = new Set<string>();
    const newest: Record<string, number> = {};
    const versions: Record<string, string> = {};
    let lastSeen = 0;
    for (const s of u.sessions || []) {
        const p = String(s.platform || '').toLowerCase();
        if (!p) continue;
        platforms.add(p);
        const seen = toEpochMs(s.lastSeen) ?? 0;
        lastSeen = Math.max(lastSeen, seen);
        if (s.appVersion && seen >= (newest[p] ?? -1)) { newest[p] = seen; versions[p] = s.appVersion; }
    }
    return { platforms: [...platforms].sort(), versions, lastSeen };
}

function allBoards(u: AdminUser): SubscribedStation[] {
    return [...(u.stations || []), ...(u.legacyStations || [])];
}

function boardMatches(s: SubscribedStation, f: AudienceFilter): boolean {
    if (!f.stations?.length) return false;
    if (!f.stations.includes(s.id)) return false;
    const lines = String(s.line || '').toLowerCase();
    if (f.lines?.length && !f.lines.some((l) => lines.split(/[,\s]+/).includes(l.toLowerCase()))) return false;
    const dirs = String(s.direction || '').toLowerCase();
    if (f.directions?.length && !f.directions.some((d) => dirs.includes(d.toLowerCase()))) return false;
    return true;
}

function cleanStationName(n: string): string {
    return String(n || '').replace(/\s+(Underground|Rail|DLR|Overground)\s+Station$/i, '').replace(/\s+Station$/i, '').trim();
}

function passesUser(u: AdminUser, facts: UserFacts, f: AudienceFilter, now: number): { ok: boolean; stations?: string[] } {
    if (f.platforms?.length) {
        const hit = f.platforms.some((p) => (p === 'none' ? facts.platforms.length === 0 : facts.platforms.includes(p)));
        if (!hit) return { ok: false };
    }
    if (f.appVersion?.value) {
        const v = facts.versions[f.appVersion.platform];
        if (!v) return { ok: false };
        const c = compareVersions(v, f.appVersion.value);
        const op = f.appVersion.op;
        if (!((op === 'lt' && c < 0) || (op === 'lte' && c <= 0) || (op === 'eq' && c === 0) || (op === 'gte' && c >= 0) || (op === 'gt' && c > 0))) return { ok: false };
    }
    if (f.signedIn === 'yes' && !u.loggedIn) return { ok: false };
    if (f.signedIn === 'no' && u.loggedIn) return { ok: false };
    if (f.activeWithinDays && f.activeWithinDays > 0 && !(facts.lastSeen >= now - f.activeWithinDays * DAY)) return { ok: false };
    if (f.inactiveForDays && f.inactiveForDays > 0 && !(facts.lastSeen < now - f.inactiveForDays * DAY)) return { ok: false };
    if (f.joinedAfter && !(u.createdAt >= Date.parse(f.joinedAfter))) return { ok: false };
    if (f.joinedBefore && !(u.createdAt < Date.parse(f.joinedBefore) + DAY)) return { ok: false };
    if (f.boards === 'with' && !(u.stationCount > 0)) return { ok: false };
    if (f.boards === 'without' && u.stationCount > 0) return { ok: false };
    const supporter = (u.support?.count || 0) > 0;
    if (f.supporter === 'yes' && !supporter) return { ok: false };
    if (f.supporter === 'no' && supporter) return { ok: false };
    if (f.emailVerified === 'yes' && !u.emailVerified) return { ok: false };
    if (f.providers?.length && !f.providers.some((p) => String(u.signInProvider || '').toLowerCase().startsWith(p.toLowerCase()))) return { ok: false };

    if (f.stations?.length) {
        const hits = allBoards(u).filter((s) => boardMatches(s, f));
        if (!hits.length) return { ok: false };
        return { ok: true, stations: [...new Set(hits.map((h) => cleanStationName(h.name)))] };
    }
    return { ok: true };
}

export interface AudienceInputs {
    users: AdminUser[];
    waitlist: AdminWaitlistRow[];
    /** Lower-cased emails that opted out of marketing email. */
    optedOut: Set<string>;
    /** On staging, when set, only these addresses may receive campaign sends. */
    allowlist?: Set<string> | null;
    now?: number;
}

export function resolveAudience(f: AudienceFilter, category: EmailCategory, inp: AudienceInputs): AudienceResult {
    const now = inp.now ?? Date.now();
    const excluded = new Map<string, number>();
    const bump = (r: string) => excluded.set(r, (excluded.get(r) || 0) + 1);
    const byEmail = new Map<string, Recipient>();
    const excludeEmails = new Set(parseEmailList(f.excludeEmails));

    const consider = (r: Recipient) => {
        const email = normaliseEmail(r.email);
        if (!email) { bump('No email on the account'); return; }
        if (!EMAIL_RE.test(email)) { bump('Invalid email address'); return; }
        if (excludeEmails.has(email)) { bump('Excluded by you'); return; }
        if (f.excludeAppleRelay && email.endsWith('@privaterelay.appleid.com')) { bump('Apple hidden email (excluded)'); return; }
        if (category === 'marketing' && inp.optedOut.has(email)) { bump('Unsubscribed from news emails'); return; }
        if (inp.allowlist && !inp.allowlist.has(email)) { bump('Not on the staging allowlist'); return; }
        if (byEmail.has(email)) { bump('Duplicate address'); return; }
        byEmail.set(email, { ...r, email });
    };

    if (f.source === 'users') {
        for (const u of inp.users) {
            const facts = factsOf(u);
            const res = passesUser(u, facts, f, now);
            if (!res.ok) continue;
            consider({
                email: u.email, uid: u.uid, displayName: u.displayName,
                firstName: firstNameOf(u.displayName, u.email), source: 'user',
                platforms: facts.platforms, versions: facts.versions, lastSeen: facts.lastSeen,
                joined: u.createdAt, stations: res.stations,
            });
        }
    } else if (f.source === 'waitlist') {
        for (const w of inp.waitlist) {
            if (f.joinedAfter && !(w.joinedAt >= Date.parse(f.joinedAfter))) continue;
            if (f.joinedBefore && !(w.joinedAt < Date.parse(f.joinedBefore) + DAY)) continue;
            consider({ email: w.email, firstName: '', source: 'waitlist', joined: w.joinedAt });
        }
    }

    // Custom addresses: if one belongs to an account, use that account's name.
    const usersByEmail = new Map(inp.users.map((u) => [normaliseEmail(u.email), u]));
    for (const e of parseEmailList(f.customEmails)) {
        const u = usersByEmail.get(e);
        if (u) {
            const facts = factsOf(u);
            consider({ email: e, uid: u.uid, displayName: u.displayName, firstName: firstNameOf(u.displayName, e), source: 'custom', platforms: facts.platforms, versions: facts.versions, lastSeen: facts.lastSeen, joined: u.createdAt });
        } else {
            consider({ email: e, firstName: '', source: 'custom' });
        }
    }

    return {
        recipients: [...byEmail.values()],
        excluded: [...excluded.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    };
}

/** Options for the filter UI, from the same cache (0 reads). */
export function audienceOptions(users: AdminUser[]) {
    const stations = new Map<string, { id: string; name: string; lines: Set<string>; count: number }>();
    const versions: Record<string, Set<string>> = { android: new Set(), ios: new Set() };
    const providers = new Set<string>();
    for (const u of users) {
        const facts = factsOf(u);
        for (const [p, v] of Object.entries(facts.versions)) if (versions[p]) versions[p].add(v);
        if (u.signInProvider) providers.add(String(u.signInProvider).replace(/\.com$/, ''));
        const seen = new Set<string>();
        for (const s of allBoards(u)) {
            if (!s?.id) continue;
            const e = stations.get(s.id) || { id: s.id, name: cleanStationName(s.name) || s.id, lines: new Set<string>(), count: 0 };
            String(s.line || '').split(/[,\s]+/).filter(Boolean).forEach((l) => e.lines.add(l.toLowerCase()));
            if (!seen.has(s.id)) { e.count++; seen.add(s.id); }
            stations.set(s.id, e);
        }
    }
    return {
        stations: [...stations.values()].map((s) => ({ id: s.id, name: s.name, lines: [...s.lines].sort(), count: s.count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        versions: {
            android: [...versions.android].sort((a, b) => compareVersions(b, a)),
            ios: [...versions.ios].sort((a, b) => compareVersions(b, a)),
        },
        providers: [...providers].sort(),
    };
}
