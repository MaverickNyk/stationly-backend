import { Request, Response } from 'express';
import { UserService, SubscribedStation } from '../services/userService';
import { SduiService } from '../services/sduiService';

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

        try {
            const profile = await UserService.createOrUpdateUser(uid, email, {
                displayName,
                photoURL,
                signInProvider,
                ...other
            });
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
}
