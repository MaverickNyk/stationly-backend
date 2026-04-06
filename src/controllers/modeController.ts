import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatModeLabel, getIconUrl } from '../utils/formatters';
import { TransportMode } from '../models';
import { DataCacheService } from '../services/dataCacheService';

import { EXEMPT_MODES, DISPLAY_NAME_MAP, capitalize } from '../utils/tflUtils';

export class ModeController {
    /**
     * @swagger
     * /modes:
     *   get:
     *     summary: Get Transport Modes
     *     description: Retrieves all supported transport modes. Served from in-memory cache (backed by local SQLite). Falls back to Firestore, then TfL API on cold start.
     *     tags: [Modes]
     *     responses:
     *       200:
     *         description: A list of transport modes.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/TransportMode'
     */
    static async getModes(req: Request, res: Response) {
        try {
            let modes = DataCacheService.getAllModes();

            // Cache Miss or not yet ready: Fallback to TfL API logic (original)
            if (modes.length === 0) {
                console.log("CACHE: ⚪ In-memory MISS for modes. Checking Firestore...");
                const snapshot = await db.collection('modes').get();
                snapshot.forEach(doc => modes.push(doc.data() as any));

                if (modes.length === 0) {
                    console.log("DATA: ⚪ Firestore MISS for modes. Fetching from TfL...");
                    const rawModes = await TflApiClient.getTransportModes();
                    modes = rawModes
                        .filter(m => m.isTflService)
                        .filter(m => !EXEMPT_MODES.has(m.modeName))
                        .map(m => ({
                            modeName: m.modeName,
                            displayName: DISPLAY_NAME_MAP[m.modeName] || capitalize(m.modeName),
                        }));

                    const batch = db.batch();
                    modes.forEach(mode => {
                        const docRef = db.collection('modes').doc(mode.modeName);
                        batch.set(docRef, mode);
                    });
                    await batch.commit();
                }
            }

            // Always apply runtime SDUI formatting
            const formattedModes = modes.map(m => ({
                ...m,
                displayName: DISPLAY_NAME_MAP[m.modeName] || m.displayName || capitalize(m.modeName),
                id: m.modeName,
                label: formatModeLabel(m.modeName),
                iconUrl: getIconUrl(m.modeName)
            }));

            return res.json(formattedModes);
        } catch (error) {
            console.error("Error fetching modes:", error);
            const fallback = {
                modeName: "tube",
                displayName: "Tube",
                id: "tube",
                label: "Underground",
                iconUrl: getIconUrl("tube")
            };
            return res.status(500).json([fallback]);
        }
    }
}
