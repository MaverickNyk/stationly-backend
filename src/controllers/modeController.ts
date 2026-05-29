import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatModeLabel, getIconUrl } from '../utils/formatters';
import { TransportMode } from '../models';
import { DataCacheService } from '../services/dataCacheService';

import { EXEMPT_MODES, DISPLAY_NAME_MAP, capitalize } from '../utils/tflUtils';

/**
 * Canonical TfL mode tint colours. Returned alongside iconUrl so the
 * Android client doesn't have to maintain a parallel hardcoded ModeColors
 * mapping. When `tintHex` is null the client falls back to its baked-in
 * default (brand amber).
 */
const MODE_TINT: Record<string, string> = {
    'tube':              '#DC241F',
    'overground':        '#EE7C0E',
    'dlr':               '#00A4A7',
    'elizabeth':         '#6950A1',
    'elizabeth-line':    '#6950A1',
    'bus':               '#DC241F',
    'tram':              '#84B817',
    'national-rail':     '#1D3E89',
    'national_rail':     '#1D3E89',
    'river-bus':         '#1D3E89',
    'river_bus':         '#1D3E89',
    'cable-car':         '#E21836',
    'cable_car':         '#E21836',
};

/**
 * Version stamp for the mode-icon asset bundle. Bump this whenever the
 * icons change so the client knows to invalidate its on-disk cache and
 * re-download. Bumping is cheap (one constant) — no need to wait for an
 * app release.
 */
const MODE_ICON_VERSION = '1';

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

            // Always apply runtime SDUI formatting. Each mode carries:
            //   - id / label / displayName for the dropdown picker
            //   - iconUrl       — full URL to the per-mode roundel asset
            //   - tintHex       — fallback tint when icon hasn't downloaded
            //                     yet (matches the asset's brand colour)
            //   - iconVersion   — bumps when icons change; client
            //                     invalidates its on-disk cache on mismatch
            const formattedModes = modes.map(m => ({
                ...m,
                displayName: DISPLAY_NAME_MAP[m.modeName] || m.displayName || capitalize(m.modeName),
                id: m.modeName,
                label: formatModeLabel(m.modeName),
                iconUrl: getIconUrl(m.modeName),
                tintHex: MODE_TINT[m.modeName?.toLowerCase()] || null,
                iconVersion: MODE_ICON_VERSION,
            }));

            return res.json(formattedModes);
        } catch (error) {
            console.error("Error fetching modes:", error);
            const fallback = {
                modeName: "tube",
                displayName: "Tube",
                id: "tube",
                label: "Underground",
                iconUrl: getIconUrl("tube"),
                tintHex: MODE_TINT["tube"],
                iconVersion: MODE_ICON_VERSION,
            };
            return res.status(500).json([fallback]);
        }
    }
}
