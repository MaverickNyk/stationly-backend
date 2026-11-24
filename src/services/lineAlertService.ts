import { db, messaging } from '../config/firebase';
import { NotificationPolicyService } from './notificationPolicyService';

/**
 * Decides when a line disruption is worth telling phones about, and tells them.
 *
 * ## Why the backend and not the phone
 * The phone used to wait ten minutes and re-check. About four minutes after the
 * screen goes off on battery, Android cuts background network and defers jobs,
 * so a phone in a pocket never alerted. A high-priority push does arrive. So the
 * wait and the check happen here, and the push carries the confirmed status: the
 * phone needs no network, only its own rules (level, mute, cooldown, caps, quiet
 * hours, rollout). iOS needs the same decision: StationlyUI/docs/IOS_NOTIFICATIONS.md.
 *
 * ## State
 * One Firestore document per line (`line_alert_state/{line}`), changed only in
 * transactions. A restart loses nothing, and several workers seeing the same
 * change, or the same deadline, send one push.
 *
 * ## Two tiers
 * "severe" and "all" have their own severities, so their own wait: Minor Delays
 * turning Severe must hold for the whole wait AS severe before a "severe only"
 * user hears of it, without postponing the "all changes" user.
 */

export type Tier = 'severe' | 'all';
export const TIERS: Tier[] = ['severe', 'all'];

interface TierState {
    /** When to confirm and announce; null when nothing is waiting. */
    dueAt: number | null;
    /** The severity phones were told about, while it lasts. */
    announced: string | null;
    /** Failed sends of the current announcement. */
    tries?: number;
}

export interface LineAlertStatus {
    id: string; name: string; mode: string;
    statusSeverityDescription: string; reason: string | null; lastUpdatedTime: string;
}

export interface LineAlertState {
    severity: string;
    status: LineAlertStatus;
    /** When the status was produced, so a late writer cannot undo a newer one. */
    at: number;
    tiers: Record<Tier, TierState>;
}

type Rules = Record<string, string>;
export type Outgoing = { kind: 'alert' | 'clear'; tier: Tier; status: LineAlertStatus };

