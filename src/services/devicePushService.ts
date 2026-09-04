import { ApnsService, ApnsSendResult } from './apnsService';
import { UserDeviceService, AddressableDevice } from './userDeviceService';

/** An [AddressableDevice] proven to have both a token and the host it belongs to. */
type ReachableDevice = AddressableDevice & { environment: NonNullable<AddressableDevice['environment']> };
import { UserWatchIndex } from './userWatchIndex';
import { db } from '../config/firebase';
import { RefreshPolicyService } from './refreshPolicyService';

/**
 * The four things the backend can tell an iOS widget to do.
 *
 * ## Signals, never data
 * Every envelope below is a few dozen bytes and carries no departures. The
 * client is told THAT something changed and fetches for itself. That is
 * deliberate:
 *
 *  - a WidgetKit push reloads the widget without waking the app, so there is no
 *    process available to parse a data payload into SQLite anyway;
 *  - APNs payloads are capped (4KB) and a real board can exceed it, so a
 *    data-carrying design would work until a busy interchange broke it;
 *  - and the client fetching means the board is current as of the moment it
 *    renders rather than as of the moment we sent, which for a countdown is the
 *    difference between right and nearly right.
 *
 * ## Delivery is best-effort, by design
 * None of these are the schedule. iOS throttles background pushes, drops them
 * entirely when Background App Refresh is off, and meters widget pushes on
 * their own budget. The adaptive schedule in `refreshPolicyService` is what
 * guarantees freshness; these only ever make a board fresher, sooner. Anything
 * that would BREAK if a push were dropped does not belong here — which is
 * exactly why `boost.start` carries its own absolute expiry rather than
 * depending on a later `boost.stop` arriving.
 */
export type PushSignalKind =
    /** The user's server-side state changed — stations, profile, or the account
     *  deleted. **Every platform**, and the only signal here that is not about
     *  the widget: it is the cross-device consistency guarantee, so a change made
     *  on one device reaches the others in seconds rather than at their next
     *  cold launch. Targeted by uid, not by station. */
    | 'user.sync'
    /** Refetch now. Optionally scoped to the devices showing given stations. */
    | 'widget.refresh'
    /** The cached refresh policy is stale — refetch it and republish.
     *  This is what makes a schedule change land on a phone whose app is not
     *  running. */
    | 'policy.update'
    /** Temporarily promote to a denser tier (match night, festival, incident). */
    | 'boost.start'
    /** End a boost early. An optimisation only — boosts self-expire. */
    | 'boost.stop';

export interface DevicePushRequest {
    kind: PushSignalKind;
    /** Restrict to devices showing these station grouping ids. Empty = all. */
    stations?: string[];
    /** Restrict to devices tracking these line ids — how a disruption is
     *  scoped, since TfL reports incidents by line rather than by station. */
    lines?: string[];
    /** Restrict to one account's devices — required for `user.sync`, which is
     *  meaningless unscoped. Also carried IN the payload so a client can check
     *  it against the signed-in user before acting: a device token outlives a
     *  session, and acting on a push minted for a previous account would
     *  reconcile — or log out — the wrong one. */
    uid?: string;
    /**
     * Drop this device from the resolved audience — it is the one that CAUSED
     * the change and has nothing to reconcile.
     *
     * `user.sync` fans out to every device on the account including the sender,
     * so the phone that just saved a board is woken by its own write and
     * answers with a `getUserProfile` read of state it already has. At twenty
     * app opens a day that is a self-inflicted read and push per edit, on the
     * hottest document in the system.
     *
     * Optional and unset by default: a caller that cannot say which device it
     * was gets exactly today's behaviour, which is the safe direction — a
     * missed exclusion costs one redundant reconcile, and a wrong one would
     * leave a device permanently stale.
     */
    excludeDeviceId?: string;
    /** `boost.start` only: which tier, defaulting to the policy's boost tier. */
    tierId?: string;
    /** `boost.start` only: requested minutes. The CLIENT caps this at the
     *  policy's `maxDurationMinutes` regardless of what is asked for. */
    minutes?: number;
    /** Qualifies the signal. For `user.sync`: "stations" | "profile" | "deleted".
     *  Otherwise free text carried into the device trace ("match:wembley"). */
    reason?: string;
    /**
     * `user.sync` only: the account's `stateRev` after the write that caused it.
     *
     * A receiving client compares it against the rev it last applied and does
     * nothing when they match, which is what makes a duplicate push — or a push
     * that loses a race to the foreground check — free instead of a Firestore
     * read. Exact rather than guessed; see `UserService.afterContentWrite`.
     */
    rev?: number;
}

