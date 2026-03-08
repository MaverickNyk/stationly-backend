import { Request, Response } from 'express';
import { UserService, SubscribedStation } from '../services/userService';
import { SduiService } from '../services/sduiService';

export class UserController {

    /**
     * Sync user details from Auth provider to Firestore
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
     * Sync local subscriptions to Firestore
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
     * Get dynamic SDUI Profile screen
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
     * Add a single station subscription
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
     * Delete a single station subscription
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
     * Mark user as logged out
     */
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
