import { db } from '../config/firebase';
import { LocalDbService } from '../services/localDbService';

/**
 * SubscriptionService handles the global tracking of stations that users are subscribed to.
 * It maintains a single document in Firestore for high-efficiency syncing.
 */
export class SubscriptionService {
    private static registryRef = db.collection('metadata').doc('subscribed_stations');
    private static subscribedIds: Set<string> = new Set();
    private static isReady = false;

    /**
     * Initializes a real-time listener for the subscribed stations document.
     * Persisted to SQLite for zero-failure boot.
     */
    static async initializeListener() {
        if (this.isReady) return;

        console.log("SUBSCRIPTION: 📡 Initializing Subscribed Stations listener...");

        // 1. Load from SQLite first
        try {
            const registry = await LocalDbService.all<{ naptanId: string }>('SELECT naptanId FROM subscribed_stations');
            this.subscribedIds = new Set(registry.map(r => r.naptanId));
            console.log(`SUBSCRIPTION: 📁 Loaded ${this.subscribedIds.size} stations from SQLite.`);
        } catch (err) {
            console.error("SUBSCRIPTION: ❌ Failed to load from SQLite", err);
        }

        // 2. Setup Firestore listener
        this.registryRef.onSnapshot(async (doc) => {
            if (doc.exists) {
                const data = doc.data();
                const counts = data?.stationCounts || {};
                const newIds = Object.keys(counts);
                
                this.subscribedIds = new Set(newIds);

                // Update SQLite
                for (const naptanId of newIds) {
                    await LocalDbService.updateSubscribedStation(naptanId, counts[naptanId]);
                }

                // Cleanup stations that are no longer subscribed
                const currentNaptans = await LocalDbService.all<{ naptanId: string }>('SELECT naptanId FROM subscribed_stations');
                for (const row of currentNaptans) {
                    if (!(row.naptanId in counts)) {
                        await LocalDbService.updateSubscribedStation(row.naptanId, 0);
                    }
                }

                console.log(`SUBSCRIPTION: 🔄 Sync complete. Subscribed stations: ${this.subscribedIds.size}`);
            } else {
                this.subscribedIds = new Set();
                await LocalDbService.run('DELETE FROM subscribed_stations');
                console.log("SUBSCRIPTION: 🔄 Document missing, subscribed list cleared.");
            }
            this.isReady = true;
        }, (err) => {
            console.error("SUBSCRIPTION: ❌ Listener failed:", err);
        });
    }

    /**
     * Returns the current list of subscribed Naptan IDs from memory.
     */
    static getSubscribedStationIds(): string[] {
        return Array.from(this.subscribedIds);
    }

    /**
     * Checks if the initial sync from Firestore has completed.
     */
    static getIsReady(): boolean {
        return this.isReady;
    }

    /**
     * Increments the user count for a specific station.
     */
    static async incrementSubscription(naptanId: string) {
        await this.updateCount(naptanId, 1);
    }

    /**
     * Decrements the user count for a specific station.
     */
    static async decrementSubscription(naptanId: string) {
        await this.updateCount(naptanId, -1);
    }

    /**
     * Internal helper for atomic map updates.
     */
    private static async updateCount(naptanId: string, delta: number) {
        try {
            await db.runTransaction(async (transaction) => {
                const doc = await transaction.get(this.registryRef);
                const data = doc.exists ? doc.data() : { stationCounts: {} };
                const counts = data?.stationCounts || {};
                
                let currentCount = counts[naptanId] || 0;
                let newCount = currentCount + delta;
                
                if (newCount <= 0) {
                    delete counts[naptanId];
                } else {
                    counts[naptanId] = newCount;
                }
                
                transaction.set(this.registryRef, { 
                    stationCounts: counts, 
                    lastUpdated: new Date().toISOString() 
                }, { merge: true });
            });
        } catch (e) {
            console.error(`SUBSCRIPTION: ❌ Transaction failed for ${naptanId}:`, e);
        }
    }
}
