import { Request, Response } from 'express';
import { UserDeviceService } from '../services/userDeviceService';
import { DevicePushService, PushSignalKind, DevicePushRequest } from '../services/devicePushService';
import { ApnsService } from '../services/apnsService';
import { auth } from '../config/firebase';

const PUSH_KINDS: PushSignalKind[] = [
    'user.sync', 'widget.refresh', 'policy.update', 'boost.start', 'boost.stop',
];

/**
 * The signed-in uid, or undefined.
 *
 * Returns undefined rather than throwing so the caller decides what a missing
 * session means; both callers here answer 401, because after P2 there is no row
 * to write without a uid. Verifying rather than reading a body field is what
 * stops a client claiming someone else's account and receiving their
 * `user.sync` signals.
 *
 * ## `checkRevoked` is not optional here, and this route is why
 * `verifyIdToken(token)` on its own is an OFFLINE check: it validates the
 * signature and the expiry and asks Firebase nothing. An ID token stays
 * signature-valid for about an hour after it is minted, and `deleteAccount`
 * revokes REFRESH tokens, which does nothing to one already in a client's hand.
 *
 * That hour is enough to resurrect a deleted account. `/device/register` runs
 * on every foreground, and the iOS client gates it on `Auth.auth().currentUser`
 * — still populated locally for a while after the account is deleted on another
 * device. Accepting that token writes `users/{deletedUid}/devices/{id}`, live
 * APNs tokens and all, UNDER A DOCUMENT THAT NO LONGER EXISTS.
 *
 * Nothing can then clean it up. The sweep queries `users where loggedIn == true`
 * and the reconcile scans `users` documents; a deleted account appears in
 * neither. `ref.parent.parent` is non-null, so the collection-group parent
 * filter does not exclude it either, and the row sits in the broadcast audience
 * permanently. This is the same phantom-parent trap `purgeUserSubtree`'s comment
 * describes for `fcm_tokens`, reached from the other direction.
 *
 * The second argument costs one Firebase round trip on a route that already
 * makes a network call, and it is what `validateUserToken` on `/user/*` has done
 * all along (design §10). This route was the one place the rule was not applied.
 */
async function resolveUid(req: Request): Promise<string | undefined> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    try {
        // checkRevoked: rejects a revoked token AND a deleted auth user.
        return (await auth.verifyIdToken(header.split('Bearer ')[1], true)).uid;
    } catch {
        // Expired, revoked, or the account is gone. All three mean the same
        // thing to this route: there is no account to file a device row under.
        return undefined;
    }
}

// [asStringList] was deleted here. Its only callers normalised the `stations`
// and `lines` arrays into the device row, and P2 removed both fields — the
// audiences come from `UserWatchIndex` now. The trigger route below does its own
// filtering inline on a differently-shaped field.

/**
 * A body field that must reach Firestore as a string, or not at all.
 *
 * The request body is `any`, so TypeScript cannot stop a number or an object
 * reaching a field the registry types as `string`. Firestore would store it
 * happily — and a non-string TOKEN then travels all the way to the APNs client
 * before failing, as a delivery error on a device that looks correctly
 * registered.
 */
