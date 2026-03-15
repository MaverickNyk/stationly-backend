import { Request, Response } from 'express';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { formatDestination } from '../utils/formatters';
import { LineInfo, LineRouteResponse, LineStatusResponse } from '../models';

import { GOOD_SERVICE_MESSAGES } from '../utils/tflUtils';

function assignGoodServiceReason(statusSeverityDescription: string, currentReason?: string): string {
    if (statusSeverityDescription?.toLowerCase() === 'good service' && (!currentReason || currentReason.trim() === '')) {
        const index = Math.floor(Math.random() * GOOD_SERVICE_MESSAGES.length);
        return GOOD_SERVICE_MESSAGES[index];
    }
    return currentReason || '';
}

export class LineController {
    /**
     * @swagger
     * /lines/mode/{mode}:
     *   get:
     *     summary: Get Lines by Mode
     *     description: Retrieves all lines for a specific transport mode.
     *     tags: [Lines]
     *     parameters:
     *       - in: path
     *         name: mode
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: A list of lines for the given mode.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/LineInfo'
     */
    static async getLinesByMode(req: Request, res: Response) {
        try {
            const mode = req.params.mode;
            const snapshot = await db.collection('lines').where('modeName', '==', mode).get();
            let lines: (LineInfo & { label?: string })[] = [];
            
            snapshot.forEach(doc => {
                lines.push(doc.data() as any);
            });

            // Cache Miss: Fallback to TfL API
            if (lines.length === 0) {
                console.log(`DATA: ⚪ Firestore MISS for lines (mode: ${mode}). Fetching from TfL...`);
                const rawLines = await TflApiClient.getLinesByMode(mode);
                
                lines = rawLines.map(l => ({
                    id: l.id,
                    name: l.name,
                    modeName: l.modeName,
                    label: l.name // SDUI mapping
                }));

                const batch = db.batch();
                lines.forEach(line => {
                    const docRef = db.collection('lines').doc(line.id);
                    batch.set(docRef, line);
                });
                await batch.commit();
                console.log("DATA: ✅ Fallback lines saved to Firestore");
            } else {
                console.log(`DATA: 🟢 Firestore HIT for lines (mode: ${mode})`);
                lines = lines.map(l => ({
                    ...l,
                    label: l.label || l.name,
                }));
            }

            lines.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
            return res.json(lines);
        } catch (error) {
            console.error(`Error fetching lines for mode ${req.params.mode}:`, error);
            return res.status(500).json([{ id: "piccadilly", label: "Piccadilly", name: "Piccadilly" }]);
        }
    }

    /**
     * @swagger
     * /lines/{lineId}/route:
     *   get:
     *     summary: Get Line Route
     *     description: Retrieves the ordered route of stations for a specific line, including branches.
     *     tags: [Lines]
     *     parameters:
     *       - in: path
     *         name: lineId
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: A list of directions and destinations for the line.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: object
     *                 properties:
     *                   id: { type: string, example: inbound }
     *                   label: { type: string, example: "Inbound towards\nCockfosters" }
     *       404:
     *         description: Route not found
     */
    static async getLineRoute(req: Request, res: Response) {
        try {
            const lineId = req.params.lineId;
            const doc = await db.collection('routes').doc(lineId).get();
            let routeData: LineRouteResponse | null = null;

            if (doc.exists) {
                console.log(`DATA: 🟢 Firestore HIT for route (lineId: ${lineId})`);
                routeData = doc.data() as LineRouteResponse;
            } else {
                console.log(`DATA: ⚪ Firestore MISS for route (lineId: ${lineId}). Fetching from TfL...`);
                try {
                    const rawRoute = await TflApiClient.getLineRoute(lineId);
                    
                    if (rawRoute && rawRoute.routeSections) {
                        const groupedDirections: { [key: string]: Set<{id: string, name: string}> } = {};
                        
                        rawRoute.routeSections.forEach((section: any) => {
                            const direction = section.direction;
                            const destinationName = section.destinationName;
                            const destinationId = section.destination;
                            
                            if (direction && destinationName && destinationId) {
                                if (!groupedDirections[direction]) {
                                    groupedDirections[direction] = new Set();
                                }
                                
                                groupedDirections[direction].add(JSON.stringify({
                                    id: destinationId,
                                    name: destinationName
                                }) as any);
                            }
                        });

                        const directions = Object.keys(groupedDirections).map(dirKey => ({
                            direction: dirKey,
                            destinations: Array.from(groupedDirections[dirKey]).map(s => JSON.parse(s as any))
                        }));

                        routeData = {
                            id: rawRoute.id,
                            name: rawRoute.name,
                            modeName: rawRoute.modeName,
                            directions: directions
                        };

                        await db.collection('routes').doc(lineId).set(routeData);
                        console.log("DATA: ✅ Fallback route saved to Firestore");
                    }
                } catch (apiError) {
                    console.error("TfL API Route Fallback failed", apiError);
                }
            }

            if (!routeData) {
                 return res.json([{ id: "inbound", label: "Inbound" }, { id: "outbound", label: "Outbound" }]);
            }

            // Map the routeData for SDUI so it receives a flat array of formatted directions natively
            const sduiMappedDirections = (routeData.directions || []).map((dir: any) => {
                const dirName = dir.direction ? (dir.direction.charAt(0).toUpperCase() + dir.direction.slice(1)) : '';
                let label = `${dirName} towards`;
                if (dir.destinations && dir.destinations.length > 0) {
                    const destNames = dir.destinations.map((d: any) => formatDestination(d.name)).join('\n');
                    label = `${dirName} towards\n${destNames}`;
                }
                return {
                    id: dir.direction,
                    label: label
                };
            });

            return res.json(sduiMappedDirections);
        } catch (error) {
            console.error(`Error fetching line route for lineId ${req.params.lineId}:`, error);
            return res.status(500).json([{ id: "inbound", label: "Inbound" }, { id: "outbound", label: "Outbound" }]);
        }
    }

    /**
     * @swagger
     * /lines/status:
     *   get:
     *     summary: Get line statuses
     *     description: Retrieves the latest status for all TFL transport lines. Supports filtering by lineId and mode.
     *     tags: [Lines]
     *     parameters:
     *       - in: query
     *         name: lineId
     *         schema:
     *           type: string
     *       - in: query
     *         name: mode
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: A list of line statuses.
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/LineStatus'
     */
    static async getLineStatuses(req: Request, res: Response) {
        try {
            const { lineId, mode } = req.query;
            let query: any = db.collection('lineStatuses');
            
            if (mode) {
                query = query.where('mode', '==', mode);
            }
            if (lineId) {
                query = query.where('id', '==', lineId);
            }
            
            const snapshot = await query.get();
            const statuses: any[] = [];
            snapshot.forEach((doc: any) => {
                const data = doc.data();
                
                // Emulate Java logic for UI presentation
                data.reason = assignGoodServiceReason(data.statusSeverityDescription, data.reason);
                
                statuses.push(data);
            });
            return res.json(statuses);
        } catch (error) {
            console.error("Error fetching line statuses:", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }
}
