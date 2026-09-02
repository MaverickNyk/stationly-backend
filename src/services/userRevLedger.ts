import { db } from '../config/firebase';
import { LocalDbService } from './localDbService';

/**
 * The SQLite mirror of `users/{uid}.stateRev`.
 *
 * ## What it is for
 * `stateRev` is the integer that lets a client ask "has anything on my account
 * changed?" without anyone reading Firestore. Before it existed, every app open
 * past the client's two-minute debounce cost one read of `users/{uid}` — about
 * twenty a day per user, to answer "no" almost every time. This table is what
 * makes the answer free.
 *
 * It is the house replication pattern applied to one more row: Firestore is the
 * master, SQLite is the slave, and the watermark is an integer
 * (`REPLICATION.md`). No listener is needed, because **every** write to the user
 * document flows through this backend — the §2 invariant of
 * `DESIGN_SESSIONS_AND_SYNC.md` — so this process always knows when the master
 * moved. It just has to go and look.
 *
 * ## The one rule
 * **Only ever write a value that was read out of the master.** Never a value a
 * write path computed for itself.
 *
 * That rule costs one Firestore read per content write, and it is not
 * negotiable. The tempting alternative — mirror `(the value we just read) + 1`
 * and spend no read at all — is wrong in a way that will never show up in
 * testing:
 *
 *   Devices A and B both write. Both read `stateRev = N`. Both increment, so
 *   Firestore correctly reaches N+2 — but both compute N+1 for the ledger, so
 *   the ledger holds N+1, a value that no longer describes the document.
 *   Meanwhile device C reads the profile in the sliver between the two
 *   increments, genuinely sees N+1, and stores it as its `localRev`. C's next
 *   rev check compares N+1 against N+1, decides nothing changed, and never
 *   learns about B's write.
 *
 * The failure is silent, it is in the very mechanism whose job is to detect
 * staleness, and it heals only when some unrelated write happens to push the
 * ledger past N+1. A read per write, off the request path, buys that away.
 *
 * ## Where the reads come from
 * Two callers, both of which have a document in their hands already or are
 * willing to pay for one:
 *
 *   - [refreshFromMaster], from the `setImmediate` that already fires the push
 *     after a content write. One read per write, never on the request path.
 *   - [observe], from `getUserProfile`, which has just read the document for
 *     its own reasons. Free, and it means any client fetch repairs the ledger.
 *
 * ## Nothing here ever throws
 * Every method swallows its own failures and degrades to the next-best answer:
 * [get] returns null (fall through to the master), [observe] does nothing,
 * [refreshFromMaster] returns 0. That is a deliberate boundary, not laziness.
 *
 * This is a CACHE in front of the master. Every caller is either a
 * fire-and-forget `setImmediate` after a write — where a rejection is an
 * unhandled promise that can take a pm2 worker down, the exact hazard the P0
 * routes were wrapped for — or the rev endpoint, whose worst honest answer is
 * "0", which a client reads as "nothing newer than you have" and acts on by
 * fetching. A SQLite hiccup must cost a redundant Firestore read, never a 500
 * on the most frequent authenticated call in the app.
 *
 * ## Monotonic on purpose
 * [observe] never walks the watermark backwards. Two refreshes racing after two
 * near-simultaneous writes can arrive out of order, and the older one must not
 * undo the newer. This is the same conditional upsert as
 * [LocalDbService.updateLastSyncTime], for the same reason.
 */
export class UserRevLedger {

    /**
     * The mirrored rev, or null if this process has never seen this account.
     *
     * Null is not an error and not "rev 0" — it is "ask the master". A cold
     * process, a new `pm2 reload`, or a user whose first request of the day is a
     * rev check will all land here exactly once.
     */
    static async get(uid: string): Promise<number | null> {
        try {
            const row = await LocalDbService.get<{ rev: number }>(
                'SELECT rev FROM user_revs WHERE uid = ?',
                [uid],
            );
            if (!row || row.rev == null) return null;
            const rev = Number(row.rev);
            return Number.isFinite(rev) ? rev : null;
        } catch (err) {
            // A missing table on a box deployed before this shipped, a locked
            // database, a corrupt file. All of them mean the same thing to the
            // caller — "the cache cannot answer" — and all of them are correctly
            // handled by going to the master instead of failing the request.
            console.warn(`USER_REV: ⚠️ ledger read failed for ${uid}, falling back to master`, err);
            return null;
        }
    }

    /**
     * Record a rev that was READ FROM THE MASTER. Monotonic — a lower value is
     * ignored rather than written.
     *
     * The `WHERE` on the upsert is what makes it monotonic. Without it, a
     * refresh that was issued first but completed second would overwrite a newer
     * value, and the ledger would under-report until the next write.
     */
    static async observe(uid: string, rev: number): Promise<void> {
        if (!uid || !Number.isFinite(rev) || rev < 0) return;
        try {
            await LocalDbService.run(
                `INSERT INTO user_revs (uid, rev) VALUES (?, ?)
                 ON CONFLICT(uid) DO UPDATE SET rev = excluded.rev
                 WHERE excluded.rev > user_revs.rev`,
                [uid, Math.floor(rev)],
            );
        } catch (err) {
            // Callers reach this from a hot read path and from post-write
            // callbacks, several of them fire-and-forget. A failure costs one
            // cold rev check later; a rejection would be an unhandled promise.
            console.warn(`USER_REV: ⚠️ ledger write failed for ${uid}`, err);
        }
    }

    /**
     * Read the master, mirror what it says, and hand it back.
     *
     * This is the one place that spends a Firestore read on the rev, and it is
     * called from the post-write `setImmediate` rather than from the request, so
     * a user's edit never waits on it and a failure here can never fail their
     * write.
     *
     * A missing document returns 0 rather than throwing: the account was deleted
     * between the write and this callback, there is nothing to mirror, and the
     * push that follows will be a `deleted` signal anyway.
     */
    static async refreshFromMaster(uid: string): Promise<number> {
        try {
            const doc = await db.collection('users').doc(uid).get();
            const rev = doc.exists ? Number(doc.data()?.stateRev ?? 0) : 0;
            const clean = Number.isFinite(rev) ? rev : 0;
            await this.observe(uid, clean);
            return clean;
        } catch (err) {
            console.error(`USER_REV: ❌ refresh failed for ${uid}`, err);
            // Zero, not a throw. Every caller is either a fire-and-forget push
            // callback or a rev endpoint whose worst honest answer is "0", which
            // a client reads as "no newer than what you have" and simply does not
            // act on. Failing the caller would be worse than answering stale.
            return 0;
        }
    }

    /**
     * The rev to serve a client: the ledger if it has one, the master otherwise.
     *
     * This is the whole read budget in one function. A warm ledger answers with
     * **zero** Firestore reads, which is the overwhelmingly common case; a cold
     * one pays a single read and is warm from then on.
     */
    static async resolve(uid: string): Promise<number> {
        const cached = await this.get(uid);
        if (cached != null) return cached;
        return this.refreshFromMaster(uid);
    }

    /**
     * Forget an account. Called on deletion so a recreated uid cannot inherit a
     * watermark that would suppress its first real fetch.
     */
    static async forget(uid: string): Promise<void> {
        try {
            await LocalDbService.run('DELETE FROM user_revs WHERE uid = ?', [uid]);
        } catch (err) {
            // The ledger is a cache; losing this delete costs a stale row that
            // only matters if the uid is ever reused.
            console.warn(`USER_REV: ⚠️ ledger delete failed for ${uid}`, err);
        }
    }
}
