import { db } from '../config/firebase';
import { UserService } from './userService';
import { UserDeviceService } from './userDeviceService';
import { UserWatchIndex } from './userWatchIndex';
import { SubscriptionService } from './subscriptionService';

/**
 * The two nightly maintenance jobs the session design has been asking for
 * since April: an abandoned-session sweep and a subscription-count
 * reconciliation.
 *
 * ## Why these exist at all
 * Everything else in the session lifecycle is exact-at-the-moment and
 * best-effort afterwards. The registry updates that follow a login or logout
 * run in a post-transaction `setImmediate`, so a process restart between the
 * commit and the callback loses one — and every failure mode was deliberately
 * pointed at OVER-counting, because over-counting merely polls a station
 * nobody needs while under-counting takes a live station away from someone who
 * does. That asymmetry is only safe while something eventually repairs it.
 * Nothing did. These two are that something.
 *
 * ## They are not symmetric, and it matters
 * [sweep] acts entirely through `UserService.endSession`, an existing,
 * transactional, regression-tested function, over a narrow query. It can be
 * slow, and it can miss a candidate until tomorrow, but it cannot corrupt
 * anything.
 *
 * [reconcile] compares a snapshot taken over a whole collection scan against a
 * document every other write path is concurrently mutating. A naive version of
 * it can actively CAUSE the silent, un-alerting outage the registry design
 * exists to prevent. That is a difference in kind rather than degree, and it is
 * why the guard in `SubscriptionService.reconcileCounts` is not optional and
 * why this file settles Pass 1's own writes before stamping its baseline.
 *
 * ## Orchestration only
 * This service owns no storage. It reads `users` to choose candidates and
 * otherwise delegates every mutation to the service that owns the document
 * being mutated — which is why neither the "reset result flags on every
 * transaction attempt" rule nor the "field paths plus FieldValue.delete() at
 * zero" rule appears in [sweep] at all: they are satisfied by the functions it
 * calls, not re-implemented here. The single exception is the false→true heal
 * in [reconcile], a bare per-document `.update()` that needs nothing from
 * either service.
 */
/**
 * Whether the reconcile may act on a `loggedIn: true` account it believes has no
 * live devices.
 *
 * OFF during the storage cutover, and the asymmetry is the point: the
 * false→true direction writes a flag and releases nothing, while true→false
 * signs every device out and drops the account's subscription holds. Against a
 * young backfill that turns a missing row into a real sign-out rather than
 * repairing anything.
 *
 * The preconditions for turning it on, which are per-ENVIRONMENT and not global:
 *   - `check_device_backfill.cjs` PASS — 0 missing rows, 0 token losses
 *   - the legacy stores DELETED, so there is no stale source left to ratify
 *   - the root `devices` collection reads 0, so no collection-group query can
 *     mistake a retired row for a live session
 *   - sign-in, sign-out and the account switch verified on a real device
 *
 * Account deletion is the one verify-list item that does NOT gate this, because
 * deletion removes the account outright and never leaves a `loggedIn: true`
 * document for this heal to act on.
 *
 * ## History, and why this is `false` again
 * ENABLED 2026-08-25 once staging met all four. Turned back OFF 2026-09-01 for
 * the production cutover, where **none** of them hold: production has no
 * `users/{uid}/devices` subcollection at all yet, so `liveByUid` returns false
 * for every account and this heal would release the entire platform in one
 * night — silently, exit 0, `loggedIn` being a server flag no client reads.
 *
 * ⚠️ This is a compile-time constant with NO env override, so the value in the
 * branch is the value production runs and it cannot be changed from the box.
 * It must stay `false` until the legacy stores are actually gone.
 * Re-enable at task G2 of `docs/PROD_CUTOVER_PLAN.md`, not before.
 *
 * Note this gates the RECONCILE only. `sweep` performs the same release and is
 * gated by nothing but the crontab not being installed — see plan task F3.
 */
export const HEAL_TRUE_TO_FALSE = false;

