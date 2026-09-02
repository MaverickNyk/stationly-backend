/**
 * Which client builds are still allowed to run, and which should be nudged.
 *
 * ## Why this is a service and not six strings in the home config
 * The home config already carries `app.minVersion` and `app.storeUrl`, and the
 * shipped Android binary reads both — so they can never be removed or given a
 * new meaning (see docs/CONFIG_KEYS.md, additive rule). But that pair cannot
 * express what a real update policy needs:
 *
 *  - **One number for two platforms.** iOS and Android version independently.
 *    Raising the floor to orphan an old iOS build also nudged every Android
 *    user toward an update that does not exist.
 *  - **One threshold for two very different actions.** "You cannot use the app"
 *    and "there is something newer" are not the same statement, and collapsing
 *    them produces the worst of both: a dialog too weak to enforce anything and
 *    too loud to ignore.
 *  - **A Play Store URL served to iPhones.** `app.storeUrl` is hardcoded to
 *    play.google.com and there is no platform branching on `/sdui/app/home-config`,
 *    so an iOS user tapping "Update Now" landed on Google Play.
 *
 * So this serves a structured, per-platform document at
 * `GET /sdui/app/release-policy`, and `versionGateMiddleware` enforces the hard
 * floor from it on every data route. The legacy keys stay in the home config
 * untouched, for the Android binary that is already in the world.
 *
 * ## The two thresholds
 *  - `minimumVersion` — below this the client is BLOCKED. Non-dismissible.
 *    This is a statement about the BACKEND, not about features: raise it when
 *    the server genuinely cannot serve that client any more (a response shape
 *    changed, an auth scheme was retired, a client bug is corrupting data).
 *    Most users should never see it once in the app's lifetime.
 *  - `recommendedVersion` — below this the client may show a dismissible
 *    nudge, rate-limited by `nudgeIntervalDays` and snoozable. Optional by
 *    design: iOS automatic updates carry the overwhelming majority of the base
 *    forward on their own, so the honest default is to say nothing.
 *
 * ## The phased-release trap, and the invariant that prevents it
 * Apple rolls an automatic update out over 7 days. A `minimumVersion` set to a
 * build that has not finished rolling out tells a user "you must update" and
 * then offers them an App Store page with no Update button. They are locked
 * out of the app with no action available to them.
 *
 * [assertSafe] refuses that configuration outright: `minimumVersion` may never
 * exceed `latestVersion`, and `latestVersion` is meant to lag the newest
 * submitted build until its rollout completes. The check runs at module load,
 * so a bad edit fails the deploy rather than the user's launch.
 */

/** How a client identifies itself. Parsed from the `X-Stationly-Client` header. */
export interface ClientIdentity {
    platform: 'ios' | 'android' | 'unknown';
    /** Marketing version, e.g. "1.2.0" (CFBundleShortVersionString / versionName). */
    version: string;
    /** Build number, e.g. "47". Informational — never gated on. */
    build: string;
}

export interface PlatformRelease {
    /** Below this the client is blocked. Never above `latestVersion`. */
    minimumVersion: string;
    /** Below this the client may show a dismissible nudge. */
    recommendedVersion: string;
    /** Newest build that has FINISHED rolling out and is installable by anyone. */
    latestVersion: string;
    /** Preferred deep link — opens the store app directly, no browser bounce. */
    storeUrl: string;
    /** https fallback, for anywhere the scheme above cannot be handled. */
    storeUrlWeb: string;
    /** Minimum days between two nudges for the same user. */
    nudgeIntervalDays: number;
}

export interface ReleasePolicy {
    /**
     * Monotonic. Clients cache the document and store the version they hold, so
     * a push can say "you are stale" without carrying the payload.
     */
    version: number;
    /**
     * Master switch for the BLOCKING gate only. Nudges are unaffected.
     * Off means `versionGateMiddleware` passes everything through and clients
     * resolve `Blocked` to `Ok`. Turn it off to recover instantly from a
     * mis-set floor without waiting on a deploy.
     */
    gateEnabled: boolean;
    ios: PlatformRelease;
    android: PlatformRelease;
    /** Copy for the blocking screen. Flat strings so it stays platform-neutral. */
    strings: Record<string, string>;
}

