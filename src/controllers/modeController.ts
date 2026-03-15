import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatModeLabel, getIconUrl } from '../utils/formatters';
import { TransportMode } from '../models';

import { EXEMPT_MODES, DISPLAY_NAME_MAP, capitalize } from '../utils/tflUtils';

export class ModeController {
    /**
     * @swagger
     * /modes:
     *   get:
     *     summary: Get Transport Modes
     *     description: Retrieves all supported transport modes. Uses Firestore cache first, fallbacks to TfL API.
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
            const snapshot = await db.collection('modes').get();
            let modes: (TransportMode & { id?: string; label?: string; iconUrl?: string | null })[] = [];

            snapshot.forEach(doc => {
                modes.push(doc.data() as any);
            });

            // Cache Miss: Fallback to TfL API
            if (modes.length === 0) {
                console.log("DATA: ⚪ Firestore MISS for modes. Fetching from TfL...");
                const rawModes = await TflApiClient.getTransportModes();

                // Map strictly to Java's TransportMode model with SDUI extras
                modes = rawModes
                    .filter(m => m.isTflService)
                    .filter(m => !EXEMPT_MODES.has(m.modeName))
                    .map(m => ({
                        modeName: m.modeName,
                        displayName: DISPLAY_NAME_MAP[m.modeName] || capitalize(m.modeName),
                        id: m.modeName,
                        label: formatModeLabel(m.modeName),
                        iconUrl: getIconUrl(m.modeName)
                    }));

                const batch = db.batch();
                modes.forEach(mode => {
                    const docRef = db.collection('modes').doc(mode.modeName);
                    batch.set(docRef, mode);
                });
                await batch.commit();
                console.log("DATA: ✅ Fallback saved to Firestore");
            } else {
                console.log("DATA: 🟢 Firestore HIT for modes");
                modes = modes.map(m => ({
                    ...m,
                    displayName: DISPLAY_NAME_MAP[m.modeName] || m.displayName || capitalize(m.modeName),
                    id: m.modeName || m.id,
                    label: m.label || formatModeLabel(m.modeName),
                    iconUrl: getIconUrl(m.modeName)
                }));
            }

            return res.json(modes);
        } catch (error) {
            console.error("Error fetching modes:", error);
            const fallback: TransportMode & { id?: string; label?: string; iconUrl?: string | null } = {
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
