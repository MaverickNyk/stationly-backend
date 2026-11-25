import { db } from '../config/firebase';

/**
 * Feature flags: whether a feature is on, and where.
 *
 * Every new feature gets a flag here, DEFAULT OFF, and is turned on (or off
 * again, in seconds) from `PUT /admin/flags`. See docs/FEATURE_FLAGS.md.
 *
 * ## Where a value comes from, first match wins, per target
 *   1. LIVE: Firestore `app_config/feature_flags`, followed by every worker.
 *      No deploy, no restart.
 *   2. ENVIRONMENT (`FLAG_STATION_STATUS_SHOW=true`), for pinning one box.
 *   3. The DEFAULT below.
 *
 * ## It fails closed
 * Anything unreadable, unknown or not exactly true is OFF. Losing Firestore
 * keeps the last known values; a worker that never reached it uses 2 and 3.
 *
 * ## Targets
 * `server` is a flag this backend reads. `android` / `ios` are read by that
 * app, as `flag.<key>` = "true"/"false" in its home-config. A flag lists only
 * the targets that HAVE the feature, so it cannot be turned on anywhere else.
 */

export type FlagTarget = 'server' | 'android' | 'ios';

export interface FeatureFlag {
    key: string;
    about: string;
    targets: FlagTarget[];
    /** Where the default is on. Empty for a new feature; filled in when it has proved itself. */
    defaultOn?: FlagTarget[];
}

export const FEATURE_FLAGS: FeatureFlag[] = [
    {
        key: 'stationStatus.show',
        about: 'The app shows station closures on its boards. It receives them either way.',
        targets: ['android'],
    },
];

export type FlagSource = 'live' | 'env' | 'default';
type Values = Record<string, Partial<Record<FlagTarget, boolean>>>;
export interface FlagEdit {
    /** `true`/`false` sets every target, an object sets some, null removes the override. */
    set: Record<string, boolean | null | Partial<Record<FlagTarget, boolean | null>>>;
    by: string;
    reason: string;
}

const DOC = () => db.collection('app_config').doc('feature_flags');
const find = (key: string) => FEATURE_FLAGS.find(f => f.key === key);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** stationStatus.show -> FLAG_STATION_STATUS_SHOW */
export const flagEnv = (key: string): string =>
    'FLAG_' + key.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[.-]/g, '_').toUpperCase();

export class FeatureFlagService {
    private static live: Values = {};

    /** Follow live values. One document: one read per change per worker. */
    static start(): void {
        DOC().onSnapshot(
            doc => this.adoptLive(doc.data()?.values),
            // An errored listener is dead. Keep what we have, and follow again.
            err => {
                console.error('FLAGS: live values unavailable, keeping the last known', err?.message);
                setTimeout(() => this.start(), 30_000).unref();
            },
        );
    }

    /** Adopt stored values, dropping what no flag declares. */
    static adoptLive(values: unknown): void {
        const next: Values = {};
        for (const [key, stored] of Object.entries(isObject(values) ? values : {})) {
            const flag = find(key);
            if (!flag || !isObject(stored)) { console.warn(`FLAGS: ignoring stored ${key}`); continue; }
            for (const target of flag.targets) {
                if (typeof stored[target] === 'boolean') (next[key] ??= {})[target] = stored[target] as boolean;
            }
        }
        this.live = next;
    }

    private static setting(flag: FeatureFlag, target: FlagTarget, env: NodeJS.ProcessEnv): { on: boolean; source: FlagSource } {
        const live = this.live[flag.key]?.[target];
        if (live !== undefined) return { on: live, source: 'live' };
        const fromEnv = (env[flagEnv(flag.key)] ?? '').trim().toLowerCase();
        if (fromEnv === 'true' || fromEnv === 'false') return { on: fromEnv === 'true', source: 'env' };
        return { on: flag.defaultOn?.includes(target) ?? false, source: 'default' };
    }

    /** Whether a feature is on. An unknown key or target is off. */
    static isOn(key: string, target: FlagTarget = 'server', env: NodeJS.ProcessEnv = process.env): boolean {
        const flag = find(key);
        return !!flag && flag.targets.includes(target) && this.setting(flag, target, env).on;
    }

    /** The `flag.*` keys for one app's home-config. A platform we do not know gets every flag off. */
    static homeConfigKeys(platform: string | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
        const target = (platform ?? '').trim().toLowerCase() as FlagTarget;
        return Object.fromEntries(FEATURE_FLAGS
            .filter(f => f.targets.some(t => t !== 'server'))
            .map(f => [`flag.${f.key}`, String(target !== 'server' && this.isOn(f.key, target, env))]));
    }

    /** Every flag, whether it is on, and what says so. */
    static describe(env: NodeJS.ProcessEnv = process.env) {
        return FEATURE_FLAGS.map(f => ({
            key: f.key, about: f.about, env: flagEnv(f.key),
            targets: Object.fromEntries(f.targets.map(t => [t, this.setting(f, t, env)])),
        }));
    }

    /** Every problem with an edit, so all of them can be fixed in one go. */
    static editErrors(edit: FlagEdit): string[] {
        if (!isObject(edit?.set) || Object.keys(edit.set).length === 0) return ['set: nothing to change'];
        const errors: string[] = [];
        for (const [key, change] of Object.entries(edit.set)) {
            const flag = find(key);
            if (!flag) { errors.push(`${key}: unknown flag`); continue; }
            if (change === null || typeof change === 'boolean') continue;
            if (!isObject(change) || Object.keys(change).length === 0) { errors.push(`${key}: must be true, false, null or an object of targets`); continue; }
            for (const [target, v] of Object.entries(change)) {
                if (!flag.targets.includes(target as FlagTarget)) errors.push(`${key}: no target ${target} (has ${flag.targets.join(', ')})`);
                else if (v !== null && typeof v !== 'boolean') errors.push(`${key}.${target}: must be true, false or null`);
            }
        }
        if (typeof edit.reason !== 'string' || !edit.reason.trim()) errors.push('reason: required, it is the audit trail');
        return errors;
    }

    /** Stored values with an edit applied. */
    static merged(values: unknown, set: FlagEdit['set']): Values {
        const next: Values = JSON.parse(JSON.stringify(isObject(values) ? values : {}));
        for (const [key, change] of Object.entries(set)) {
            if (change === null) { delete next[key]; continue; }
            const targets = find(key)?.targets ?? [];
            const parts = typeof change === 'boolean' ? Object.fromEntries(targets.map(t => [t, change])) : change;
            const own = isObject(next[key]) ? next[key] : {};
            for (const [t, v] of Object.entries(parts)) {
                if (v === null) delete own[t as FlagTarget]; else own[t as FlagTarget] = v as boolean;
            }
            if (Object.keys(own).length) next[key] = own; else delete next[key];
        }
        return next;
    }

    /** Store an edit. All or nothing, with who, when and why. */
    static async applyEdit(edit: FlagEdit): Promise<void> {
        const errors = this.editErrors(edit);
        if (errors.length) throw new Error(errors.join('; '));
        await db.runTransaction(async tx => {
            const values = this.merged((await tx.get(DOC())).data()?.values, edit.set);
            const record = { by: edit.by, reason: edit.reason.trim().slice(0, 200), at: Date.now(), set: edit.set };
            tx.set(DOC(), { values, last: record });
            tx.set(DOC().collection('history').doc(), record);
        });
    }
}
