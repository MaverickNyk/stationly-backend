import { Request, Response } from 'express';
import { DeviceRegistryService } from '../services/deviceRegistryService';
import { DevicePushService, PushSignalKind, DevicePushRequest } from '../services/devicePushService';
import { ApnsService } from '../services/apnsService';
import { auth } from '../config/firebase';

const PUSH_KINDS: PushSignalKind[] = [
    'user.sync', 'widget.refresh', 'policy.update', 'boost.start', 'boost.stop',
];

/**
 * The signed-in uid, if the caller happens to be signed in.
 *
 * Deliberately non-fatal: this route must keep working for a signed-out device
 * (widgets run and want disruption pushes either way), so a missing or invalid
 * token yields `undefined` rather than a 401. Verifying rather than reading a
 * body field is what stops a client claiming someone else's account and
 * receiving their `user.sync` signals.
 */
async function resolveUid(req: Request): Promise<string | undefined> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return undefined;
    try {
        return (await auth.verifyIdToken(header.split('Bearer ')[1])).uid;
    } catch {
        return undefined;   // expired/invalid token — register the device anyway
    }
}

export class DevicePushController {

    /**
     * @swagger
     * /device/register:
     *   post:
     *     summary: Register this iOS device's APNs tokens
     *     description: >
     *       Upserts the widget-extension push token (iOS 26+) and/or the app's
     *       APNs token, plus the stations this device's widgets show. Idempotent;
     *       the client calls it on cold launch, on token rotation, and whenever
     *       the station list changes.
     *     tags: [Widget Push]
     */
    static async register(req: Request, res: Response) {
        const {
            deviceId, widgetToken, appToken, environment,
            iosVersion, appVersion, stations,
        } = req.body ?? {};

        if (!deviceId || typeof deviceId !== 'string') {
            return res.status(400).json({ error: 'Missing deviceId' });
        }
        if (!widgetToken && !appToken) {
            return res.status(400).json({ error: 'Provide widgetToken and/or appToken' });
        }
        if (environment && environment !== 'production' && environment !== 'sandbox') {
            return res.status(400).json({ error: 'environment must be production or sandbox' });
        }

        try {
            await DeviceRegistryService.register({
                deviceId,
                // Optional: a signed-out device still runs widgets and still
                // wants disruption pushes, so registration is not gated on auth.
                //
                // But when the caller IS signed in we must capture the uid, or
                // `user.sync` — which targets by uid — reaches no iOS device at
                // all. That is exactly what happened when this route moved out
                // from under `/user/*` to stop it 401'ing: `req.user` stopped
                // being populated and the uid silently vanished from every
                // registration.
                //
                // Verified here rather than trusted from the body: a
                // self-asserted uid would let any client subscribe itself to
                // another account's sync signals.
                uid: await resolveUid(req),
                widgetToken,
                appToken,
                environment,
                iosVersion,
                appVersion,
                stations: Array.isArray(stations) ? stations.filter((s: unknown) => typeof s === 'string') : [],
            });
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
            await DeviceRegistryService.unregister(deviceId);
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
            const devices = await DeviceRegistryService.listAll();
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
