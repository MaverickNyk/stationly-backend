import { LocalDbService } from './localDbService';

/**
 * "Which accounts watch this station or line?" — answered from SQLite, at zero
 * Firestore reads.
 *
 * ## Why this exists
 * The disruption push needs an audience: every device watching the line that
 * just went down. Until now the device row carried `stations[]` and `lines[]`
 * arrays and the query was one `array-contains-any` over the root collection.
 *
 * §3.1 of the design took those arrays off the row, and the reason is worth
 * restating because it is the whole argument for this file. The field was NAMED
 * like device data and HELD account data: the value came from the directory of
 * every station the *account* tracks, rebuilt from its synced boards. So it was
 * a derived copy, written once per device, maintained by a different path from
 * the thing it derived from. That is the drift bug this redesign exists to
 * remove — and it had a running cost too, because a single board edit
 * eventually rewrote the device row on EVERY one of that user's devices.
 *
 * The index still has to exist. It just belongs somewhere that re-derives
 * rather than duplicates, and the backend is the only writer of the boards it
 * comes from (§2's invariant), so a SQLite mirror is exactly correct — the same
 * Firestore-master/SQLite-slave pattern as `REPLICATION.md` and `user_revs`.
 *
 * ## The two hops
 *   1. here: line/station → uids                    (SQLite, 0 Firestore reads)
 *   2. `users/{uid}/devices`                        (a read on a known path)
 *
 * Not a regression on cost: billing is per document RETURNED, and the same
 * device documents come back either way. What it removes is the reason the
 * device row carried account data at all.
 *
 * ## Rebuildable by construction
 * Every row here is derived from `users/{uid}`, so losing this table costs a
 * rebuild and never data. `backfill_user_watch.cjs` rebuilds it from Firestore,
 * and the nightly reconcile could be extended to heal it if drift ever shows up.
 */
export class UserWatchIndex {

    /**
     * Replace everything recorded for one account, atomically.
     *
     * Delete-then-insert rather than a diff: the input is the complete truth for
     * this uid, the row counts are tiny (a handful of stations and lines), and a
     * diff would need to be right about removals — which is the direction that
     * fails silently, by leaving an account in an audience it no longer belongs
     * to and pushing them disruptions for a line they stopped watching.
     */
    static async replaceForUid(uid: string, stations: string[], lines: string[]): Promise<void> {
        if (!uid) return;
        try {
            // ⚠️ IN A TRANSACTION, and the word "atomically" above is why.
            //
            // DELETE-then-INSERT is only a replace if nothing can observe the
            // gap. Unwrapped, a failure after the DELETE — and `pm2 start -i max`
            // means several workers share this one file, so SQLITE_BUSY is a real
            // outcome, not a theoretical one — leaves the account with NO rows at
            // all. That reads as "this account watches nothing", which is
            // indistinguishable from the truth and fails in the silent direction:
            // no disruption push, no error, no way to tell.
            await LocalDbService.inTransaction(async () => {
                await LocalDbService.run('DELETE FROM user_watch WHERE uid = ?', [uid]);
                const rows: Array<[string, string]> = [
                    ...new Set(stations.filter(Boolean)),
                ].map(id => ['station', id] as [string, string]);
                for (const id of new Set(lines.filter(Boolean))) rows.push(['line', id.toLowerCase()]);

                for (const [kind, id] of rows) {
                    await LocalDbService.run(
                        'INSERT OR REPLACE INTO user_watch (uid, kind, id) VALUES (?, ?, ?)',
                        [uid, kind, id],
                    );
                }
            });
        } catch (err) {
            // A cache, like `user_revs`. A failure costs a stale audience until
            // the account's next content write, and this is called from
            // fire-and-forget post-write callbacks where a rejection would be an
            // unhandled promise.
            console.warn(`USER_WATCH: ⚠️ index update failed for ${uid}`, err);
        }
    }

    /** Forget an account. Called on deletion. */
    static async forget(uid: string): Promise<void> {
        try {
            await LocalDbService.run('DELETE FROM user_watch WHERE uid = ?', [uid]);
        } catch (err) {
            console.warn(`USER_WATCH: ⚠️ index delete failed for ${uid}`, err);
        }
    }

    /**
     * The accounts watching any of these ids.
     *
     * Returns an empty array on failure rather than throwing. That is the safe
     * direction HERE and it is worth being explicit about why: an empty audience
     * means a disruption push is not sent, which is a missed notification. The
     * alternative — throwing — would abort the trigger for every OTHER line in
     * the same pass. One quiet line beats a broken sweep.
     */
    private static async uidsFor(kind: 'station' | 'line', ids: string[]): Promise<string[]> {
        const clean = [...new Set(ids.filter(Boolean).map(i => (kind === 'line' ? i.toLowerCase() : i)))];
        if (clean.length === 0) return [];
        try {
            const out = new Set<string>();
            // Chunked because SQLite caps host parameters (999 by default) and a
            // broadcast over every line would otherwise fail at the driver.
            for (let i = 0; i < clean.length; i += 500) {
                const chunk = clean.slice(i, i + 500);
                const placeholders = chunk.map(() => '?').join(',');
                const rows = await LocalDbService.all<{ uid: string }>(
                    `SELECT DISTINCT uid FROM user_watch WHERE kind = ? AND id IN (${placeholders})`,
                    [kind, ...chunk],
                );
                rows.forEach(r => out.add(r.uid));
            }
            return [...out];
        } catch (err) {
            console.warn(`USER_WATCH: ⚠️ lookup failed for ${kind}`, err);
            return [];
        }
    }

    static uidsForStations(ids: string[]): Promise<string[]> { return this.uidsFor('station', ids); }
    static uidsForLines(ids: string[]): Promise<string[]> { return this.uidsFor('line', ids); }

    /** Row count, for probes and the backfill's verification. */
    static async size(): Promise<number> {
        try {
            const r = await LocalDbService.get<{ n: number }>('SELECT COUNT(*) AS n FROM user_watch');
            return r?.n ?? 0;
        } catch { return 0; }
    }
}