export interface DevicePushOutcome {
    kind: PushSignalKind;
    devicesTargeted: number;
    /** Sent to a widget extension directly (iOS 26+). */
    widgetPushes: number;
    /** Sent as a silent app wake (iOS 17–25 fallback). */
    backgroundPushes: number;
    delivered: number;
    failed: number;
    pruned: number;
    /** Reason strings with counts, for the admin view. Never contains tokens. */
    failures: Record<string, number>;
}

/**
 * How long to let the app apply a state change before repainting the widget.
 *
 * Measured on device, a background push woke the app and its new schedule was
 * published one second later. Five gives generous headroom for a cold wake
 * without making an admin action feel hung.
 *
 * Deliberately best-effort: if the app is slower than this — throttled, or
 * Background App Refresh off — the widget repaints with the previous schedule
 * and picks the change up on its next build. That is no worse than sending both
 * concurrently, which is what this replaced.
 */
const STATE_APPLY_DELAY_MS = 5000;

export class DevicePushService {

    /**
     * Collapse ids, so a storm of upstream events costs a device one wake.
     *
     * Keyed by kind (and by station where the push is scoped) rather than being
     * globally constant: a Victoria closure and a Piccadilly closure arriving
     * together are two facts and should not collapse into one, but forty
     * updates about the SAME closure should.
     */
    private static collapseId(request: DevicePushRequest): string {
        const scope = request.lines?.length
            ? request.lines.slice().sort().join(',').slice(0, 40)
            : request.stations?.length
                ? request.stations.slice().sort().join(',').slice(0, 40)
                : request.uid ?? 'all';
        return `${request.kind}:${scope}`;
    }

    /**
     * The envelope a client receives.
     *
     * A widget push may carry custom keys alongside `content-changed`, but the
     * extension is reloaded rather than handed the payload — so the fields that
     * matter for `boost.*` and `policy.update` only really reach the app, via
     * the background push. Both are sent for exactly that reason: the widget
     * push makes the board current NOW, and the background push carries the
     * state change that has to be persisted.
     */
    private static payload(request: DevicePushRequest, widgetPush: boolean): Record<string, unknown> {
        const stationly: Record<string, unknown> = {
            type: request.kind,
            policyVersion: RefreshPolicyService.getRefreshPolicy().version,
            ts: Date.now(),
        };
        if (request.stations?.length) stationly.stations = request.stations;
        if (request.lines?.length) stationly.lines = request.lines;
        // Carried so the client can verify the push is for the account it is
        // currently signed into. A device token outlives a session, so acting
        // on a push minted for a previous user would reconcile — or, for
        // `user.sync` reason=deleted, LOG OUT — the wrong account.
        if (request.uid) stationly.uid = request.uid;
        if (request.tierId) stationly.tierId = request.tierId;
        if (request.minutes) stationly.minutes = request.minutes;
        if (request.reason) stationly.reason = request.reason;
        // `typeof`, not truthiness: rev 0 is a legitimate value (an account
        // whose content has not changed since the field shipped) and `if (0)`
        // would silently drop it.
        if (typeof request.rev === 'number') stationly.rev = request.rev;

        return widgetPush
            // `content-changed` is what tells WidgetKit this is a timeline
            // reload rather than anything user-visible.
            ? { aps: { 'content-changed': true }, stationly }
            // `content-available: 1` is what makes iOS wake the app silently.
            // Without it the push is delivered but nothing runs.
            : { aps: { 'content-available': 1 }, stationly };
    }