/**
 * Whether [sweep] may release an account it believes has no live device rows.
 *
 * OFF. The job's release is correct; the CLOCK it releases against is not yet
 * measuring what the job's own comment says it measures.
 *
 * `isRowLive` tests `lastSeen`, which is refreshed (at most once a day, see
 * `UserService.SESSION_REFRESH_MS`) only by `startSession` — whose one live
 * caller is `POST /user/sync/profile`. The shipped Android build calls that on
 * EXPLICIT SIGN-IN ONLY, never at launch. So on the fleet we actually have,
 * `lastSeen` records the last time a user signed in, not the last time they
 * opened the app, and the 90-day predicate reads "has not signed in for 90
 * days" — which a daily user who signed in once satisfies.
 *
 * Releasing them is silent and does not self-heal: `loggedIn` is a server flag
 * no client reads, so nobody is signed out and nothing looks wrong, while their
 * stations leave `metadata/subscribed_stations` (the Syncer stops polling, the
 * board goes stale, and Android only re-syncs on an explicit sign-in) and
 * `fcm_tokens` is purged on the last device out (push dies, and Android's
 * `FcmTokenRegistrar` short-circuits on a SharedPreferences watermark nothing
 * server-side can clear).
 *
 * ## Why gate it here rather than just leaving it out of the crontab
 * Not installing a cron line is a fact about one box that no reader of this
 * file can see, and `run_maintenance.cjs` and the `/internal` route both reach
 * this function without cron. A compile-time constant is the same mechanism
 * [HEAL_TRUE_TO_FALSE] already uses for the same class of danger, and it makes
 * the value in the branch the value every environment runs.
 *
 * ## What has to be true before this comes back
 *   - `lastSeen` is refreshed by app USE, not only by sign-in — either the
 *     client calls `syncProfile` at cold start, or a cheap touch endpoint
 *     exists. Re-confirm the Android call site in `StationlyUI` at that point
 *     rather than trusting this comment.
 *   - a sweep dry run on production names accounts you can explain one by one.
 *
 * Nothing else in the maintenance pair depends on this. `reconcile` keeps
 * running and keeps doing the repair that motivated the crons — the registry
 * drift a lost post-transaction write leaves behind (104 keys against a correct
 * 13, on staging). Without [sweep] the registry merely keeps over-counting
 * abandoned accounts, which is the direction the whole design deliberately
 * errs in: over-counting polls a station nobody needs, under-counting takes a
 * live station from someone who does.
 */
export const SWEEP_ENABLED = false;

export class SessionMaintenanceService {

    /**
     * Job 3 — rebuild the `user_watch` push-audience index from Firestore.
     *
     * ## Why this is an in-process job and not a script
     * The index lives in the HOST's `data/stationly.sqlite`, which the running
     * server holds open. A second process writing it fights that one for the
     * database lock, and `UserWatchIndex` swallows its own failures by design —
     * so a `SQLITE_BUSY` would look exactly like a successful run that indexed
     * nothing. Driving it through the server means one writer, and the same
     * loopback-guarded route the other two jobs already use.
     *
     * ## Why a rebuild is needed at all
     * The index maintains itself on every CONTENT write, so any account that
     * edits a board keeps itself current. An account that never edits again
     * would never appear — and it still wants disruption pushes. This seeds
     * every account once, and afterwards is only needed if the mirror is lost.
     *
     * Idempotent: `replaceForUid` deletes and rewrites one account at a time.
     * Losing this table costs a rebuild and never data — every row is derived.
     */
    static async reindexWatch(): Promise<{
        usersScanned: number;
        accountsIndexed: number;
        stationRows: number;
        lineRows: number;
        tableSize: number;
        durationMs: number;
    }> {
        const startedAt = Date.now();
        const snap = await this.collection.get();
        let accountsIndexed = 0, stationRows = 0, lineRows = 0;

        for (const doc of snap.docs) {
            const data = doc.data() ?? {};
            // The SAME derivation the live write path uses — a second
            // implementation here would drift from the thing it seeds.
            const stations = UserService.effectiveStationIds(data);
            const lines = UserService.effectiveLineIds(data);
            if (stations.length === 0 && lines.length === 0) {
                await UserWatchIndex.forget(doc.id);
                continue;
            }
            await UserWatchIndex.replaceForUid(doc.id, stations, lines);
            accountsIndexed++;
            stationRows += stations.length;
            lineRows += lines.length;
        }

        const result = {
            usersScanned: snap.size,
            accountsIndexed,
            stationRows,
            lineRows,
            tableSize: await UserWatchIndex.size(),
            durationMs: Date.now() - startedAt,
        };
        console.log(`MAINTENANCE: 🔎 watch index rebuilt — ${JSON.stringify(result)}`);
        return result;
    }

