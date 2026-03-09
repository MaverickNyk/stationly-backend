import axios from 'axios';
import * as admin from 'firebase-admin';

const TRACKED_STATION_ID = '940GZZLUKSX'; // King's Cross St. Pancras
const TRACKED_LINE = 'piccadilly';

export class LiveUpdateService {
    
    /**
     * Start the background engine to push SDUI updates to FCM
     */
    static start() {
        console.log(`>>> [LIVE ENGINE] Starting SDUI background push for station: ${TRACKED_STATION_ID}`);
        // Run every minute
        setInterval(() => this.run(), 60000);
        // Also run once now
        this.run();
    }

    private static async run() {
        try {
            console.log(`>>> [LIVE ENGINE] Fetching TfL data for ${TRACKED_LINE} at ${TRACKED_STATION_ID}...`);
            const response = await axios.get(`https://api.tfl.gov.uk/Line/${TRACKED_LINE}/Arrivals/${TRACKED_STATION_ID}`);
            const arrivals = response.data;

            // Sort by ETA
            arrivals.sort((a: any, b: any) => a.timeToStation - b.timeToStation);

            // Construct SDUI Visual Layout
            const sduiPayload = {
                id: TRACKED_STATION_ID,
                title: `LIVE: Kings Cross St. Pancras`,
                theme: {
                    primaryColor: "#FF9800", // TfL Amber
                    backgroundColor: "#000000"
                },
                components: [] as any[]
            };

            if (arrivals.length === 0) {
                sduiPayload.components.push({
                    type: "message",
                    text: "No trains currently scheduled.",
                    color: "#666666"
                });
            } else {
                // Group by platform
                const platforms: Record<string, any[]> = {};
                arrivals.slice(0, 10).forEach((train: any) => {
                    const p = train.platformName || "Unknown Platform";
                    if (!platforms[p]) platforms[p] = [];
                    platforms[p].push(train);
                });

                // Construct UI components
                for (const [pName, trains] of Object.entries(platforms)) {
                    sduiPayload.components.push({
                        type: "header",
                        title: `Line: ${TRACKED_LINE.toUpperCase()} - ${pName}`,
                        color: "#FF9800",
                        style: "bold"
                    });

                    trains.slice(0, 3).forEach((train, index) => {
                        const mins = Math.floor(train.timeToStation / 60);
                        const eta = mins < 1 ? "Due" : `${mins} min`;
                        sduiPayload.components.push({
                            type: "row",
                            index: (index + 1).toString(),
                            destination: train.destinationName,
                            eta: eta,
                            etaColor: mins < 3 ? "#FF5252" : "#FF9800",
                            animation: mins < 1 ? "pulse" : null
                        });
                    });
                }
            }

            // Send to FCM Topic
            const topic = `Station_${TRACKED_STATION_ID}`;
            const message = {
                data: {
                    sdui_payload: JSON.stringify(sduiPayload)
                },
                topic: topic
            };

            await admin.messaging().send(message);
            console.log(`>>> [LIVE ENGINE] Pushed live arrivals to topic: ${topic}`);

        } catch (error: any) {
            console.error(`>>> [LIVE ENGINE] Error:`, error.message);
        }
    }
}
