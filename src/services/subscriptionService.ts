import * as admin from 'firebase-admin';
import { db } from '../config/firebase';
import { LocalDbService } from '../services/localDbService';
import { nowMs } from '../utils/timestamps';

const FieldValue = admin.firestore.FieldValue;

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
     *
     * ## A station could never LEAVE the registry, and nothing said so
     * This used to rebuild the whole `stationCounts` map, `delete` the key when
     * its count hit zero, and write the result with `set(..., { merge: true })`.
     * Merge performs a DEEP merge of map fields — it unions keys — so a key
     * absent from the payload is preserved, not removed. The delete was
     * therefore invisible to Firestore and the station stayed subscribed at its
     * last count, forever.
     *
     * Measured on staging: adding a board for `940GZZLUVIC` took the registry
     * 99 → 100; removing that board left it at 100 with `count: 1` still
     * stored, through repeated polls.
     *
     * The consequence is quiet and only ever costs money — the Syncer keeps
     * polling TfL for stations nobody watches, and the registry grows
     * monotonically for the life of the deployment. Nothing breaks on screen,
     * which is why it survived: the failure looks exactly like a popular
     * station somebody else still tracks.
     *
     * The fix writes a single FIELD PATH rather than the whole map, using
     * `FieldValue.delete()` for the removal — the one construct merge honours
     * as "remove this". Writing one key also means two concurrent updates for
     * DIFFERENT stations no longer carry each other's data.
     *
     * Naptan ids are alphanumeric, so they are safe to interpolate into a
     * dotted field path; a key containing a dot would need `FieldPath`.
     */
    private static async updateCount(naptanId: string, delta: number) {
        try {
            await db.runTransaction(async (transaction) => {
                const doc = await transaction.get(this.registryRef);
                const counts = (doc.exists ? doc.data()?.stationCounts : {}) || {};
                const newCount = (counts[naptanId] || 0) + delta;

                // No document yet: `update` would throw, and there is nothing to
                // decrement anyway.
                if (!doc.exists) {
                    if (newCount > 0) {
                        transaction.set(this.registryRef, {
                            stationCounts: { [naptanId]: newCount },
                            lastUpdatedTime: nowMs(),
                        });
                    }
                    return;
                }

                transaction.update(this.registryRef, {
                    // Floors at removal rather than storing a zero or a negative:
                    // the listener treats presence as "subscribed", so a key at 0
                    // would keep the station polled just as effectively as a 1.
                    [`stationCounts.${naptanId}`]:
                        newCount <= 0 ? FieldValue.delete() : newCount,
                    lastUpdatedTime: nowMs(),
                });
            });
        } catch (e) {
            console.error(`SUBSCRIPTION: ❌ Transaction failed for ${naptanId}:`, e);
        }
    }
}
