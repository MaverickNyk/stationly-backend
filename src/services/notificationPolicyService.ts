import { db, messaging } from '../config/firebase';

/**
 * The notification policy: every rule that decides whether, when and how a
 * phone shows a notification, served as `notify.*` keys in home-config.
 *
 * ## Why this lives on the server
 * v1 compiled these rules into the app. Users complained about a notification
 * every day and nothing could be changed without shipping a new version. Now a
 * noisy week is fixed by changing a value here.
 *
 * ## Where a value comes from, first match wins
 *   1. LIVE override: `PUT /admin/notifications/policy`. Stored in Firestore
 *      (`app_config/notification_policy`) and followed by every backend worker,
 *      so it needs neither a deploy nor a restart.
 *   2. ENVIRONMENT override (`env` below), for pinning one environment.
 *   3. The DEFAULT below.
 *
 * Every value from 1 and 2 is VALIDATED against the key's spec. A bad live value
 * is refused at the API; a bad environment value is ignored, loudly.
 *
 * ## The client's side of the contract
 * `core/.../config/NotificationPolicy.kt` reads these keys with CLAMPED defaults
 * equal to the ones below, so a missing or malformed value can never make the
 * app noisier than intended, and deploying this changes nothing by itself.
 */

type Spec =
    | { kind: 'bool' }
    | { kind: 'int'; min: number; max: number }
    | { kind: 'enum'; values: string[] }
    /** Comma-separated. `allowEmpty` lists may be cleared with "-". */
    | { kind: 'csv'; allowEmpty?: boolean }
    /** HH:MM, 24 hour. */
    | { kind: 'clock' }
    /** "device", or an IANA time zone. */
    | { kind: 'zone' }
    | { kind: 'text' };

export interface PolicyKey {
    key: string;
    env: string;
    value: string;
    spec: Spec;
    about: string;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const MAX_TEXT = 120;

/**
 * Alert-worthy at the DEFAULT level: the journey is materially affected, now,
 * without warning. Absent on purpose: "Service Closed" (every line every
 * night), "Planned Closure" and "Special Service" (announced in advance),
 * "Minor Delays" (flaps all day).
 */
const SEVERE = ['Severe Delays', 'Suspended', 'Part Suspended'];
const ALL = [...SEVERE, 'Minor Delays', 'Reduced Service', 'Part Closure'];
/** 192 of 677 bus routes were in "Special Service" on 2026-11-23. */
const MODES = ['tube', 'overground', 'elizabeth-line', 'dlr', 'tram'];

const k = (key: string, value: string, spec: Spec, about: string): PolicyKey => ({
    key, value, spec, about,
    // notify.line.maxPerDay -> NOTIFY_LINE_MAX_PER_DAY
    env: key.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[.-]/g, '_').toUpperCase(),
});
const int = (min: number, max: number): Spec => ({ kind: 'int', min, max });

