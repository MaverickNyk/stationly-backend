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

    /**
     * Rewrite the registry to match a freshly recomputed target.
     *
     * The safety net under every ref-count hazard in the system. Each failure
     * mode in [incrementSubscription]/[decrementSubscription] errs toward
     * OVER-counting, which is the safe direction only because nothing repairs
     * it; this makes "never over-decrement" a property that heals itself
     * rather than one maintained by hand across four call sites.
     *
     * Lives here, beside [updateCount], rather than in the maintenance service
     * that calls it: this document's read/write shape has one owner, and a
     * second file reaching into [registryRef] would be exactly the pattern the
     * session redesign keeps deleting.
     *
     * ## The race this guards, which is worse than the drift it fixes
     * `target` is a snapshot computed over the wall-clock span of a full
     * `users` scan, while this document is written by every ordinary login,
     * logout and board edit. Diffing a stale snapshot against a live value can
     * UNDO a legitimate concurrent increment — a user who signed in mid-scan
     * gets their brand-new entry deleted by a run that began before they
     * existed in the target. That is not drift that self-heals tomorrow; it is
     * this job CAUSING a fresh silent-empty-board outage of exactly the kind
     * the registry exists to prevent, which is strictly worse than doing
     * nothing.
     *
     * So: the caller settles its own writes first and stamps `guardBaseline`
     * immediately before calling. If the document moved after that instant,
     * somebody else wrote it during the scan, the snapshot is stale, and this
     * writes NOTHING and reports why. The correction is not urgent — it waits
     * for tomorrow rather than paying a second full collection scan to shave a
     * day off a non-urgent repair.
     */
    static async reconcileCounts(
        target: Record<string, number>,
        guardBaseline: number,
    ): Promise<{ changed: number; deleted: number; skippedDueToRace: boolean }> {
        let changed = 0;
        let deleted = 0;
        let skippedDueToRace = false;

        await db.runTransaction(async (transaction) => {
            // Reset on EVERY attempt. Firestore re-runs this callback on
            // contention, and a tally inherited from a losing attempt would be
            // reported as fact. This is new transaction code rather than a
            // delegation, so the rule has to be applied here explicitly.
            changed = 0;
            deleted = 0;
            skippedDueToRace = false;

            const doc = await transaction.get(this.registryRef);
            const current = (doc.exists ? doc.data()?.stationCounts : {}) || {};
            const currentStamp = doc.exists ? (doc.data()?.lastUpdatedTime || 0) : 0;

            if (currentStamp > guardBaseline) {
                skippedDueToRace = true;
                console.warn(
                    'SUBSCRIPTION: ⏭️  reconcile skipped — registry moved during the scan ' +
                    `(stamp ${currentStamp} > baseline ${guardBaseline}). Retrying tomorrow.`,
                );
                return;
            }

            // An empty target against a non-empty registry is far more likely a
            // failed or partial scan than a genuine "nobody subscribes to
            // anything". Draining the whole registry on that basis would stop
            // the Syncer polling every station in the system, silently. Refuse.
            if (Object.keys(target).length === 0 && Object.keys(current).length > 0) {
                console.error(
                    'SUBSCRIPTION: ⚠️  reconcile target is EMPTY against a non-empty ' +
                    'registry — refusing to write. This is a scan failure, not a result.',
                );
                return;
            }

            const updates: Record<string, unknown> = {};
            for (const naptanId of new Set([...Object.keys(current), ...Object.keys(target)])) {
                const have = current[naptanId] || 0;
                const want = target[naptanId] || 0;
                if (have === want) continue;

                // Field paths and FieldValue.delete() at zero — a set(merge)
                // deep-merges maps and ignores absent keys, so a removal
                // expressed by omission simply vanishes. Already bitten once.
                updates[`stationCounts.${naptanId}`] = want <= 0 ? FieldValue.delete() : want;
                want <= 0 ? deleted++ : changed++;

                // Loudly: drift is a bug signal, not dirt to sweep quietly.
                console.warn(
                    `SUBSCRIPTION: 🔧 reconcile ${naptanId}: ${have} → ${want <= 0 ? 'removed' : want}`,
                );
            }

            if (Object.keys(updates).length === 0) return;
            updates.lastUpdatedTime = nowMs();

            // Mirrors updateCount's branch: .update() throws NOT_FOUND against a
            // document that does not exist yet.
            if (doc.exists) transaction.update(this.registryRef, updates);
            else transaction.set(this.registryRef, { stationCounts: target, lastUpdatedTime: nowMs() });
        });

        return { changed, deleted, skippedDueToRace };
    }
}