const csv = (v: string | undefined) => (v ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

export function isWorthy(tier: Tier, severity: string, mode: string, rules: Rules): boolean {
    if (rules['notify.line.enabled'] === 'false') return false;
    if (!csv(rules['notify.line.modes']).includes(mode.toLowerCase())) return false;
    const key = `notify.line.${tier === 'severe' ? 'alert' : 'all'}Severities`;
    return csv(rules[`${key}.${mode.toLowerCase()}`] ?? rules[key]).includes(severity.trim().toLowerCase());
}

/** A status arrived. Null when it changes nothing; otherwise the new state and what to send now. */
export function advance(prev: LineAlertState | undefined, status: LineAlertStatus, at: number, rules: Rules, now: number):
    { state: LineAlertState; send: Outgoing[] } | null {
    const severity = status.statusSeverityDescription.trim();
    if (!prev) {
        // First sighting is a baseline: it was already true when we started looking.
        return { state: { severity, status, at, tiers: { severe: { dueAt: null, announced: null }, all: { dueAt: null, announced: null } } }, send: [] };
    }
    if (at < prev.at || same(prev.severity, severity)) return null;
    const send: Outgoing[] = [];
    const tiers = {} as Record<Tier, TierState>;
    const wait = Number(rules['notify.line.confirmAfterMs'] ?? 0);
    for (const tier of TIERS) {
        const t = prev.tiers[tier];
        const worthy = isWorthy(tier, severity, status.mode, rules);
        const was = isWorthy(tier, prev.severity, status.mode, rules);
        if (!worthy) {
            if (t.announced) send.push({ kind: 'clear', tier, status });
            tiers[tier] = { dueAt: null, announced: null };
        } else if (same(t.announced, severity)) {
            tiers[tier] = { dueAt: null, announced: t.announced }; // back to what they were told
        } else if (was && t.dueAt !== null) {
            tiers[tier] = { ...t, dueAt: t.dueAt }; // between two disruptions: the wait already running is the right one
        } else {
            tiers[tier] = { dueAt: now + wait, announced: t.announced, tries: 0 };
        }
    }
    return { state: { severity, status, at, tiers }, send };
}

/** Deadlines reached. Null when none; otherwise the new state and what to send. */
export function claimDue(state: LineAlertState, rules: Rules, now: number): { state: LineAlertState; send: Outgoing[] } | null {
    const send: Outgoing[] = [];
    const tiers = { ...state.tiers };
    let changed = false;
    for (const tier of TIERS) {
        const t = state.tiers[tier];
        if (t.dueAt === null || t.dueAt > now) continue;
        changed = true;
        // Judged by the rules in force NOW: a kill switch thrown during the wait counts.
        if (isWorthy(tier, state.severity, state.status.mode, rules)) {
            tiers[tier] = { ...t, dueAt: null, announced: state.severity };
            send.push({ kind: 'alert', tier, status: state.status });
        } else {
            tiers[tier] = { dueAt: null, announced: t.announced };
        }
    }
    return changed ? { state: { ...state, tiers }, send } : null;
}

const COLLECTION = () => db.collection('line_alert_state');
const TICK_MS = 5_000;
const RETRY_MS = 30_000;
/** Seeds every line at startup (a line first heard of already disrupted is a
 *  baseline, so its first disruption would be missed) and bounds how long a
 *  change can go unseen if the Syncer stops. At most one TfL call per mode. */
const REFRESH_MS = 5 * 60_000;
/** Long enough for a tunnel, short enough to still be news. A newer push replaces a waiting one. */
const TTL_MS = 60 * 60_000;

export class LineAlertService {
    private static queue = new Map<string, Promise<void>>();
    /** Mirror of the stored states: to know when to look, and that an unchanged
     *  re-broadcast needs no transaction. The transaction has the last word. */
    private static states = new Map<string, LineAlertState>();
    private static sent = 0;
    private static failed = 0;

    private static refreshMode: (mode: string) => Promise<unknown> = async () => undefined;
    private static ticking = false;

    /** [refreshMode] makes the status cache current for a mode; what it finds comes back through [observe]. */
    static start(refreshMode: (mode: string) => Promise<unknown>): void {
        this.refreshMode = refreshMode;
        this.follow();
        setInterval(() => { void this.tick(); }, TICK_MS).unref();
        const refreshAll = async () => {
            for (const mode of csv(this.rules()['notify.line.modes'])) await this.refreshMode(mode).catch(() => undefined);
        };
        // After the listeners have had a moment to load.
        setTimeout(() => { void refreshAll(); }, 10_000).unref();
        setInterval(() => { void refreshAll(); }, REFRESH_MS).unref();
    }

    private static follow(): void {
        COLLECTION().onSnapshot(
            snap => snap.docChanges().forEach(c =>
                c.type === 'removed' ? this.states.delete(c.doc.id) : this.states.set(c.doc.id, c.doc.data() as LineAlertState)),
            // An errored listener is dead: without a new one no deadline is ever seen again.
            err => {
                console.error('LINE_ALERTS: state listener lost, reconnecting', err?.message);
                setTimeout(() => this.follow(), RETRY_MS).unref();
            },
        );
    }

    private static rules(): Rules { return NotificationPolicyService.homeConfigKeys(); }
    private static on(rules: Rules): boolean { return rules['notify.line.decider'] === 'server'; }

    /** Called for every genuinely new line status. Never throws, never blocks the broadcast. */
    static observe(lineId: string, p: { name?: string; mode?: string; statusSeverityDescription?: string; reason?: string; lastUpdatedTime?: string | number }): void {
        const line = (lineId ?? '').trim().toLowerCase();
        const severity = (p.statusSeverityDescription ?? '').trim();
        const mode = (p.mode ?? '').trim().toLowerCase();
        const rules = this.rules();
        // A line of a mode that does not alert is not followed at all (677 bus routes).
        if (!line || !severity || !csv(rules['notify.line.modes']).includes(mode)) return;
        const raw = p.lastUpdatedTime;
        const parsed = typeof raw === 'number' ? raw : /^\d+$/.test(String(raw ?? '')) ? Number(raw) : Date.parse(String(raw ?? ''));
        const at = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, Date.now()) : Date.now();
        const status: LineAlertStatus = {
            id: line, name: p.name ?? line, mode, statusSeverityDescription: severity,
            reason: p.reason ?? null, lastUpdatedTime: String(raw ?? at),
        };
        const next = (this.queue.get(line) ?? Promise.resolve()).then(async () => {
            // In the queue, after earlier statuses of this line are stored: an
            // unchanged re-broadcast then costs no transaction, and a flap is never skipped.
            if (!same(this.states.get(line)?.severity, severity)) await this.store(line, status, at);
        }).catch(e => {
            console.error(`LINE_ALERTS: ${line}: could not store`, e?.message);
        });
        this.queue.set(line, next);
    }

    private static async store(line: string, status: LineAlertStatus, at: number): Promise<void> {
        const rules = this.rules();
        const result = await this.transact(line, prev => advance(prev, status, at, rules, Date.now()));
        if (!result) return;
        const waits = TIERS.map(t => `${t}=${result.state.tiers[t].dueAt ? 'waiting' : result.state.tiers[t].announced ? 'told' : '-'}`).join(' ');
        console.log(`LINE_ALERTS: ${line} "${status.statusSeverityDescription}" ${waits}`);
        for (const out of result.send) await this.deliver(line, out, rules);
    }

    private static async tick(): Promise<void> {
        if (this.ticking) return;
        this.ticking = true;
        try { await this.checkDue(Date.now()); } finally { this.ticking = false; }
    }

    private static async checkDue(now: number): Promise<void> {
        for (const [line, s] of [...this.states]) {
            if (!TIERS.some(t => s.tiers?.[t]?.dueAt != null && s.tiers[t].dueAt! <= now)) continue;
            try {
                // As of now, not as of the last push: if the Syncer stalled, the line may be fine.
                await this.refreshMode(s.status.mode).catch(() => undefined);
                await this.queue.get(line);
                const rules = this.rules();
                const result = await this.transact(line, cur => cur ? claimDue(cur, rules, Date.now()) : null);
                for (const out of result?.send ?? []) await this.deliver(line, out, rules);
            } catch (e: any) {
                console.error(`LINE_ALERTS: ${line}: check failed`, e?.message);
            }
        }
    }

    private static async transact(line: string, fn: (prev: LineAlertState | undefined) => { state: LineAlertState; send: Outgoing[] } | null) {
        const ref = COLLECTION().doc(line);
        return db.runTransaction(async tx => {
            const r = fn((await tx.get(ref)).data() as LineAlertState | undefined);
            if (r) tx.set(ref, JSON.parse(JSON.stringify(r.state)));
            return r;
        }).then(r => { if (r) this.states.set(line, r.state); return r; });
    }

    private static async deliver(line: string, out: Outgoing, rules: Rules): Promise<void> {
        if (!this.on(rules)) return;
        try {
            await messaging.send({
                topic: `LineStatus_${out.status.mode}_${line}`,
                data: { type: 'line_alert', kind: out.kind, tier: out.tier, line_alert: JSON.stringify(out.status) },
                android: { priority: 'high', ttl: TTL_MS, collapseKey: `line_alert_${out.tier}_${line}` },
            });
            this.sent++;
            console.log(`LINE_ALERTS: sent ${out.kind} (${out.tier}) ${line} "${out.status.statusSeverityDescription}"`);
        } catch (e: any) {
            this.failed++;
            console.error(`LINE_ALERTS: ${line}: send failed`, e?.message);
            if (out.kind !== 'alert') return;
            const max = Number(rules['notify.line.confirmRetries'] ?? 1);
            await this.transact(line, cur => {
                const t = cur?.tiers[out.tier];
                if (!cur || !t || !same(t.announced, out.status.statusSeverityDescription) || (t.tries ?? 0) + 1 >= max) return null;
                return { state: { ...cur, tiers: { ...cur.tiers, [out.tier]: { dueAt: Date.now() + RETRY_MS, announced: null, tries: (t.tries ?? 0) + 1 } } }, send: [] };
            }).catch(() => null);
        }
    }

    static stats() {
        const waiting = [...this.states.values()].filter(s => TIERS.some(t => s.tiers?.[t]?.dueAt != null)).length;
        return { lines: this.states.size, waiting, sent: this.sent, failed: this.failed };
    }
}