function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class DevicePushController {

    /**
     * @swagger
     * /device/register:
     *   post:
     *     summary: Register this iOS device's APNs tokens
     *     description: >
     *       Upserts the widget-extension push token (iOS 26+) and/or the app's
     *       APNs token onto `users/{uid}/devices/{deviceId}`. Requires a Firebase
     *       bearer — the account comes from the token, never from the body.
     *       Idempotent; the client calls it on cold launch, on sign-in and on
     *       token rotation.
     *
     *       `stations` and `lines` are NO LONGER accepted. They described the
     *       ACCOUNT rather than the device and were removed from the row by P2;
     *       the disruption and station audiences are now resolved from the
     *       backend's `user_watch` index, which re-derives from the synced
     *       boards. A client that still sends them is not rejected — they are
     *       simply ignored — but nothing reads them.
     *     tags: [Widget Push]
     */
    static async register(req: Request, res: Response) {
        // `stations` / `lines` are deliberately NOT destructured any more. Pulling
        // them out of the body and then not using them is how a field keeps
        // looking supported: the next reader sees the name, assumes a consumer,
        // and wires something to it. See the description above.
        const {
            deviceId, widgetToken, appToken, environment,
            iosVersion, appVersion,
        } = req.body ?? {};

        // Normalise BEFORE validating, so the presence check below sees what will
        // actually be stored. Checking the raw body first would let a non-string
        // token pass the guard and then fail the service's own identical check —
        // turning a malformed request into a 500 instead of the 400 it is.
        const widget = asString(widgetToken);
        const app = asString(appToken);

        if (!deviceId || typeof deviceId !== 'string') {
            return res.status(400).json({ error: 'Missing deviceId' });
        }
        if (!widget && !app) {
            return res.status(400).json({ error: 'Provide widgetToken and/or appToken' });
        }
        if (environment && environment !== 'production' && environment !== 'sandbox') {
            return res.status(400).json({ error: 'environment must be production or sandbox' });
        }

        // ⚠️ NOW BEARER-GATED. This is a genuine behaviour change, not an
        // additive one, and it is the only non-additive change in the whole
        // migration.
        //
        // Registration used to be API-key-only, on the reasoning that a
        // signed-out device still runs widgets and still wants disruption
        // pushes. Under the merged shape there is no row to write without a uid
        // — the row lives at `users/{uid}/devices/{deviceId}` and its existence
        // IS the session — so an unauthenticated registration has nowhere to go.
        //
        // The matching client rule: iOS must not attempt registration until it
        // holds a session, and must treat signed-out as SKIP rather than as a
        // failure to retry. Android never calls this endpoint (it registers push
        // through `/user/fcm/register`), so the frozen APK is untouched.
        const uid = await resolveUid(req);
        if (!uid) {
            return res.status(401).json({
                error: 'Sign-in required to register a device',
                code: 'no_session',
            });
        }

        try {
            await UserDeviceService.upsert(uid, {
                deviceId,
                // ONLY this endpoint writes token fields. Login creates and
                // merges the row — that is what a session is now — but a login
                // that wrote a token, or wrote `undefined` into one, would put a
                // token-less phantom into the broadcast audience. The old root
                // collection was bitten by exactly that in `bind`; the rule
                // survives the move, only its subject narrowed to the tokens.
                widgetToken: widget,
                appToken: app,
                environment,
                osVersion: asString(iosVersion),
                appVersion: asString(appVersion),
                platform: 'ios' as const,
                lastSeen: Date.now(),
            });

// (The retired root `devices` collection is gone — see UserDeviceService.)
            return res.json({ success: true, apnsConfigured: ApnsService.isConfigured() });
        } catch (error: any) {
            return res.status(500).json({ error: error?.message ?? 'Register failed' });
        }
    }

    /**
     * @swagger
     * /device/unregister:
     *   post:
     *     summary: Remove this device from the widget push registry
     *     tags: [Widget Push]
     */
    static async unregister(req: Request, res: Response) {
        const { deviceId } = req.body ?? {};
        if (!deviceId) return res.status(400).json({ error: 'Missing deviceId' });
        try {
            // Unregistering means dropping this device's TOKENS, not its
            // session: the row IS the session, so deleting it here would sign
            // the user out of a device they are still using. Tokens only.
            const uid = await resolveUid(req);
            if (!uid) return res.status(401).json({ error: 'Sign-in required', code: 'no_session' });
            await UserDeviceService.clearTokens(uid, deviceId);
            return res.json({ success: true });
        } catch (error: any) {
            return res.status(500).json({ error: error?.message ?? 'Unregister failed' });
        }
    }

    /**
     * @swagger
     * /admin/device-push/send:
     *   post:
     *     summary: Trigger an immediate widget update
     *     description: >
     *       Body: { kind, stations?, tierId?, minutes?, reason? }.
     *       `widget.refresh` makes boards refetch now (scope it with `stations`
     *       for a closure); `policy.update` makes clients refetch the refresh
     *       schedule even when the app is not running; `boost.start` promotes to
     *       a denser tier for up to the policy's ceiling; `boost.stop` ends one
     *       early. Boosts self-expire on the device, so a dropped stop is safe.
     *     tags: [Admin, Widget Push]
     */
    static async send(req: Request, res: Response) {
        const { kind, stations, tierId, minutes, reason } = req.body ?? {};

        if (!PUSH_KINDS.includes(kind)) {
            return res.status(400).json({ error: `kind must be one of ${PUSH_KINDS.join(', ')}` });
        }
        if (minutes !== undefined && (typeof minutes !== 'number' || minutes <= 0)) {
            return res.status(400).json({ error: 'minutes must be a positive number' });
        }
        if (stations !== undefined && !Array.isArray(stations)) {
            return res.status(400).json({ error: 'stations must be an array' });
        }

        const request: DevicePushRequest = {
            kind,
            stations: Array.isArray(stations)
                ? stations.filter((s: unknown) => typeof s === 'string')
                : undefined,
            tierId, minutes, reason,
        };

        try {
            return res.json(await DevicePushService.send(request));
        } catch (error: any) {
            return res.status(500).json({ error: error?.message ?? 'Send failed' });
        }
    }

    /**
     * @swagger
     * /admin/device-push/status:
     *   get:
     *     summary: Whether APNs is configured, and how many devices are registered
     *     tags: [Admin, Widget Push]
     */
    static async status(_req: Request, res: Response) {
        try {
            const devices = (await UserDeviceService.listAll()).map(d => d.row);
            return res.json({
                apnsConfigured: ApnsService.isConfigured(),
                bundleId: ApnsService.bundleId(),
                devices: devices.length,
                // Counts only. Tokens are device identifiers and never leave
                // the backend — same invariant the admin SendResult keeps.
                withWidgetToken: devices.filter(d => d.widgetToken).length,
                withAppToken: devices.filter(d => d.appToken).length,
                sandbox: devices.filter(d => d.environment === 'sandbox').length,
            });
        } catch (error: any) {
            return res.status(500).json({ error: error?.message ?? 'Status failed' });
        }
    }
}