    private static readonly collection = db.collection('users');

    /**
     * Live-device answers for many accounts, read in parallel batches.
     *
     * ## Why this exists rather than a read inside each loop
     * Both jobs need "does this account still have a live device row", and both
     * used to ask one account at a time. That is not merely linear COST — each
     * read is a Firestore round trip, so it is linear LATENCY, and a nightly job
     * over a real fleet would spend almost all of its wall clock waiting rather
     * than working. `sweep` already batched its teardown calls this way; the
     * reads that decide who gets torn down were the half still going one at a
     * time, in both jobs.
     *
     * Batched rather than one big `Promise.all`: an unbounded fan-out over every
     * account on the platform is how a maintenance job turns into a self-inflicted
     * quota incident at 3am. [BATCH_SIZE] is the same bound the teardown uses.
     *
     * Returns a Map so callers keep their own iteration order — the tally in
     * [reconcile] depends on visiting users in the order it read them.
     */
    private static async liveByUid(uids: string[]): Promise<Map<string, boolean>> {
        const out = new Map<string, boolean>();
        for (let i = 0; i < uids.length; i += this.BATCH_SIZE) {
            const batch = uids.slice(i, i + this.BATCH_SIZE);
            const snaps = await Promise.all(
                batch.map(uid => UserDeviceService.devices(uid).get().then(s => ({ uid, s }))),
            );
            for (const { uid, s } of snaps) {
                out.set(uid, s.docs.some(d => UserDeviceService.isRowLive(d.data())));
            }
        }
        return out;
    }

    /** Candidates are processed in fixed batches, parallel within, sequential across. */
    private static readonly BATCH_SIZE = 20;

    /**
     * Milliseconds to let Pass 1's own registry writes land before stamping the
     * race baseline. Those writes are `setImmediate`-deferred single-document
     * transactions, not slow ones; this only has to outlast the deferral.
     */
    private static readonly SETTLE_MS = 2000;

    /**
     * Job 1 — release sessions on accounts that stopped coming back.
     *
     * The lazy prune inside `startSession`/`endSession` already handles a
     * partially stale account, but it only ever fires on that account's OWN
     * next write. An account whose every device was uninstalled never writes
     * again, so its subscription holds are pinned forever. That account is this
     * job's entire reason to exist, which is why the predicate is **all**
     * sessions stale rather than any: an account with one live device is
     * somebody's working phone, and the lazy path already covers its dead
     * siblings.
     */
    static async sweep(): Promise<{
        scanned: number;
        released: string[];
        alreadyClean: number;
        errors: number;
        durationMs: number;
    }> {
        const startedAt = Date.now();
        const released: string[] = [];
        let alreadyClean = 0;
        let errors = 0;

        // See [SWEEP_ENABLED]. Returns the normal shape with an empty
        // `released` rather than throwing: the crontab wrapper logs whatever
        // comes back, and a disabled job that reports a clean run is easier to
        // read at 3am than one that reports a failure.
        if (!SWEEP_ENABLED) {
            console.log('MAINTENANCE: 🧹 sweep SKIPPED — SWEEP_ENABLED is off');
            return { scanned: 0, released, alreadyClean: 0, errors: 0, durationMs: 0 };
        }

        // `.select()` is a bandwidth economy, not a read-cost one — Firestore
        // bills per document matched however few fields come back. It spares
        // the response every account's `boards` array, which this job never
        // looks at.
        // `.select()` with no fields fetches document ids only — the devices now
        // live in a subcollection, so there is nothing on the parent worth
        // pulling and this keeps the scan cheap.
        const snap = await this.collection.where('loggedIn', '==', true).select().get();
        const scanned = snap.size;

        // ⚠️ READS THE SUBCOLLECTION, not the old `sessions` map.
        //
        // This had to move in the same change that stopped WRITING the map. Left
        // pointing at `users.sessions`, every account's entries would go stale
        // within the TTL and this job would release the subscription holds of
        // every ACTIVE user on the platform — silently, at 3am, one account at a
        // time. The map is not deleted yet, so nothing would have errored.
        const live = await this.liveByUid(snap.docs.map(d => d.id));

        const candidates: string[] = [];
        for (const doc of snap.docs) {
            if (live.get(doc.id)) alreadyClean++;
            else candidates.push(doc.id);
        }

        for (let i = 0; i < candidates.length; i += this.BATCH_SIZE) {
            const batch = candidates.slice(i, i + this.BATCH_SIZE);
            const results = await Promise.allSettled(
                // No deviceId — that overload already means "sign out
                // everywhere", and it is one of the paths already covered by
                // the session regression tests. This job writes no transaction
                // of its own.
                batch.map(uid => UserService.endSession(uid)),
            );
            results.forEach((r, n) => {
                if (r.status === 'fulfilled') {
                    released.push(batch[n]);
                } else {
                    errors++;
                    // Logged with its uid and swallowed: one bad account must
                    // not abort a scan whose whole value is completeness.
                    console.error(`MAINTENANCE: ❌ sweep failed for ${batch[n]}:`, r.reason);
                }
            });
        }

        const durationMs = Date.now() - startedAt;
        console.log(
            `MAINTENANCE: 🧹 sweep scanned=${scanned} released=${released.length} ` +
            `clean=${alreadyClean} errors=${errors} in ${durationMs}ms`,
        );
        return { scanned, released, alreadyClean, errors, durationMs };
    }