    /**
     * Send one trigger to its audience.
     *
     * Each device gets the BEST path it supports, and only one of them where
     * both would do the same job:
     *  - a `widget.refresh` on a device with a widget token goes straight to the
     *    widget, and the app is left asleep;
     *  - everything that changes persisted STATE (`policy.update`, `boost.*`)
     *    needs the app, so it goes as a background push — a widget reload alone
     *    cannot store anything.
     */
    /**
     * Turn a trigger's scope into the device rows it should reach.
     *
     * Three scopes, and after P2 they take three different shapes:
     *
     * | scope | how |
     * |---|---|
     * | one account (`user.sync`) | `users/{uid}/devices` — a read on a KNOWN PATH |
     * | a station or line (disruption) | **two hops**: the SQLite index says which accounts watch it, then each account's rows supply the tokens |
     * | everything (broadcast) | `collectionGroup('devices')` |
     *
     * The per-account path is the one worth understanding. It was
     * `devices where uid == X`, a single-field query on an auto-indexed field
     * returning the same document count. The gain is not fewer reads — it is
     * that **a query stops existing**: a read on a known path needs no index,
     * cannot fail for want of one, and cannot return somebody else's row.
     *
     * The two-hop disruption path is not a regression either. Billing is per
     * document RETURNED and the same devices come back either way; at steady
     * state the first hop is SQLite and costs nothing at all. What it removes is
     * the reason the device row was carrying account data in the first place
     * (§3.1) — and with it the rewrite-every-device cost of a single board edit.
     */
    private static async resolveAudience(request: DevicePushRequest): Promise<ReachableDevice[]> {
        // Narrowest first. A uid scope beats a station scope because `user.sync`
        // is about an ACCOUNT — sending it to every device showing a station
        // would push one user's profile change at strangers.
        if (request.uid) return this.rowsForUids([request.uid]);

        if (request.lines?.length) {
            return this.rowsForUids(await UserWatchIndex.uidsForLines(request.lines));
        }
        if (request.stations?.length) {
            return this.rowsForUids(await UserWatchIndex.uidsForStations(request.stations));
        }

        // Broadcast. The unfiltered collection group needs no index of its own —
        // verified against staging rather than assumed, by
        // `check_device_indexes.cjs`.
        const snap = await db.collectionGroup('devices').get();
        const out: ReachableDevice[] = [];
        for (const doc of snap.docs) {
            const account = doc.ref.parent.parent;
            // ⚠️ Skips the RETIRED root `devices` collection, which a collection
            // group also matches until it is gone. Including it would push to
            // rows whose account association is stale.
            if (!account) continue;
            const row = this.asRegistered(account.id, doc.data());
            if (this.isReachable(row)) out.push(row);
        }
        return out;
    }

    /**
     * The device rows for a set of accounts, each a read on a known path.
     *
     * Reads run in parallel: a disruption on a busy line resolves a few hundred
     * accounts, and doing that sequentially would put the round-trip latency of
     * each read on the critical path of a notification that is already late by
     * the time it is triggered.
     */
    private static async rowsForUids(uids: string[]): Promise<ReachableDevice[]> {
        if (uids.length === 0) return [];
        const snaps = await Promise.all(
            uids.map(uid => UserDeviceService.devices(uid).get().then(s => ({ uid, s }))),
        );
        const out: ReachableDevice[] = [];
        for (const { uid, s } of snaps) {
            for (const doc of s.docs) {
                const row = this.asRegistered(uid, doc.data());
                if (this.isReachable(row)) out.push(row);
            }
        }
        return out;
    }

    /**
     * Present a device row in the shape the send path already speaks.
     *
     * `uid` is restored from the PARENT here. The row deliberately does not
     * store it — the path already names the account, and a second copy is a
     * second thing that can drift — but everything downstream (the trace, the
     * token pruner) still wants to know whose device it is.
     */
    private static asRegistered(uid: string, row: any): AddressableDevice {
        return { ...row, uid } as AddressableDevice;
    }

    /**
     * Can this row actually receive an APNs push?
     *
     * ## Why this filter did not exist before, and must now
     * Under the old root collection a row was CREATED by `/device/register`, so
     * having a row implied having a token. Under the merged shape the row is the
     * SESSION: login creates it, and login deliberately never writes a token
     * field (that rule protects against a different bug — see the write in
     * `startSession`). So a signed-in device that has not yet registered for
     * push, or one that never will, now has a row with no way to reach it.
     *
     * Without this filter those rows join every audience. Observed on staging
     * immediately after the cutover: `APNs → 0/2 device(s)` where the honest
     * count was 1 — two token-less rows had been added to the audience for an
     * account with a single reachable device.
     *
     * That is not merely a wrong metric. `devicesTargeted` is what the
     * verification advice in the design leans on — "assert push audiences are
     * NON-EMPTY, verify the audience, never the send" — so an audience padded
     * with unreachable rows makes exactly the check that is supposed to catch a
     * silent push failure report success.
     */
    private static isReachable(row: AddressableDevice): row is ReachableDevice {
        // An `environment` is as necessary as a token. An APNs token is valid
        // against EXACTLY ONE host, so a row that does not say which is a row we
        // cannot deliver to — and guessing is the trap the field exists to
        // prevent: a sandbox token sent to the production gateway is rejected as
        // BadDeviceToken, which looks exactly like a dead token and gets the
        // device pruned from its own audience.
        return !!(row.appToken || row.widgetToken) && !!row.environment;
    }

