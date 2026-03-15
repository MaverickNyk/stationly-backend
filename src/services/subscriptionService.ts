import { db } from '../config/firebase';

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
     * This keeps an in-memory Set updated at zero additional read cost after initial load.
     */
    static initializeListener() {
        console.log("SUBSCRIPTION: 📡 Initializing Subscribed Stations listener...");
        this.registryRef.onSnapshot((doc) => {
            if (doc.exists) {
                const data = doc.data();
                const counts = data?.stationCounts || {};
                this.subscribedIds = new Set(Object.keys(counts));
                console.log(`SUBSCRIPTION: 🔄 Sync complete. Subscribed stations: ${this.subscribedIds.size}`);
            } else {
                this.subscribedIds = new Set();
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