    /**
     * Job 2 — heal `loggedIn`, rebuild the subscription counts from source, and
     * repair the `user_watch` audience index.
     *
     * Two passes, and they cannot be one transaction: Firestore caps a
     * transaction at 500 writes and bounds its lifetime, and reading every user
     * document plus writing every correction inside one would risk both on any
     * fleet larger than staging's.
     *
     * ## Why the watch index repair lives here rather than on its own schedule
     * Pass 1 already reads every user document and already derives
     * `effectiveStationIds` for the tally, so the marginal cost of also deriving
     * the lines and writing a handful of SQLite rows is close to nothing —
     * whereas a third crontab line is a third thing to install, prove and
     * remember. [reindexWatch] stays as a route for a cold seed after a
     * migration; both delegate to the same `replaceForUid`, so they cannot
     * drift apart.
     */
    static async reconcile(): Promise<{
        usersScanned: number;
        loggedInHealed: string[];
        countsChanged: number;
        countsDeleted: number;
        registrySkippedDueToRace: boolean;
        watchAccountsIndexed: number;
        durationMs: number;
    }> {
        const startedAt = Date.now();
        const loggedInHealed: string[] = [];
        const target: Record<string, number> = {};
        let watchAccountsIndexed = 0;

        // ── Pass 1: per-user heal, and the tally ──
        const snap = await this.collection
            .select('loggedIn', 'stations', 'boards')
            .get();

        // One batched pass for every account's liveness, rather than a round trip
        // per user inside the loop below. Same helper the sweep uses.
        const live = await this.liveByUid(snap.docs.map(d => d.id));

        for (const doc of snap.docs) {
            const data = doc.data() as Record<string, any>;
            // Subcollection, for the same reason as the sweep above.
            const hasLive = live.get(doc.id) === true;
            const stored = data.loggedIn === true;

            if (stored !== hasLive) {
                loggedInHealed.push(doc.id);
                console.warn(`MAINTENANCE: 🔧 loggedIn drift on ${doc.id}: ${stored} → ${hasLive}`);
                try {
                    if (hasLive) {
                        // false → true. This should essentially never happen:
                        // every write path that touches `sessions` sets
                        // `loggedIn` in the same update, so this direction
                        // implies a manual edit or a bug not yet found. Nothing
                        // needs releasing, and Pass 2's ordinary diff restores
                        // this account's contribution once the tally below
                        // counts it — so a bare flag write is the whole fix.
                        await this.collection.doc(doc.id).update({ loggedIn: true });
                    } else if (!HEAL_TRUE_TO_FALSE) {
                        // Kept as a switch rather than deleted: this is the one
                        // branch that RELEASES an account, so a future migration
                        // that reshapes device storage again will want to turn it
                        // off for exactly the same reason.
                        //
                        // This direction RELEASES an account: it signs every
                        // device out and drops the subscription holds. While the
                        // device backfill is young that is not a repair, it is a
                        // RATIFICATION — an account whose rows did not backfill
                        // correctly looks signed-out to this job, and the job
                        // then makes it so. At 3am. Silently. One account at a
                        // time.
                        //
                        // Flip [HEAL_TRUE_TO_FALSE] once P2c's full verify list
                        // has passed (sign in, sign out, account switch AND
                        // delete) and `check_device_backfill.cjs` reports zero
                        // missing rows.
                        console.warn(
                            `MAINTENANCE: ⏭️  loggedIn true→false heal SKIPPED for ${doc.id} ` +
                            `(HEAL_TRUE_TO_FALSE is off — see sessionMaintenanceService)`,
                        );
                    } else {
                        // true → false. NOT a bare flag write. Flipping the flag
                        // alone would leave the account accurate on paper while
                        // its FCM tokens and device-registry row still sit in a
                        // push audience it has left — the precise defect that
                        // put a signed-out phone in its old account's audience
                        // before. endSession does the complete release, and
                        // re-reads inside its own transaction, so a genuine
                        // concurrent sign-in racing this heal is decided at
                        // commit time rather than against Pass 1's stale read.
                        await UserService.endSession(doc.id);
                    }
                } catch (e) {
                    console.error(`MAINTENANCE: ❌ loggedIn heal failed for ${doc.id}:`, e);
                }
            }

            // The tally uses the HEALED value, never the stored flag. Counting
            // off `data.loggedIn` here would make this run contradict the
            // correction it just made, in the same pass.
            const stations = UserService.effectiveStationIds(data);
            if (hasLive) {
                for (const id of stations) {
                    target[id] = (target[id] || 0) + 1;
                }
            }

            // ── The watch index gets its nightly repair here, and it needs one ──
            //
            // `user_revs` can heal itself: a miss means "ask the master", and
            // `UserRevLedger.refreshFromMaster` does. `user_watch` has no such
            // path and cannot have one — an EMPTY table is indistinguishable from
            // "nobody watches this line", so a lost or half-written index resolves
            // a disruption audience to zero devices and the notifier logs nothing
            // at all (it only speaks when `devicesTargeted > 0`). The entire
            // disruption feature would be dead, silently, until every account
            // happened to edit a board.
            //
            // The live write path maintains it on every content write, so this is
            // a repair rather than the mechanism. It rides along because this loop
            // has ALREADY paid for the document and already computes
            // `effectiveStationIds` for the tally above — the marginal cost is one
            // `effectiveLineIds` call and a few SQLite rows per account.
            //
            // `reindexWatch()` remains as a standalone route for a cold seed after
            // a migration, and this makes it something you no longer have to
            // remember to run. Both delegate to the same `replaceForUid`, so
            // neither can drift from the other.
            //
            // Indexes EVERY account, signed in or not, exactly as `reindexWatch`
            // does. A signed-out account has no device rows, so it resolves to an
            // empty audience naturally — filtering here would only mean a signed-in
            // account that this pass raced was dropped from its own audience.
            const lines = UserService.effectiveLineIds(data);
            if (stations.length === 0 && lines.length === 0) {
                await UserWatchIndex.forget(doc.id);
            } else {
                await UserWatchIndex.replaceForUid(doc.id, stations, lines);
                watchAccountsIndexed++;
            }
        }

        // ── Pass 2: the registry diff ──
        // Let Pass 1's own registry writes land first. They are deferred by a
        // `setImmediate` inside endSession, so without this wait they would
        // arrive AFTER the baseline below and be misread as an external race,
        // making the job skip its own work every time it did any.
        await new Promise(resolve => setTimeout(resolve, this.SETTLE_MS));

        const guardBaseline = Date.now();
        const { changed, deleted, skippedDueToRace } =
            await SubscriptionService.reconcileCounts(target, guardBaseline);

        const durationMs = Date.now() - startedAt;
        console.log(
            `MAINTENANCE: 📊 reconcile users=${snap.size} healed=${loggedInHealed.length} ` +
            `changed=${changed} deleted=${deleted} raced=${skippedDueToRace} ` +
            `watch=${watchAccountsIndexed} in ${durationMs}ms`,
        );
        return {
            usersScanned: snap.size,
            loggedInHealed,
            countsChanged: changed,
            countsDeleted: deleted,
            registrySkippedDueToRace: skippedDueToRace,
            watchAccountsIndexed,
            durationMs,
        };
    }

}