    static async send(request: DevicePushRequest): Promise<DevicePushOutcome> {
        // Audience, narrowest first. A uid scope beats a station scope because
        // `user.sync` is about an ACCOUNT — sending it to every device showing
        // a station would push one user's profile change at strangers.
        const resolved = await this.resolveAudience(request);

        // Applied after resolution rather than in the query: Firestore has no
        // "!=" that composes with the scoping filters without another index, and
        // the audience for one account is a handful of rows either way.
        const devices = request.excludeDeviceId
            ? resolved.filter(d => d.deviceId !== request.excludeDeviceId)
            : resolved;

        const outcome: DevicePushOutcome = {
            kind: request.kind,
            devicesTargeted: devices.length,
            widgetPushes: 0,
            backgroundPushes: 0,
            delivered: 0,
            failed: 0,
            pruned: 0,
            failures: {},
        };
        if (!devices.length) return outcome;
        if (!ApnsService.isConfigured()) {
            outcome.failures.ApnsNotConfigured = devices.length;
            outcome.failed = devices.length;
            return outcome;
        }

        const collapseId = this.collapseId(request);
        // A refresh is purely a display update, so the widget path alone is
        // enough where it exists. Anything else has to reach the app, because
        // only the app can write to storage — `user.sync` most of all, since
        // reconciling an account touches SQLite, the keychain and possibly the
        // session itself.
        const widgetOnly = request.kind === 'widget.refresh';

        const widgetTargets: Array<{ token: string; environment: ReachableDevice['environment'] }> = [];
        const appTargets: Array<{ token: string; environment: ReachableDevice['environment'] }> = [];

        for (const device of devices) {
            if (device.widgetToken) {
                widgetTargets.push({ token: device.widgetToken, environment: device.environment });
            }
            const needsApp = !widgetOnly || !device.widgetToken;
            if (needsApp && device.appToken) {
                appTargets.push({ token: device.appToken, environment: device.environment });
            }
        }

        outcome.widgetPushes = widgetTargets.length;
        outcome.backgroundPushes = appTargets.length;

        const sendWidget = () => widgetTargets.length
            ? ApnsService.sendMany(widgetTargets, {
                pushType: 'widgets',
                payload: this.payload(request, true),
                collapseId,
            })
            : Promise.resolve<ApnsSendResult[]>([]);
        const sendApp = () => appTargets.length
            ? ApnsService.sendMany(appTargets, {
                pushType: 'background',
                payload: this.payload(request, false),
                collapseId,
            })
            : Promise.resolve<ApnsSendResult[]>([]);

        // ── Order matters for anything that changes STATE ──
        //
        // A widget push repaints the widget immediately, reading whatever the
        // App Group holds at that instant. A background push wakes the app,
        // which is what actually applies the new state and republishes the
        // schedule. Sent concurrently, the repaint wins the race and renders
        // the state we were about to replace — and the app cannot fix it
        // afterwards, because iOS ignores `reloadTimelines` from a
        // background-woken app.
        //
        // Measured: a `boost.start` at 13:36:06 repainted with the pre-boost
        // cadence (P2/45m); the app published the boosted schedule (P1/15m) one
        // second later and its reload was dropped, leaving the widget on a
        // 45-minute timeline for the entire 90-minute boost. The boost was
        // stored perfectly and had no visible effect whatsoever.
        //
        // So: app first, give it a moment to persist and publish, THEN repaint.
        // `widget.refresh` is exempt — it carries no state, so there is nothing
        // to race and no reason to delay a disruption update.
        let widgetResults: ApnsSendResult[];
        let appResults: ApnsSendResult[];

        if (request.kind === 'widget.refresh' || !appTargets.length) {
            [widgetResults, appResults] = await Promise.all([sendWidget(), sendApp()]);
        } else {
            appResults = await sendApp();
            if (widgetTargets.length) {
                await new Promise(resolve => setTimeout(resolve, STATE_APPLY_DELAY_MS));
            }
            widgetResults = await sendWidget();
        }

        const prunable: string[] = [];
        for (const result of [...widgetResults, ...appResults]) {
            if (result.ok) { outcome.delivered++; continue; }
            outcome.failed++;
            const reason = result.reason ?? 'Unknown';
            outcome.failures[reason] = (outcome.failures[reason] ?? 0) + 1;
            if (result.shouldUnregister) prunable.push(result.token);
        }

        // Dropping dead tokens matters more here than for alerts: this registry
        // is queried on every disruption, and a device that reinstalled months
        // ago would otherwise be pushed at forever.
        if (prunable.length) {
            await Promise.all(prunable.map(t => UserDeviceService.pruneToken(t)));
            outcome.pruned = prunable.length;
        }

        return outcome;
    }
}