/**
 * Dotted-segment comparison, lenient on purpose.
 *
 * Non-numeric segments are dropped and missing segments read as 0, so "1.2"
 * and "1.2.0" compare equal and "1.2.0-staging" compares as "1.2.0". This is
 * the exact behaviour of the client's `isVersionBelow` in
 * `core/.../ui/util/VersionCompare.kt`; the two must not drift, because the
 * client evaluates the same document offline and a disagreement shows up as a
 * gate that appears and disappears depending on connectivity.
 *
 * Returns <0 if a < b, 0 if equal, >0 if a > b.
 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string) =>
        String(v ?? '').trim().split('.')
            .map(s => parseInt(s, 10))
            .filter(n => Number.isFinite(n));
    const av = parse(a);
    const bv = parse(b);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
        const x = av[i] ?? 0;
        const y = bv[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** True when `installed` is strictly older than `minimum`. */
export function isVersionBelow(installed: string, minimum: string): boolean {
    return compareVersions(installed, minimum) < 0;
}

export type GateVerdict = 'ok' | 'nudge' | 'blocked';

/**
 * Parses `X-Stationly-Client: <platform>;<version>;<build>`.
 *
 * ## An unreadable header is never a blocked client
 * Anything malformed, absent, or from a platform this does not know resolves to
 * `unknown` with an empty version, and [verdictFor] passes `unknown` through as
 * `ok`. That is deliberate and it is the whole safety posture of the gate: the
 * failure directions do not cost the same. Letting one stale client through for
 * another launch is invisible; blocking a current client because a proxy
 * stripped a header is an app that will not open, and the user has no action
 * that fixes it.
 *
 * It also keeps every non-app caller working — the admin console, curl, the
 * Scalar API reference — none of which send the header and none of which should
 * have to.
 */
export function parseClientIdentity(header: string | undefined): ClientIdentity {
    const raw = String(header ?? '').trim();
    if (!raw) return { platform: 'unknown', version: '', build: '' };
    const [platformRaw, versionRaw, buildRaw] = raw.split(';');
    const platform = String(platformRaw ?? '').trim().toLowerCase();
    return {
        platform: platform === 'ios' ? 'ios' : platform === 'android' ? 'android' : 'unknown',
        // Capped: these land in log lines and in a 426 body, and an unbounded
        // client-controlled string has no business in either.
        version: String(versionRaw ?? '').trim().slice(0, 32),
        build: String(buildRaw ?? '').trim().slice(0, 32),
    };
}

export class AppReleaseService {

    /**
     * The policy in force.
     *
     * Editing this and redeploying changes every client's behaviour with no app
     * release. Bump `version` whenever anything below it changes.
     *
     * ## Current posture: nothing is gated
     * iOS v1 has not shipped and Android is frozen at 1.0, so both floors sit at
     * `1.0` and both `recommendedVersion`s match `latestVersion`. Every client
     * therefore resolves to `ok`. That is the correct resting state: the gate is
     * infrastructure for the day a backend change orphans a build, not something
     * to keep switched on.
     */
    private static readonly POLICY: ReleasePolicy = {
        version: 1,
        gateEnabled: true,
        ios: {
            minimumVersion: '1.0',
            recommendedVersion: '1.0',
            latestVersion: '1.0',
            // itms-apps opens the App Store app directly. The numeric id is the
            // one from App Store Connect and must be filled in before the gate
            // can usefully point anywhere — until then both links resolve to a
            // search, which is why `latestVersion` sits at the floor and nothing
            // is gated.
            storeUrl: 'itms-apps://apps.apple.com/app/id0000000000',
            storeUrlWeb: 'https://apps.apple.com/app/id0000000000',
            nudgeIntervalDays: 14,
        },
        android: {
            minimumVersion: '1.0',
            recommendedVersion: '1.0',
            latestVersion: '1.0',
            // market:// opens the Play Store app directly; the https form is the
            // same listing for anywhere that cannot handle the scheme.
            storeUrl: 'market://details?id=com.stationly.mobile',
            storeUrlWeb: 'https://play.google.com/store/apps/details?id=com.stationly.mobile',
            nudgeIntervalDays: 14,
        },
        strings: {
            'update.blocked.title':   'Time to update',
            'update.blocked.message': 'This version of Stationly is no longer supported. Update to keep seeing live departures.',
            'update.blocked.cta':     'Update Stationly',
            'update.nudge.title':     'New update available',
            'update.nudge.message':   'Update Stationly for the latest features and improvements.',
            'update.nudge.cta':       'Update Now',
            'update.nudge.dismiss':   'Not now',
        },
    };

