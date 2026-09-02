import { Request, Response, NextFunction } from 'express';
import {
    AppReleaseService, ReleasePolicy, parseClientIdentity,
} from '../services/appReleaseService';

/**
 * Refuses requests from clients the backend can no longer serve.
 *
 * ## Why the server enforces this and not just the app
 * The client already evaluates the same policy (see `ReleaseGate` in `core`),
 * and for a healthy client that is enough. It is not enough for the case the
 * gate exists for.
 *
 * A client-only gate has three holes, and the third is the one that matters:
 *
 *  1. **It is one screen.** The old check ran in `SummaryViewModel` after a
 *     successful home-config fetch, so it could only fire on the home screen.
 *     A user who launched into a board, a widget tap, or a deep link never
 *     reached it.
 *  2. **It can be cached away.** The config fetch fails offline and the client
 *     falls back to its last cached map, which predates the floor being raised.
 *  3. **It asks the broken client to police itself.** The floor gets raised
 *     precisely when an old build is doing something the server cannot cope
 *     with — sending a retired auth shape, mis-parsing a response, writing bad
 *     sync state. Trusting that build to correctly evaluate a config document
 *     and stop is trusting the thing you have already concluded is wrong.
 *
 * A 426 on the response path has none of those. It reaches every endpoint, it
 * cannot be served from a cache, and it does not need the client to cooperate —
 * the request simply does not succeed.
 *
 * ## 426 Upgrade Required, and why not 403
 * 426 means exactly this and nothing else, so it can never be confused with the
 * 401/403 the auth stack already uses. That separation is load-bearing:
 * `authExpiryGuard` in the client signs a user out on some 401s, and a gate
 * that borrowed that status would end sessions as a side effect of an old
 * build. The body carries `code: "client_too_old"` alongside the copy and the
 * store links, so the client can render the blocking screen straight from the
 * rejection without a second call.
 */

/**
 * What is deliberately EXEMPT.
 *
 * Never gate the routes a blocked client still needs, or the gate becomes
 * unrecoverable:
 *
 *  - `/sdui/app/release-policy` — the document that explains the block. Gating
 *    it means the client cannot learn why it was refused or where to go.
 *  - `/sdui/app/home-config` and `/sdui/app/theme-tokens` — the blocking screen
 *    is drawn with served copy and served colours. Gating these leaves it
 *    rendering compiled fallbacks.
 *  - `/auth/*` — a blocked user may still need to reset a password, and none of
 *    it touches the shapes a version floor is ever raised over.
 *
 * Written against the path as seen INSIDE the router, which Express strips of
 * the `/api/v1` mount prefix. That assumption is asserted by an integration
 * test rather than trusted: if it were wrong the list would silently never
 * match, and the failure would only show up as a blocked client unable to
 * recover — the exact scenario the list exists to prevent.
 */
export const EXEMPT_PREFIXES = [
    '/sdui/app/release-policy',
    '/sdui/app/home-config',
    '/sdui/app/theme-tokens',
    '/auth/',
];

/** The 426 payload. Enough to draw the blocking screen with no further calls. */
export interface UpgradeRejection {
    code: 'client_too_old';
    title: string;
    message: string;
    cta: string;
    minimumVersion: string | null;
    latestVersion: string | null;
    storeUrl: string | null;
    storeUrlWeb: string | null;
}

/**
 * The whole decision, as a pure function.
 *
 * Separated from the Express handler on purpose. What this returns is policy —
 * the part with all the branches, all the safety posture, and none of the
 * framework — and it can be exercised against any document without touching a
 * socket or mutating the live one. `enforce` below is the transport adapter and
 * has nothing left in it to get wrong except the two things a unit test cannot
 * see anyway: what `req.path` is relative to, and how a response is written.
 *
 * Returns `null` when the request should proceed.
 */
export function evaluateRequest(
    path: string,
    clientHeader: string | undefined,
    policy: ReleasePolicy,
    enforcing: boolean,
): UpgradeRejection | null {
    if (!enforcing) return null;
    if (EXEMPT_PREFIXES.some(p => path.startsWith(p))) return null;

    const identity = parseClientIdentity(clientHeader);
    if (AppReleaseService.verdictFor(identity, policy) !== 'blocked') return null;

    const release = AppReleaseService.forPlatform(identity.platform, policy);
    return {
        code: 'client_too_old',
        title: policy.strings['update.blocked.title'],
        message: policy.strings['update.blocked.message'],
        cta: policy.strings['update.blocked.cta'],
        minimumVersion: release?.minimumVersion ?? null,
        latestVersion: release?.latestVersion ?? null,
        storeUrl: release?.storeUrl ?? null,
        storeUrlWeb: release?.storeUrlWeb ?? null,
    };
}

/**
 * Off by default.
 *
 * The gate is infrastructure that sits idle until a backend change actually
 * orphans a build, and shipping it switched on means the first thing it can do
 * is misfire. Matches the `SUPPORT_ENABLED` posture: land the code dormant,
 * exercise it on staging, turn it on deliberately.
 *
 * Note this is a SECOND switch, independent of `ReleasePolicy.gateEnabled`.
 * That one is the policy statement ("is anything gated"); this one is the
 * deployment statement ("is this server allowed to enforce it"). Either being
 * false passes everything through, which means there are two ways to recover
 * from a mis-set floor and neither needs a code change.
 *
 * Read per request rather than cached at import: a cached value cannot be
 * changed without a restart, and the whole point of the faster switch is that
 * it is the one you reach for when something is already wrong.
 */
export function enforcementEnabled(): boolean {
    return String(process.env.VERSION_GATE_ENABLED ?? 'false').toLowerCase() === 'true';
}

export class VersionGateMiddleware {

    /**
     * Mounted in `apiRoutes` AFTER the API-key check and BEFORE the data routes,
     * so an unauthenticated caller still gets 401 first: "who are you" is
     * answered before "how old are you".
     */
    static enforce(req: Request, res: Response, next: NextFunction) {
        const rejection = evaluateRequest(
            req.path,
            req.header('X-Stationly-Client'),
            AppReleaseService.getReleasePolicy(),
            enforcementEnabled(),
        );
        if (!rejection) return next();
        res.status(426).json(rejection);
    }
}
