import { Request, Response } from 'express';
import { UserService, SubscribedStation } from '../services/userService';
import { SduiService } from '../services/sduiService';
import { UserFcmTokenService } from '../services/userFcmTokenService';

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
        const { uid, email, displayName, photoURL, signInProvider, ...other } = req.body;

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
                emailVerified
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
        const { uid, stations } = req.body;

        if (!uid || !stations) {
            return res.status(400).json({ error: "UID and Stations list required" });
        }

        try {
            const result = await UserService.syncStations(uid, stations as SubscribedStation[]);
            res.json(result);
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
        const { uid } = req.body;
        if (!uid) {
            return res.status(400).json({ error: "UID required" });
        }
        try {
            const result = await UserService.logOut(uid);
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
            await UserFcmTokenService.register(uid, token, { platform, appVersion });
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