export const NOTIFICATION_POLICY_KEYS: PolicyKey[] = [
    // ── Line alerts: on or off, and for whom ─────────────────────────────────
    k('notify.line.enabled', 'true', { kind: 'bool' }, 'Kill switch for every line alert'),
    k('notify.line.rolloutPercent', '100', int(0, 100), 'Share of devices that alert at all; a device keeps its place'),
    k('notify.line.defaultLevel', 'severe', { kind: 'enum', values: ['severe', 'all', 'off'] }, 'Level of a user who never chose one'),

    // ── What counts ──────────────────────────────────────────────────────────
    k('notify.line.alertSeverities', SEVERE.join(','), { kind: 'csv' }, 'Severities that alert at "Severe only"'),
    k('notify.line.allSeverities', ALL.join(','), { kind: 'csv' }, 'Severities that alert at "All changes"'),
    k('notify.line.modes', MODES.join(','), { kind: 'csv' }, 'Modes that may alert'),

    // ── How often ────────────────────────────────────────────────────────────
    k('notify.line.confirmAfterMs', String(10 * MIN), int(0, 2 * HOUR), 'A disruption must still be there this long after it appeared'),
    k('notify.line.confirmRetries', '5', int(1, 10), 'Tries to learn the status at the re-check before giving up'),
    k('notify.line.cooldownMs', String(2 * HOUR), int(0, 24 * HOUR), 'At most one alert per line in this window'),
    k('notify.line.maxPerDay', '3', int(0, 50), 'Line alerts per device per day, all lines'),

    // ── How it ends ──────────────────────────────────────────────────────────
    k('notify.line.recovery', 'silent', { kind: 'enum', values: ['silent', 'alert', 'off'] }, 'When a line recovers: update quietly, notify, or just clear'),
    k('notify.line.expireAfterMs', String(4 * HOUR), int(0, 24 * HOUR), 'An alert removes itself after this long (0 never)'),
    k('notify.line.muteMs', String(12 * HOUR), int(0, 7 * 24 * HOUR), 'What the Mute button on an alert does (0 hides it)'),

    // ── Quiet hours (every notification that is not exempt) ──────────────────
    k('notify.quiet.start', '22:30', { kind: 'clock' }, 'Quiet hours start'),
    k('notify.quiet.end', '06:30', { kind: 'clock' }, 'Quiet hours end (same as start: no quiet hours)'),
    k('notify.quiet.mode', 'silent', { kind: 'enum', values: ['silent', 'drop'] }, 'During quiet hours: no sound, or nothing at all'),
    k('notify.quiet.zone', 'device', { kind: 'zone' }, 'Whose clock: the phone\'s, or a named zone'),

    // ── Notifications sent from the admin ────────────────────────────────────
    k('notify.remote.enabled', 'true', { kind: 'bool' }, 'Kill switch for sent notifications (exempt types still arrive)'),
    k('notify.remote.disabledTypes', '-', { kind: 'csv', allowEmpty: true }, 'Types the app drops on arrival, to stop a campaign already sent'),
    k('notify.remote.maxPerDay', '3', int(0, 50), 'Sent notifications per device per day'),
    k('notify.remote.exemptTypes', 'system', { kind: 'csv', allowEmpty: true }, 'Types never capped, quietened or switched off'),

    // ── How changes reach phones ─────────────────────────────────────────────
    k('notify.config.maxAgeMs', String(6 * HOUR), int(5 * MIN, 7 * 24 * HOUR), 'Background refetch when the phone\'s copy is older than this'),
    k('notify.config.jitterMs', String(2 * MIN), int(0, HOUR), 'A refresh push is spread over this long'),

    // ── Words ({line} {severity} {reason} {previous}) ────────────────────────
    k('notify.copy.alertTitle', '{line} · {severity}', { kind: 'text' }, 'Alert title'),
    k('notify.copy.alertBody', '{reason}', { kind: 'text' }, 'Alert body when TfL gives a reason'),
    k('notify.copy.alertBodyNoReason', 'Tap to see your board.', { kind: 'text' }, 'Alert body otherwise'),
    k('notify.copy.recoveredTitle', '{line} · {severity}', { kind: 'text' }, 'Recovery title'),
    k('notify.copy.recoveredBody', 'Easing off. Earlier: {previous}.', { kind: 'text' }, 'Recovery body, still some disruption'),
    k('notify.copy.recoveredBodyGood', 'Back to normal. Earlier: {previous}.', { kind: 'text' }, 'Recovery body, Good Service'),
    k('notify.copy.muteAction', 'Mute for 12 hours', { kind: 'text' }, 'Mute button; keep in step with notify.line.muteMs'),
    k('notify.copy.levelSevere', 'Only severe delays and suspensions on your lines. Quiet overnight.', { kind: 'text' }, 'Caption under Severe'),
    k('notify.copy.levelAll', 'Minor delays and part closures too. Quiet overnight.', { kind: 'text' }, 'Caption under All'),
    k('notify.copy.levelOff', 'No line alerts. Your boards still show every change.', { kind: 'text' }, 'Caption under Off'),
];

/** Severities may differ per mode: `notify.line.alertSeverities.bus`. Optional. */
const MODE_KEY = /^notify\.line\.(alert|all)Severities\.[a-z0-9-]{2,30}$/;

/** Why [value] is not acceptable for [key], or null when it is. */
export function policyValueError(key: string, value: unknown): string | null {
    if (typeof value !== 'string') return 'must be a string';
    const v = value.trim();
    if (!v) return 'must not be blank (send null to remove an override)';
    const spec: Spec | undefined = NOTIFICATION_POLICY_KEYS.find(x => x.key === key)?.spec
        ?? (MODE_KEY.test(key) ? { kind: 'csv' } : undefined);
    if (!spec) return 'unknown key';
    switch (spec.kind) {
        case 'bool': return v === 'true' || v === 'false' ? null : 'must be true or false';
        case 'int': {
            if (!/^\d{1,15}$/.test(v)) return 'must be a whole number';
            const n = Number(v);
            return n >= spec.min && n <= spec.max ? null : `must be ${spec.min} to ${spec.max}`;
        }
        case 'enum': return spec.values.includes(v) ? null : `must be one of ${spec.values.join(', ')}`;
        case 'csv': {
            if (v === '-') return spec.allowEmpty ? null : 'must not be empty';
            const items = v.split(',').map(x => x.trim());
            if (items.some(x => !x)) return 'has an empty item';
            return v.length <= 500 ? null : 'too long';
        }
        case 'clock': return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : 'must be HH:MM';
        case 'zone': {
            if (v === 'device') return null;
            try { new Intl.DateTimeFormat('en-GB', { timeZone: v }); return null; } catch { return 'must be "device" or a time zone'; }
        }
        case 'text': return v.length <= MAX_TEXT ? null : `must be at most ${MAX_TEXT} characters`;
    }
}

