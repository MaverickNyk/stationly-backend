import { Request, Response } from 'express';
import { UserService, SubscribedStation, SavedBoard } from '../services/userService';
import { SduiService } from '../services/sduiService';
import { UserFcmTokenService } from '../services/userFcmTokenService';
import { UserActivityService } from '../services/userActivityService';

/**
 * A `deviceId` from a request body, or undefined when absent or unusable.
 *
 * Advisory only — it decides whether the CALLING device is skipped in a
 * `user.sync` fan-out, and nothing else. It is never used to authorise
 * anything, so an unverified body field is the right source: the worst a
 * client can do by lying is deny itself a push it did not need, or wake
 * itself, which is what happens today anyway.
 *
 * Absent on every build shipped so far, and absent is exactly the previous
 * behaviour, so this can land ahead of the clients that will send it.
 */
function asDeviceId(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class UserController {

    /**
     * @swagger
     * /user/sync/profile:
     *   post:
     *     summary: Sync User Profile
     *     description: Sync user details from Auth provider to Firestore.
     *     tags: [Users]
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: '#/components/schemas/UserSyncRequest'
     *     responses:
     *       200:
     *         description: Profile synced successfully
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UserProfile'
     *       400:
     *         description: Missing required fields
     */
    static async syncProfile(req: Request, res: Response) {
        const { uid, email, displayName, photoURL, signInProvider, deviceId, deviceInfo, ...other } = req.body;

        if (!uid || !email) {
            return res.status(400).json({ error: "UID and Email are required for sync" });
        }

        // Source of truth for emailVerified is the decoded Firebase ID token, NOT the
        // request body — never trust the client to set its own verified flag.
        const tokenUser = (req as any).user as { emailVerified?: boolean } | undefined;
        const emailVerified = tokenUser?.emailVerified === true;

        try {
            const profile = await UserService.createOrUpdateUser(
                uid,
                email,
                {
                    displayName,
                    photoURL,
                    signInProvider,
                    ...other
                },
                emailVerified,
                typeof deviceId === 'string' && deviceId ? deviceId : undefined,
                deviceInfo && typeof deviceInfo === 'object' ? deviceInfo : undefined
            );
            res.json(profile);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * @swagger
     * /user/sync/stations:
     *   post:
     *     summary: Sync User Stations
     *     description: Sync local subscriptions to Firestore for a specific user.
     *     tags: [Users]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             $ref: '#/components/schemas/StationSyncRequest'
     *     responses:
     *       200:
     *         description: Stations synced successfully
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UserProfile'
     *       400:
     *         description: Missing UID or stations
     */
    static async syncStations(req: Request, res: Response) {
        const { uid, stations, deviceId } = req.body;

        if (!uid || !stations) {
            return res.status(400).json({ error: "UID and Stations list required" });
        }

        try {
            const result = await UserService.syncStations(
                uid,
                stations as SubscribedStation[],
                asDeviceId(deviceId),
            );
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * @swagger
     * /user/sync/boards:
     *   post:
     *     summary: Sync v2 Saved Boards
     *     description: |
     *       Replace the user's v2 board list. Platform-neutral: iOS is the only
     *       caller today and Android reaches it unchanged when it adopts the
     *       board model. Android's legacy list lives separately under `stations`
     *       and is never touched here.
     *
     *       Two guards, both answering with `200` + `applied: false` rather than
     *       an error, so a client is told to re-read instead of treating the sync
     *       as failed and retrying forever:
     *
     *       - `reason: "stale"` — `updatedAt` is at or before the stored one.
     *       - `reason: "empty_rejected"` — the write would replace a non-empty
     *         list with an empty one and `allowEmpty` was not set. Clearing an
     *         account is a real operation, but it must be asked for: a client
     *         whose local store is momentarily empty (mid-login, before the
     *         restore lands) otherwise deletes every board the user has.
     *     tags: [Users]
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [boards]
     *             properties:
     *               boards:    { type: array, items: { $ref: '#/components/schemas/SavedBoard' } }
     *               updatedAt: { type: number, description: Device clock, epoch millis }
     *               allowEmpty:
     *                 type: boolean
     *                 default: false
     *                 description: >
     *                   Permission to store an EMPTY board list over a non-empty one.
     *                   Set it only when a user action emptied the list. Ignored when
     *                   `boards` is non-empty; absent means false, so a client that
     *                   predates this field cannot clear an account by omission.
     *               deviceId:
     *                 type: string
     *                 description: >
     *                   This device's stable id. Optional and advisory: it is used
     *                   only to skip the calling device in the `user.sync` fan-out,
     *                   so it is not woken by its own write. Absent means notify
     *                   everything, which is the previous behaviour. Only the APNs
     *                   transport can honour it — FCM tokens carry no device id.
     *     responses:
     *       200: { description: Stored (check `applied` and `reason`) }
     *       400: { description: Missing or malformed boards }
     */
    static async syncBoards(req: Request, res: Response) {
        // UID from the validated token, never the body — this endpoint replaces
        // a list the user cannot afford to lose.
        const uid = (req as any).user?.uid as string | undefined;
        const { boards, updatedAt, allowEmpty, deviceId } = req.body ?? {};

        if (!uid) return res.status(401).json({ error: 'Unauthorized' });
        if (!Array.isArray(boards)) {
            return res.status(400).json({ error: 'boards must be an array' });
        }

        try {
            const result = await UserService.syncBoards(
                uid,
                boards as SavedBoard[],
                typeof updatedAt === 'number' ? updatedAt : undefined,
                // Strictly `=== true`: anything else, including the field being
                // absent, means the caller did not ask to empty the account. The
                // default has to be the non-destructive one — see the service.
                allowEmpty === true,
                asDeviceId(deviceId),
            );
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * @swagger
     * /user/activity/batch:
     *   post:
     *     summary: Upload a batch of activity events
     *     description: |
     *       Append this device's queued activity events. Called on a schedule
     *       (nightly, with a foreground fallback), never per action — the whole
     *       point of the local queue is that a day of app usage costs one write.
     *       Idempotent: every event carries a client-generated id and is appended
     *       with `arrayUnion`, so replaying a batch whose response was lost stores
     *       nothing twice.
     *     tags: [Users]
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [deviceId, events]
     *             properties:
     *               deviceId:   { type: string }
     *               platform:   { type: string, enum: [android, ios, web] }
     *               appVersion: { type: string }
     *               events:
     *                 type: array
     *                 items:
     *                   type: object
     *                   required: [id, name, t]
     *                   properties:
     *                     id:    { type: string, description: Client-generated, unique }
     *                     name:  { type: string, description: e.g. app.opened }
     *                     t:     { type: number, description: Device clock, epoch millis }
     *                     props: { type: object, description: Flat scalars only }
     *     responses:
     *       200: { description: Accepted (may report some events rejected) }
     *       400: { description: Missing deviceId or events }
     */
    static async recordActivity(req: Request, res: Response) {
        const uid = (req as any).user?.uid as string | undefined;
        const { deviceId, platform, appVersion, events } = req.body ?? {};

        if (!uid) return res.status(401).json({ error: 'Unauthorized' });
        if (!deviceId || typeof deviceId !== 'string') {
            return res.status(400).json({ error: 'deviceId is required' });
        }
        if (!Array.isArray(events)) {
            return res.status(400).json({ error: 'events must be an array' });
        }
        if (events.length > UserActivityService.MAX_EVENTS_PER_BATCH) {
            return res.status(400).json({
                error: `too many events (max ${UserActivityService.MAX_EVENTS_PER_BATCH} per batch)`,
                max: UserActivityService.MAX_EVENTS_PER_BATCH,
            });
        }

        try {
            const result = await UserActivityService.record({
                uid, deviceId, platform, appVersion, events,
            });
            res.json({ success: true, ...result });
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * @swagger
     * /sdui/app/profile/{uid}:
     *   get:
     *     summary: Get SDUI Profile Layout
     *     description: Get dynamically generated server-driven UI layout for the user's profile.
     *     tags: [SDUI, Users]
     *     parameters:
     *       - in: path
     *         name: uid
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: User profile layout object
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Layout'
     *       404:
     *         description: User not found
     */
    static async getSduiProfile(req: Request, res: Response) {
        const { uid } = req.params;
        try {
            const user = await UserService.getUserProfile(uid);
            const layout = SduiService.getProfileLayout(user);
            res.json(layout);
        } catch (error: any) {
            res.status(404).json({ error: "User not found" });
        }
    }

    /**
     * @swagger
     * /user/sync/profile:
     *   get:
     *     summary: Get User Profile Data
     *     description: Retrieve user profile details from Firestore.
     *     tags: [Users]
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: query
     *         name: uid
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: User profile object
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UserProfile'
     *       404:
     *         description: User not found
     */
    static async getUserProfile(req: Request, res: Response) {
        const uid = req.query.uid as string;
        if (!uid) return res.status(400).json({ error: "UID required" });
        try {
            const user = await UserService.getUserProfile(uid);
            res.json(user);
        } catch (error: any) {
            res.status(404).json({ error: "User not found" });
        }
    }

    /**
     * @swagger
     * /user/stations/add:
     *   post:
     *     summary: Add Station Subscription
     *     description: Add a single station subscription for a user.
     *     tags: [Users]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               uid: { type: string }
     *               station: { $ref: '#/components/schemas/SubscribedStation' }
     *     responses:
     *       200:
     *         description: Station added successfully
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UserProfile'
     */
    static async addStation(req: Request, res: Response) {
        const { uid, station } = req.body;
        try {
            const profile = await UserService.addStation(uid, station as SubscribedStation);
            res.json(profile);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * @swagger
     * /user/stations/delete:
     *   post:
     *     summary: Delete Station Subscription
     *     description: Delete a specific station subscription for a user.
     *     tags: [Users]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               uid:
     *                 type: string
     *               stationId:
     *                 type: string
     *               lineId:
     *                 type: string
     *     responses:
     *       200:
     *         description: Station deleted successfully
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/UserProfile'
     */
    static async deleteStation(req: Request, res: Response) {
        const { uid, stationId, lineId } = req.body;
        try {
            const profile = await UserService.removeStation(uid, stationId, lineId);
            res.json(profile);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * @swagger
     * /user/logout:
     *   post:
     *     summary: Logout User
     *     description: Mark the user as logged out system-side.
     *     tags: [Users]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               uid:
     *                 type: string
     *     responses:
     *       200:
     *         description: User logged out successfully
     *       400:
     *         description: UID required
     */
    static async deleteAccount(req: Request, res: Response) {
        const { uid } = req.body;
        if (!uid) {
            return res.status(400).json({ error: "UID required" });
        }
        try {
            const result = await UserService.deleteAccount(uid);
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    static async logOut(req: Request, res: Response) {
        const { uid, deviceId } = req.body;
        if (!uid) {
            return res.status(400).json({ error: "UID required" });
        }
        try {
            const result = await UserService.logOut(
                uid,
                typeof deviceId === 'string' && deviceId ? deviceId : undefined
            );
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * @swagger
     * /user/fcm/register:
     *   post:
     *     summary: Register an FCM token for the authenticated user
     *     description: |
     *       Idempotently registers a device's FCM registration token under the
     *       user's profile. Required for `uid`-targeted admin notifications.
     *       The client calls this on every cold launch and whenever FCM
     *       rotates the token (onNewToken). Same token from same user is a
     *       cheap no-op refresh.
     *     tags: [Users]
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [token]
     *             properties:
     *               token:      { type: string, description: FCM registration token }
     *               platform:   { type: string, enum: [android, ios, web] }
     *               appVersion: { type: string }
     *     responses:
     *       200: { description: Registered }
     *       400: { description: Missing token }
     *       401: { description: Auth required }
     */
    static async registerFcmToken(req: Request, res: Response) {
        // UID comes from the validated Firebase ID token (set by
        // AuthMiddleware.validateUserToken), NOT the request body —
        // never trust a self-asserted UID for a write to that user's
        // own collection.
        const uid = (req as any).user?.uid as string | undefined;
        const { token, platform, appVersion } = req.body ?? {};

        if (!uid) return res.status(401).json({ error: 'Unauthorized' });
        if (!token || typeof token !== 'string') {
            return res.status(400).json({ error: 'Missing token' });
        }

        try {
            // Normalised rather than forwarded verbatim. Both fields are
            // optional on the wire and land in a Firestore write, which rejects
            // `undefined` outright — so a request that merely omitted
            // `appVersion` 500'd on a path whose entire contract is "cheap
            // idempotent no-op". `platform` is narrowed to the values the schema
            // documents so an unexpected string cannot quietly become a category
            // in the admin breakdown.
            await UserFcmTokenService.register(uid, token, {
                platform: platform === 'android' || platform === 'ios' || platform === 'web'
                    ? platform
                    : undefined,
                appVersion: typeof appVersion === 'string' ? appVersion : undefined,
            });
            return res.json({ success: true });
        } catch (error: any) {
            return res.status(500).json({ error: error?.message ?? 'Register failed' });
        }
    }

    /**
     * @swagger
     * /user/fcm/unregister:
     *   post:
     *     summary: Unregister an FCM token for the authenticated user
     *     description: Removes the given FCM token from the user's registry. Called on logout.
     *     tags: [Users]
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [token]
     *             properties:
     *               token: { type: string }
     *     responses:
     *       200: { description: Unregistered (or already absent) }
     */
    static async unregisterFcmToken(req: Request, res: Response) {
        const uid = (req as any).user?.uid as string | undefined;
        const { token } = req.body ?? {};
        if (!uid) return res.status(401).json({ error: 'Unauthorized' });
        if (!token) return res.status(400).json({ error: 'Missing token' });
        try {
            await UserFcmTokenService.unregister(uid, token);
            return res.json({ success: true });
        } catch (error: any) {
            return res.status(500).json({ error: error?.message ?? 'Unregister failed' });
        }
    }
}