    static getReleasePolicy(): ReleasePolicy {
        return this.POLICY;
    }

    /**
     * This client's half of the document.
     *
     * `policy` is a parameter defaulting to the live one so tests can drive the
     * matrix without mutating shared state. An earlier version of the suite
     * reached in and reassigned `POLICY.ios` around each case, restoring it in a
     * `finally` — which works right up until a case throws in the wrong place or
     * two run concurrently, and then leaks a raised floor into every test after
     * it. A gate is a bad thing to have flakily configured in its own tests.
     */
    static forPlatform(
        platform: ClientIdentity['platform'],
        policy: ReleasePolicy = this.POLICY,
    ): PlatformRelease | null {
        if (platform === 'ios') return policy.ios;
        if (platform === 'android') return policy.android;
        return null;
    }

    /**
     * What should happen to this client.
     *
     * `unknown` platforms and unparseable versions resolve to `ok` — see
     * [parseClientIdentity] for why that direction is the safe one.
     */
    static verdictFor(identity: ClientIdentity, policy: ReleasePolicy = this.POLICY): GateVerdict {
        const release = this.forPlatform(identity.platform, policy);
        if (!release) return 'ok';
        if (!identity.version) return 'ok';
        if (policy.gateEnabled && isVersionBelow(identity.version, release.minimumVersion)) {
            return 'blocked';
        }
        if (isVersionBelow(identity.version, release.recommendedVersion)) return 'nudge';
        return 'ok';
    }

    /**
     * The invariants that stop a config edit from locking users out.
     *
     * Exported so the test suite can assert them against arbitrary documents,
     * and called at module load against the real one so a bad edit fails the
     * deploy instead of the user's next launch. Throwing here is correct: a
     * server that boots with an unsatisfiable floor is worse than one that does
     * not boot, because the second failure is the one somebody notices.
     */
    static assertSafe(policy: ReleasePolicy = this.POLICY): void {
        for (const platform of ['ios', 'android'] as const) {
            const r = policy[platform];
            // The phased-release trap: a floor above what anyone can install is
            // a lockout with no user-side remedy.
            if (compareVersions(r.minimumVersion, r.latestVersion) > 0) {
                throw new Error(
                    `[AppReleaseService] ${platform}.minimumVersion (${r.minimumVersion}) is above ` +
                    `latestVersion (${r.latestVersion}) — every user would be blocked with no update to install.`,
                );
            }
            // A recommendation nobody can satisfy is a nudge that never goes
            // away however many times the user taps Update.
            if (compareVersions(r.recommendedVersion, r.latestVersion) > 0) {
                throw new Error(
                    `[AppReleaseService] ${platform}.recommendedVersion (${r.recommendedVersion}) is above ` +
                    `latestVersion (${r.latestVersion}) — the nudge could never be satisfied.`,
                );
            }
            if (!r.storeUrl || !r.storeUrlWeb) {
                throw new Error(`[AppReleaseService] ${platform} is missing a store URL.`);
            }
        }
    }
}

// Fail the deploy, not the launch.
AppReleaseService.assertSafe();