export type PolicySource = 'live' | 'env' | 'default';
export interface PolicyEdit { set: Record<string, string | null>; by: string; reason: string }

const DOC = () => db.collection('app_config').doc('notification_policy');

export class NotificationPolicyService {
    private static live: Record<string, string> = {};
    private static warned = new Set<string>();

    /** Follow live overrides. One document, one read per change per worker. */
    static start(): void {
        DOC().onSnapshot(
            doc => this.adoptLive(doc.data()?.values),
            // Keep serving what we have: losing the listener must not change the policy.
            err => console.error('NOTIFY_POLICY: live overrides unavailable, keeping the last known', err?.message),
        );
    }

    /** Adopt stored overrides, dropping anything that no longer validates. */
    static adoptLive(values: unknown): void {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries((values ?? {}) as Record<string, unknown>)) {
            const error = policyValueError(key, value);
            if (error) console.warn(`NOTIFY_POLICY: ignoring stored ${key}: ${error}`);
            else next[key] = String(value).trim();
        }
        this.live = next;
        console.log(`NOTIFY_POLICY: ${Object.keys(next).length} live override(s)`);
    }

    /** What is in force, and why. */
    static effective(env: NodeJS.ProcessEnv = process.env): Record<string, { value: string; source: PolicySource }> {
        const out: Record<string, { value: string; source: PolicySource }> = {};
        for (const p of NOTIFICATION_POLICY_KEYS) {
            const fromEnv = (env[p.env] ?? '').trim();
            const envError = fromEnv ? policyValueError(p.key, fromEnv) : null;
            if (envError && !this.warned.has(p.env)) {
                this.warned.add(p.env);
                console.error(`NOTIFY_POLICY: ignoring ${p.env}: ${envError}`);
            }
            if (p.key in this.live) out[p.key] = { value: this.live[p.key], source: 'live' };
            else if (fromEnv && !envError) out[p.key] = { value: fromEnv, source: 'env' };
            else out[p.key] = { value: p.value, source: 'default' };
        }
        for (const [key, value] of Object.entries(this.live)) {
            if (MODE_KEY.test(key)) out[key] = { value, source: 'live' };
        }
        return out;
    }

    /** The `notify.*` keys for the home-config map. */
    static homeConfigKeys(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
        return Object.fromEntries(Object.entries(this.effective(env)).map(([key, v]) => [key, v.value]));
    }

    /** Every problem with an edit, so all of them can be fixed in one go. */
    static editErrors(edit: PolicyEdit): string[] {
        const entries = Object.entries(edit?.set ?? {});
        if (entries.length === 0) return ['set: nothing to change'];
        const errors = entries.flatMap(([key, value]) => {
            const known = NOTIFICATION_POLICY_KEYS.some(x => x.key === key) || MODE_KEY.test(key);
            const error = value === null ? (known ? null : 'unknown key') : policyValueError(key, value);
            return error ? [`${key}: ${error}`] : [];
        });
        if (!edit.reason?.trim()) errors.push('reason: required, it is the audit trail');
        return errors;
    }

    /** Store an edit. null removes an override. All or nothing. */
    static async applyEdit(edit: PolicyEdit): Promise<void> {
        const errors = this.editErrors(edit);
        if (errors.length) throw new Error(errors.join('; '));
        await db.runTransaction(async tx => {
            const values = { ...((await tx.get(DOC())).data()?.values ?? {}) } as Record<string, string>;
            for (const [key, value] of Object.entries(edit.set)) {
                if (value === null) delete values[key]; else values[key] = value.trim();
            }
            const record = { by: edit.by, reason: edit.reason.trim().slice(0, 200), at: Date.now(), set: edit.set };
            tx.set(DOC(), { values, last: record });
            tx.set(DOC().collection('history').doc(), record);
        });
    }

    /**
     * Ask every install to refetch home-config: a silent `config_refresh` to
     * `stationly_all`. Each phone waits a random moment within
     * `notify.config.jitterMs`, so they do not all arrive at once.
     */
    static async pushConfigRefresh(reason: string): Promise<string> {
        return messaging.send({
            topic: 'stationly_all',
            data: { type: 'config_refresh', reason: (reason || 'manual').slice(0, 80) },
            android: { priority: 'high', ttl: 24 * HOUR, collapseKey: 'config_refresh' },
        });
    }
}
