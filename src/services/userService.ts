import admin from 'firebase-admin';
import { db, auth } from '../config/firebase';
import { SubscriptionService } from './subscriptionService';
import { EmailService } from './emailService';
import { UserSyncNotifier, UserSyncReason } from './userSyncNotifier';
import { DeviceLifecycleService } from './deviceLifecycleService';
import { UserRevLedger } from './userRevLedger';
import { UserDeviceService } from './userDeviceService';
import { UserWatchIndex } from './userWatchIndex';

const FieldValue = admin.firestore.FieldValue;

/**
 * Erase the dead `preferences` map, riding on a write that is happening anyway.
 *
 * Client settings — expanded, rows, pin, order, layout — are DEVICE-LOCAL. They
 * change on every touch and are worth nothing to any device but the one they
 * were made on, and the document holding them is the one every login reads, so
 * syncing them spent the write quota on the lowest-value state in the app.
 *
 * The field stopped being written when that decision landed, but existing
 * documents still carry whatever was last stored in it. Folding the delete into
 * the update blocks that already run costs **zero** additional writes and
 * converges every account that is still in use. `FieldValue.delete()` is the one
 * construct that removes a field rather than merging over it.
 */
const DROP_LEGACY_PREFERENCES = { preferences: FieldValue.delete() };

export interface UserProfile {
    uid: string;
    email: string;
    displayName: string;
    photoURL?: string;
    // `address` and `phoneNumber` were declared here and NEVER written or read
    // by any backend path, and no client ever sent them. Removed rather than
    // left: this product does not collect either, and a declared field is an
    // invitation to start. §3.1 of the design.
    //
    // Safe for the frozen APK: its `UserProfileResponse` models `address` as
    // `String? = null`, an OPTIONAL with a default, so an absent key decodes
    // fine. The four fields it cannot survive losing are uid, email,
    // displayName and stations — see the ANDROID CONTRACT tests.
    signInProvider?: string;
    createdAt?: string;
    updatedAt?: string;
    // `loggedIn` now strictly means "≥1 active device session" (derived from
    // `sessions`). Kept because it's queryable (Firestore can't query map
    // emptiness) and gates deleteAccount.
    loggedIn?: boolean;
    // Aggregate "last sign-in on ANY device" — handy top-level field for
    // analytics/queries. Per-device timestamps live inside `sessions`.
    lastLoggedInTime?: string;
    // Active device sessions, keyed by a stable per-install device id. A user is
    // "logged in" while this map is non-empty. Subscription counts increment on
    // the 0→1 transition (first device in) and decrement on 1→0 (last device
    // out) — so 5 devices on one account still contribute exactly +1 to each
    // saved station's count.
    // NO `sessions` map. It moved to `users/{uid}/devices/{deviceId}`, where the
    // row's EXISTENCE is the session — see [UserDeviceService]. Removed from the
    // type rather than merely stopped being written, because a readable
    // superseded store is still a store: while this field was declared and
    // frozen, one login guard went on consulting it and the device row was
    // never recreated after a sign-out. Nothing errored.

    // Authoritative copy of Firebase Auth's email_verified claim, mirrored on every
    // sync so callers can gate on the user doc instead of hitting Admin SDK each time.
    emailVerified?: boolean;
    // True the first time we send the welcome email — prevents duplicates if the user
    // signs in again after verifying. Set together with the welcome email send.
    welcomeSent?: boolean;
    /**
     * LEGACY saved-boards list. **Android's, and only Android's.**
     *
     * Kept exactly as it was. Android writes it through `/user/sync/stations`
     * and reads it back at login, and nothing in the v2 path touches it — see
     * [boards] for why the two had to be separated rather than merged.
     */
    stations: SubscribedStation[];
    /**
     * v2 saved boards — the schema iOS reads and writes. See [SavedBoard].
     *
     * Absent on an account that has only ever used Android. `getUserProfile`
     * derives a value from [stations] in that case, at READ time, so a user's
     * existing board survives their first iOS login without ever writing back
     * over Android's list.
     */
    boards?: SavedBoard[];
    /** Epoch millis of the last accepted [boards] write — the LWW guard. */
    boardsUpdatedAt?: number;
    /**
     * Monotonic counter, bumped by one on every CONTENT write and never on
     * session or device churn.
     *
     * It is the whole of the client's "do I need to refetch?" decision: a client
     * holds the rev it last applied and fetches only when an observed rev
     * exceeds it. That is what takes an app open on an unchanged account from
     * one Firestore read to zero.
     *
     * Bumped with `FieldValue.increment(1)` so it never needs a read-modify-write
     * and is correct under any concurrency. Mirrored into SQLite by
     * [UserRevLedger] — which reads it back rather than guessing it, for reasons
     * that file explains at length.
     *
     * ⚠️ It bumps on CONTENT ONLY. Bumping it on login/logout would wake every
     * one of the user's devices into a fetch that finds nothing changed, on
     * every session event, which is the exact cost this field exists to remove.
     */
    stateRev?: number;
    /**
     * There is deliberately NO `preferences` field.
     *
     * Client settings are device-local — see [DROP_LEGACY_PREFERENCES] for why,
     * and for the sweep that removes it from documents that still carry one.
     * Declaring it here at all invited the next reader to write to it.
     */
}

export interface SubscribedStation {
    id: string; // stationId (naptanId)
    name: string;
    line: string;
    mode: string;
    direction: string;
    /** The hub this board belongs to, so a restore rebuilds one card per stop. */
    parentStationId?: string;
}

/**
 * One saved board, v2 — everything needed to rebuild it exactly.
 *
 * ## Why this exists instead of more fields on [SubscribedStation]
 * The two lists are separate because the CLIENTS disagree about what a list
 * means, not because the shape needed changing.
 *
 * Android is a one-board app: `SelectionViewModel` calls `cleanupAll()` before
 * saving, so setting up a board wipes every other one, and it then posts the
 * whole (now single-element) list to `/user/sync/stations`, which is a full
 * replace. On a shared account that silently deleted every board the user had
 * added on iOS, and iOS's next reconcile removed them locally too. Widening
 * `SubscribedStation` would not have helped: the loss is in the REPLACE, and
 * both platforms writing the same array is what makes the replace lossy.
 *
 * So iOS writes here and Android writes [UserProfile.stations], and the two
 * lists are allowed to disagree until Android moves over. The subscription
 * registry reads the UNION (see `effectiveStationIds`), so a board on either
 * list is polled for departures — that part must NOT be split.
 *
 * ## What v2 carries that v1 could not
 * v1 held only enough to name a board (id, line, mode, direction). Everything
 * that makes it the user's board — the destination filter, the "via" station
 * they picked, the hub the card groups on — lived in device-local SQLite and
 * was lost on logout. Restoring a filtered board as an unfiltered one is a
 * worse failure than not restoring it: the board looks right and shows trains
 * the user deliberately excluded.
 */
export interface SavedBoard {
    /**
     * The hub the user picked — the client's `groupingId`, and the board's
     * identity. Exactly one board per value.
     */
    id: string;
    name: string;
    /** Every departure queue tracked here. Flat: a line level would hold nothing. */
    selections: BoardSelection[];
    /** Epoch millis the board was first saved — drives restore order. */
    addedAt?: number;
}

/**
 * One departure queue on a board — the level at which the fetch naptan and the
 * filter both belong.
 */
export interface BoardSelection {
    /**
     * The RESOLVED naptan departures are fetched from for this exact
     * (line, direction). See [SavedBoard] for why this is not on the board:
     * a bus hub's two directions sit on opposite sides of the road with
     * different ids.
     */
    naptanId: string;
    line: string;
    /**
     * On the SELECTION rather than the board: a hub can genuinely serve more
     * than one mode, and mode is a property of the line in every other model.
     */
    mode?: string;
    direction?: string;
    filter?: BoardFilter;
}

/** How one queue is narrowed — both the user's intent and its resolution. */
export interface BoardFilter {
    /** `ALL` | `DESTINATIONS` | `VIA`. Stored as the name, never an ordinal. */
    mode?: string;
    /** Naptan ids the filter matches on. Filters never match on display name. */
    destinationIds?: string[];
    /** Display names of the chosen destinations, for rendering the filter chip. */
    destinationNames?: string[];
    /**
     * The stops the user asked to travel THROUGH, kept alongside the resolved
     * [destinationIds] they produced. The resolution goes stale when a branch
     * closes; the intent has to survive so it can be re-resolved without asking
     * the user again.
     *
     * Arrays because a junction line gives a genuine multi-choice (both the
     * Heathrow and Uxbridge branches at Acton Town is two downstream sets
     * unioned), and because the client's own SQLite column joins these into a
     * comma-separated string — a lossy encoding for stop names that contain
     * commas, which bus stops routinely do. The wire format does not repeat
     * that mistake. Index-aligned with each other.
     */
    viaIds?: string[];
    viaNames?: string[];
    /**
     * Branch tokens a departure's own `viaKey` must be one of ("bank",
     * "charingcross") — part of the RESOLUTION, re-derived on every re-resolve.
     *
     * Without this a board that says "through Bank" cannot exclude the Charing
     * Cross train, because both report the same destination naptan. See
     * `docs/BRANCH_VIA_KEYS.md`.
     */
    viaKeys?: string[];
    /**
     * Whole services taken from the map's terminus chips, by pattern id
     * ("940GZZLUMDN:bank"), with their display names index-aligned.
     *
     * The INTENT behind a branch pick, kept beside [viaIds] because they answer
     * different questions: a pattern says where a train GOES, a via stop says
     * where it PASSES.
     */
    patternIds?: string[];
    patternNames?: string[];
    /** Epoch millis [destinationIds] was last resolved from route data. */
    resolvedAt?: number;
}

/** Client-supplied device metadata for a session (all optional). */
export interface DeviceInfo {
    platform?: string;    // "android" | "ios" | "web"
    osVersion?: string;   // e.g. "Android 14 (SDK 34)"
    model?: string;       // e.g. "Google Pixel 8"
    appVersion?: string;  // e.g. "1.0-staging"
}

/** A single active device session stored under users/{uid}.sessions[deviceId]. */
export interface DeviceSession extends DeviceInfo {
    firstSeen: string;    // ISO — when this device first started a session
    lastSeen: string;     // ISO — last login/refresh from this device
}

/**
 * Fields `/user/sync/profile` must never write, however they arrive.
 *
 * Each one has its own endpoint with its own guard — an LWW clock for boards, an
 * atomic transaction for sessions, a token check for `emailVerified`. Letting
 * the profile sync set them would route around every one of those.
 *
 * `preferences` stays on this list even though the field no longer exists. It is
 * the guard that stops a client resurrecting device-local settings on the
 * account document by posting them through the profile sync, which is exactly
 * how they would come back.
 */
export const PROTECTED_PROFILE_FIELDS = new Set([
    'uid', 'stations', 'boards', 'boardsUpdatedAt', 'preferences',
    'sessions', 'loggedIn', 'lastLoggedInTime', 'emailVerified', 'welcomeSent',
    'createdAt', 'updatedAt',
    // Not merely "the client has no business setting this": the profile sync
    // spreads unknown body keys straight onto the document, so a client posting
    // `stateRev: 0` would RESET the account's counter. Every device holding a
    // higher localRev would then stop fetching until the counter climbed back
    // past where it had been — a silent, self-inflicted staleness across every
    // device at once.
    'stateRev',
]);

export class UserService {
    private static collection = db.collection('users');

    /**
     * The tail of every content write: mirror the new rev, then tell the other
     * devices, with the rev riding along.
     *
     * Always called inside a `setImmediate`, never awaited by the request. The
     * user's write has already been acknowledged by the time this runs, which is
     * what lets it afford the one Firestore read that keeps the ledger exact
     * ([UserRevLedger] explains why a guessed value is not good enough).
     *
     * Both halves are best-effort by design. A failed refresh answers 0 and a
     * failed push is already swallowed by the notifier — neither can turn a
     * successful edit into a failed request, because there is no request left to
     * fail.
     */
    /**
     * The rev this write is about to produce, from the snapshot it already read.
     *
     * Returned to the WRITER only, never stored in the ledger. Under a
     * concurrent write it undershoots — two writers both reading N both compute
     * N+1 while the truth reaches N+2 — and undershooting is the safe direction:
     * the writer's next rev check sees the (exact) ledger ahead of it and
     * fetches, which is correct, because there genuinely is a change it does not
     * have.
     */
    private static nextRevOf(data: Record<string, any> | undefined): number {
        const current = Number(data?.stateRev ?? 0);
        return (Number.isFinite(current) ? current : 0) + 1;
    }

    /**
     * Re-derive this account's station/line audience index from the master.
     *
     * One document read, and it is the same one `UserRevLedger.refreshFromMaster`
     * takes — so on a busy account this is two reads per content write rather
     * than one. Kept separate rather than threaded through the ledger because
     * the two answer different questions and a combined helper would have to
     * return both, which is how a helper becomes a god function.
     *
     * Best-effort: [UserWatchIndex] swallows its own failures, and a stale index
     * costs a missed or spurious disruption push until the account's next
     * content write — never data.
     */
    private static async refreshWatchIndex(uid: string): Promise<void> {
        try {
            const doc = await this.collection.doc(uid).get();
            if (!doc.exists) { await UserWatchIndex.forget(uid); return; }
            const data = doc.data() ?? {};
            await UserWatchIndex.replaceForUid(
                uid,
                this.effectiveStationIds(data),
                this.effectiveLineIds(data),
            );
        } catch (err) {
            console.warn(`USER_WATCH: ⚠️ refresh failed for ${uid}`, err);
        }
    }

    private static afterContentWrite(
        uid: string,
        reason?: UserSyncReason,
        excludeDeviceId?: string,
    ): void {
        setImmediate(() => {
            void (async () => {
                const rev = await UserRevLedger.refreshFromMaster(uid);
                // Refresh the push-audience index off the SAME document read the
                // rev refresh just paid for. Content changed, so the set of
                // stations and lines this account watches may have changed with
                // it — and this is the only path that maintains it.
                await this.refreshWatchIndex(uid);
                // No reason means "the content changed but nobody needs telling"
                // — the diff-gated profile write that touched something no client
                // redraws for. The ledger still has to learn the new rev, or the
                // next rev check serves a stale one and suppresses a real fetch.
                if (reason) await UserSyncNotifier.notify(uid, reason, { excludeDeviceId, rev });
            })().catch(err => {
                // Belt and braces. Nothing above is supposed to reject —
                // UserRevLedger swallows by contract and the notifier swallows
                // per transport — but this runs detached on a timer with no
                // request to fail, so an escaped rejection would be an unhandled
                // promise. That is the hazard the P0 route handlers were wrapped
                // for, and it can take a pm2 worker down over a push nobody was
                // waiting on.
                console.error(`USER_SYNC: ❌ post-write tail failed for ${uid}`, err);
            });
        });
    }

    /**
     * Does the device row still need what only the LOGIN transaction writes?
     *
     * ## One predicate, because there were two and they drifted the same day
     * `startSession` asks this to decide whether to write the row, and
     * `createOrUpdateUser` asks it to decide whether to run `startSession` at
     * all. They were two separate expressions saying the same thing, and the
     * cost of that showed up immediately: a fix applied to the copy inside the
     * transaction had NO EFFECT, because the copy in the caller short-circuited
     * first and the transaction never ran. Measured on the connected iPhone —
     * the row came back without `firstSeen` or `model` twice in a row, once
     * before the fix and once after it.
     *
     * That is the same shape as the bug the whole redesign exists to remove
     * ("this fact has three implementations, so a fix to one is silently absent
     * from the others"), reproduced in miniature inside a single file.
     *
     * ## Why `firstSeen` is the marker
     * Freshness alone is the wrong question. `/device/register` also writes this
     * row — tokens, environment, `lastSeen` — and now runs at sign-in, so it can
     * CREATE the row before login gets there. A row it made looks perfectly
     * fresh while missing every field only login supplies, and asking "is
     * `lastSeen` recent" answers yes forever, because the path that keeps
     * refreshing it is the one that cannot fill the gaps.
     *
     * This transaction is the only writer of `firstSeen`, so its absence is an
     * exact answer to "has login ever written this row", in one field read.
     *
     * @param row the existing device row, or undefined when there is none
     * @param now epoch ms, passed in so the caller and the transaction agree
     */
    static rowNeedsLoginWrite(row: Record<string, any> | undefined | null, now: number): boolean {
        if (!row) return true;
        if (typeof row.firstSeen !== 'number') return true;   // login has never written it
        const seenAt = typeof row.lastSeen === 'number' ? row.lastSeen : NaN;
        if (Number.isNaN(seenAt)) return true;
        return now - seenAt > this.SESSION_REFRESH_MS;
    }

    // A device idle this long (no login/refresh) is treated as gone and pruned.
    // Matches the FCM-token dormancy threshold. A device logged in but unopened
    // for longer than this loses its session; it re-establishes on next launch.
    private static readonly SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

    /**
     * How stale a session's `lastSeen` may get before a re-open refreshes it.
     *
     * The write-elision in `startSession` exists to kill a per-open heartbeat,
     * and it should — but taken to its conclusion it means `lastSeen` never
     * moves at all, which makes [SESSION_TTL_MS] measure the wrong thing
     * entirely. One write a day per active device is the smallest price that
     * makes "idle for 90 days" true, and it is ~1/50th of what a per-open
     * heartbeat cost.
     */
    private static readonly SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;

    /** See [UserPreferences] — this rides on the doc every login reads. */

    /**
     * Every station id this user holds a subscription on, across BOTH board
     * lists, deduplicated.
     *
     * ## Why the union, and why it is not optional
     * The registry this feeds (`metadata/subscribed_stations`) is what the
     * Syncer polls TfL for. A station absent from it is never fetched, so a
     * board pointing at it renders permanently empty — and the client-side
     * topic subscription still succeeds, which is what makes that failure so
     * quiet: the device listens to a topic nobody publishes to.
     *
     * Splitting the board lists per platform therefore had to NOT split this.
     * A board on either list must keep its station polled, and a station on
     * both must be released only when it leaves both.
     *
     * ## Deduplicated, where the original counted entries
     * The old loops incremented once per board, so three lines tracked at one
     * station contributed +3. That was self-consistent (the decrement loop
     * counted the same way) but it inflates the registry, and it is fragile:
     * `SubscriptionService.updateCount` DELETES a station at count ≤ 0, so a
     * single mismatched decrement cuts off every other user watching it.
     *
     * Deduplicating is also the safe direction to migrate in. A session that
     * was incremented under the old duplicate-counting code and is decremented
     * under this one is decremented FEWER times, which leaves a station polled
     * slightly longer than needed. The reverse — decrementing more times than
     * were incremented — is the one that takes a live station away from other
     * users, and this can never do it.
     */
    static effectiveStationIds(data: Record<string, any> | undefined): string[] {
        const legacy = (data?.stations ?? []) as SubscribedStation[];
        const ids = legacy.map(s => s?.id).filter((id): id is string => !!id);

        // ⚠️ A v2 board's `id` is the HUB, not a naptan anything is fetched
        // from. The ids that must be polled hang off each DIRECTION — on a bus
        // hub they are different poles (Smithwood Close: 490008805N inbound,
        // 490012211N outbound), and the hub id may not be a stop the Syncer can
        // fetch at all. Collecting board.id here instead would leave every bus
        // board silently empty while the client's topic subscription still
        // succeeded.
        const boards = Array.isArray(data?.boards) ? (data!.boards as SavedBoard[]) : [];
        for (const board of boards) {
            for (const selection of board?.selections ?? []) {
                if (selection?.naptanId) ids.push(selection.naptanId);
            }
        }
        return Array.from(new Set(ids));
    }

    /**
     * The lines this account watches, from both board lists.
     *
     * The companion to [effectiveStationIds], and it exists for the same reason:
     * the disruption audience is scoped by line, and after §3.1 took `lines[]`
     * off the device row this is the only place that answer is derived.
     *
     * Lower-cased on the way out. TfL line ids arrive in mixed case across the
     * two lists and a case-sensitive index would silently split one line into
     * two audiences, each getting half the notifications.
     */
    static effectiveLineIds(data: Record<string, any> | undefined): string[] {
        const out = new Set<string>();
        for (const s of (data?.stations ?? []) as SubscribedStation[]) {
            if (s?.line) out.add(String(s.line).toLowerCase());
        }
        const boards = Array.isArray(data?.boards) ? (data!.boards as SavedBoard[]) : [];
        for (const board of boards) {
            for (const selection of board?.selections ?? []) {
                if (selection?.line) out.add(String(selection.line).toLowerCase());
            }
        }
        return [...out];
    }

    /**
     * Apply the subscription-count change between two station sets.
     *
     * One helper rather than a decrement loop and an increment loop at each
     * call site, because the two must always agree on what "one subscription"
     * counts as — see [effectiveStationIds]. Only the symmetric difference is
     * touched: a station present before and after is left completely alone.
     */
    private static applySubscriptionDelta(before: string[], after: string[]): void {
        const had = new Set(before);
        const has = new Set(after);
        const removed = [...had].filter(id => !has.has(id));
        const added = [...has].filter(id => !had.has(id));
        if (removed.length === 0 && added.length === 0) return;
        setImmediate(async () => {
            // Decrements before increments, and each group internally parallel.
            //
            // The two groups are ordered because a station can appear in both
            // when a board is replaced, and releasing before re-acquiring keeps
            // the count from transiently reading higher than the truth. WITHIN a
            // group the ids are distinct by construction (both sides are Sets),
            // so no two operations touch the same registry row and the previous
            // sequential await bought nothing but latency — a user replacing a
            // multi-line board paid one round trip per station, serially, on a
            // path already deferred off the response.
            await Promise.all(removed.map(id => SubscriptionService.decrementSubscription(id)))
                .catch(err => console.error('USER: ⚠️ subscription decrement failed', err));
            await Promise.all(added.map(id => SubscriptionService.incrementSubscription(id)))
                .catch(err => console.error('USER: ⚠️ subscription increment failed', err));
        });
    }

    /**
     * v2 boards for a user who has only ever used Android, derived from their
     * legacy [UserProfile.stations] at READ time.
     *
     * Read-time and never written back, deliberately. Writing would mean the
     * first iOS login mutates the document Android treats as its source of
     * truth, and a v2 write must never be able to reach Android's list — that
     * separation is the entire reason the two lists exist. Deriving on read
     * costs nothing and is idempotent; the moment iOS saves anything, a real
     * `boards` array replaces this and the derivation stops firing.
     *
     * The v2-only fields are simply absent, which decodes to "no filter" — the
     * honest answer, since a v1 record never recorded one.
     */
    private static deriveBoardsFromLegacy(stations: SubscribedStation[]): SavedBoard[] {
        const byHub = new Map<string, SubscribedStation[]>();
        for (const station of stations ?? []) {
            if (!station?.id) continue;
            // Blank parentStationId means "same as id" — the pre-hub encoding.
            const hub = station.parentStationId || station.id;
            const bucket = byHub.get(hub);
            if (bucket) bucket.push(station); else byHub.set(hub, [station]);
        }
        return [...byHub.entries()].map(([hub, rows]) => ({
            id: hub,
            name: rows[0].name ?? '',
            selections: rows.map(row => ({
                // The legacy row's `id` IS the fetch naptan.
                naptanId: row.id,
                line: row.line ?? '',
                mode: row.mode ?? '',
                direction: row.direction ?? '',
                // A legacy record never recorded a filter, and an absent filter
                // decodes to "no filter" — the honest answer rather than a guess.
            })),
            config: {},
            addedAt: 0,
        }));
    }

    // [buildSessionEntry] was deleted here — it built an entry for the
    // `users.sessions` map, which no longer exists. Its merge rules (prefer the
    // incoming DeviceInfo, keep the original firstSeen, stamp lastSeen now) live
    // on inside `startSession`'s row write.

    // [isSessionLive] and [pruneStaleSessions] were deleted here.
    //
    // They answered "is this map entry inside the 90-day TTL?" against ISO
    // strings in `users.sessions`. The merged device row stores epoch ms, so the
    // predicate is `UserDeviceService.isRowLive` — a separate function on
    // purpose: one accepting either shape would have to GUESS, and guessing
    // permissively pins an account's subscription holds open forever.
    //
    // The detached-receiver trap survives the move and still has a test:
    // callers pass the predicate to `.some`/`.filter`, which supply no `this`,
    // so it reads its TTL through the class name.

    /**
     * Register/refresh a device session ATOMICALLY (Firestore transaction so
     * concurrent multi-device logins can't lose a session or double-count).
     * Increments the user's saved-station subscriptions only on the
     * logged-out → logged-in transition. Gating on the stored `loggedIn` flag
     * (not map emptiness) keeps it correct even when stale sessions are pruned.
     */
    static async startSession(uid: string, deviceId: string, deviceInfo?: DeviceInfo): Promise<void> {
        const ref = this.collection.doc(uid);

        let didActivate = false;
        let stationIds: string[] = [];
        /** Accounts this login signed OUT of this device, and their held stations. */
        let deactivated: Array<{ uid: string; stationIds: string[] }> = [];

        await db.runTransaction(async (tx) => {
            // ── Reset on every attempt ──
            //
            // Firestore RETRIES this callback on contention and these live
            // outside it. Only ever setting them to true made a retry inherit
            // the first attempt's answer: attempt 1 reads `loggedIn: false` and
            // sets didActivate; another device wins the race; attempt 2 reads
            // `loggedIn: true` and correctly decides not to activate — but the
            // flag is still true, so BOTH increment and every saved station on
            // the account is counted twice for one logical activation.
            //
            // An inflated count is not self-correcting: `updateCount` releases a
            // station only at 0, so it stays in the registry and the Syncer polls
            // TfL for it forever. Idempotence is Firestore's contract for this
            // callback, not a nicety. `deactivated` is the more dangerous one
            // now — a stale entry decrements an account that is still signed in.
            didActivate = false;
            stationIds = [];
            deactivated = [];

            // ══ ALL READS FIRST ══
            // Firestore forbids a read after a write inside a transaction, and
            // the steal needs to read documents whose identity is only known
            // after the collection-group query returns. So every read is
            // gathered here, before the first write below.
            const doc = await tx.get(ref);
            if (!doc.exists) return;
            const data = doc.data() || {};

            const mineSnap = await tx.get(UserDeviceService.devices(uid));

            // Who else currently holds a session on THIS device?
            //
            // ⚠️ The parent filter is load-bearing. A collection GROUP matches
            // every collection of that name at any depth, INCLUDING the root
            // `devices` collection this design retires. A stale root row read as
            // a live session would make this "steal" a session that does not
            // exist — signing a real user out of a device they are still using.
            // Verified against staging data: the raw query returns the root row
            // alongside the real one.
            const othersSnap = await tx.get(
                db.collectionGroup('devices').where('deviceId', '==', deviceId),
            );
            const victimUids = new Set<string>();
            for (const d of othersSnap.docs) {
                const account = d.ref.parent.parent;
                if (!account) continue;          // a root-collection row, not a session
                if (account.id === uid) continue; // our own row is not a theft
                victimUids.add(account.id);
            }

            // Each victim's document and remaining devices, so the last-out
            // transition can be decided for them inside the same transaction.
            const victims: Array<{ uid: string; data: any; others: string[] }> = [];
            for (const v of victimUids) {
                const vDoc = await tx.get(this.collection.doc(v));
                const vDevs = await tx.get(UserDeviceService.devices(v));
                victims.push({
                    uid: v,
                    data: vDoc.exists ? (vDoc.data() ?? {}) : null,
                    others: vDevs.docs.map(d => d.id).filter(id => id !== deviceId),
                });
            }

            // ══ DECIDE ══
            const ts = new Date().toISOString();
            const now = Date.now();
            const prevLoggedIn = data.loggedIn === true;
            const mine = new Map(mineSnap.docs.map(d => [d.id, d.data()]));
            const existing = mine.get(deviceId);

            // The write-elision survives the move, judged now on the ROW's
            // lastSeen rather than the map entry's. Without it `lastSeen` never
            // advances and the TTL becomes a lie in both directions: a device in
            // daily use for 90 days is pruned as abandoned, and a reinstall ghost
            // looks exactly as fresh as a real device.
            const rowStale = this.rowNeedsLoginWrite(existing, now);

            // Lazy TTL prune, one store over from where it used to live.
            const staleMine = mineSnap.docs
                .filter(d => d.id !== deviceId && !UserDeviceService.isRowLive(d.data()));

            // ══ WRITES ══
            const needUserWrite = !prevLoggedIn || !existing || staleMine.length > 0 || rowStale;
            if (needUserWrite) {
                tx.update(ref, { loggedIn: true, lastLoggedInTime: ts, updatedAt: ts });
            }

            if (rowStale) {
                // MERGE, and never a token field.
                //
                // Only `/device/register` supplies tokens. A login that invented
                // one — or wrote `undefined` into one — would put a token-less
                // phantom into the broadcast audience, which is precisely the
                // trap the old root-collection `bind` was bitten by. The rule
                // survives the move; only its subject narrowed from the row to
                // the tokens on it.
                const row = this.stripUndefined({
                    deviceId,
                    platform: deviceInfo?.platform ?? existing?.platform ?? 'ios',
                    model: deviceInfo?.model ?? existing?.model,
                    osVersion: deviceInfo?.osVersion ?? existing?.osVersion,
                    appVersion: deviceInfo?.appVersion ?? existing?.appVersion,
                    firstSeen: typeof existing?.firstSeen === 'number' ? existing.firstSeen : now,
                    lastSeen: now,
                });
                tx.set(UserDeviceService.devices(uid).doc(deviceId), row, { merge: true });
            }

            for (const d of staleMine) tx.delete(d.ref);

            // ── The steal ──
            //
            // This is the piece the old system lacked entirely. Sign out of A
            // while offline, sign in as B: today A's registry hold and push
            // binding linger until a TTL, or forever. Here the transaction that
            // creates B's row sees A still holds one for the same device,
            // deletes it, and runs A's last-out transition atomically. The
            // abandoned-switch hole closes at its root rather than by a
            // compensating job.
            for (const v of victims) {
                tx.delete(UserDeviceService.devices(v.uid).doc(deviceId));
                if (v.data && v.others.length === 0 && v.data.loggedIn === true) {
                    tx.update(this.collection.doc(v.uid), { loggedIn: false, updatedAt: ts });
                    deactivated.push({ uid: v.uid, stationIds: this.effectiveStationIds(v.data) });
                }
            }

            if (!prevLoggedIn) { didActivate = true; stationIds = this.effectiveStationIds(data); }
        });

        // ══ POST-TRANSACTION — best-effort, cron-healed ══
        // Both board lists, deduplicated: an iOS board and an Android board are
        // equally real subscriptions. See [effectiveStationIds].
        if (didActivate) this.applySubscriptionDelta([], stationIds);
        for (const v of deactivated) {
            console.log(`SESSION: 🔄 stole ${deviceId.slice(0, 8)} from ${v.uid} — last device out`);
            this.applySubscriptionDelta(v.stationIds, []);
        }

        // The legacy FCM store still has to be released for a stolen account:
        // it is keyed by TOKEN and carries no device id, so it cannot be
        // attributed per device and only the last-device-out gate can clear it.
        for (const v of deactivated) {
            setImmediate(() => { void DeviceLifecycleService.release(v.uid, undefined, true); });
        }
    }

    /**
     * End a device session ATOMICALLY. Removes only `deviceId` (or all sessions
     * if omitted — "sign out everywhere"). Decrements the user's saved-station
     * subscriptions only on the logged-in → logged-out transition (last device
     * out). Prunes stale sessions in the same pass.
     *
     * ## The session map was never the whole story
     * This used to be the ONLY thing logout did, which meant a signed-out phone
     * kept its place in the account's push audience in both of the other device
     * stores: `devices/{deviceId}.uid` still named the account, and the FCM
     * token document was still filed under it. So `user.sync` — including
     * `reason=deleted`, which tells a client to tear its session down — went on
     * being delivered to a device whose user had signed out. The intended
     * behaviour has always been that a logged-out device is inactive.
     *
     * ## Now a DELETE, and that reverses the old rule
     * This used to clear a field on a row that survived, because the row
     * outlived the session. It does not any more: **the row IS the session**, a
     * signed-out device receives nothing, and leaving its tokens addressable is
     * the bug rather than the safeguard.
     *
     * Nothing worth keeping is lost. `/device/register` runs on every foreground
     * and on every APNs token callback, so the next sign-in rebuilds the row
     * from the client's own state within a second of the app opening.
     *
     * ## Replay safety comes free from the path
     * This addresses `users/{uid}/devices/{deviceId}` — a path that NAMES the
     * account. If B has since signed in on that device, B's row lives under
     * `users/{B}`, so A's replayed logout cannot see it, let alone delete it;
     * A's own transition already ran, via B's steal in [startSession]. A queued
     * logout can therefore be replayed as often as you like, years late, with no
     * conditional check to get wrong. Under the old shape that was true by
     * construction of a QUERY; here it is true by construction of a PATH, which
     * is both stronger and cheaper to review.
     */
    static async endSession(uid: string, deviceId?: string): Promise<void> {
        const ref = this.collection.doc(uid);
        let didDeactivate = false;
        let stationIds: string[] = [];

        await db.runTransaction(async (tx) => {
            // Reset on every attempt — see [startSession]. This direction is the
            // more dangerous of the two: a retry inheriting a stale
            // `didDeactivate` decrements stations the account still holds, and
            // `updateCount` deletes a station at 0, so it can take a live
            // station away from every OTHER user watching it.
            didDeactivate = false;
            stationIds = [];

            // ── reads ──
            const doc = await tx.get(ref);
            if (!doc.exists) return;
            const data = doc.data() || {};
            const mineSnap = await tx.get(UserDeviceService.devices(uid));

            const ts = new Date().toISOString();
            const prevLoggedIn = data.loggedIn === true;

            // Targets: the named device, or ALL of them for "sign out
            // everywhere". Stale rows go in the same pass, which is the lazy TTL
            // prune one store over from where it used to live.
            const targets = mineSnap.docs.filter(d =>
                (deviceId ? d.id === deviceId : true) || !UserDeviceService.isRowLive(d.data()),
            );
            const remaining = mineSnap.docs.filter(d => !targets.some(t => t.id === d.id));

            // ── writes ──
            for (const d of targets) tx.delete(d.ref);

            const nowLoggedIn = remaining.length > 0;
            // Self-heal included: `loggedIn` true with zero rows deactivates
            // even when this call deleted nothing, which repairs the
            // `loggedIn:true, sessions:{}` artefact the old shape could produce.
            if (prevLoggedIn !== nowLoggedIn) {
                tx.update(ref, { loggedIn: nowLoggedIn, updatedAt: ts });
            }
            if (prevLoggedIn && !nowLoggedIn) {
                didDeactivate = true;
                stationIds = this.effectiveStationIds(data);
            }
        });

        if (didDeactivate) this.applySubscriptionDelta(stationIds, []);

        // Awaited, unlike the subscription delta: the caller is `logOut`, whose
        // 200 the client reads as "this device is signed out everywhere it
        // matters". Returning before the audience is actually updated leaves a
        // window in which the phone that just logged out can still be woken by
        // the account it left.
        //
        // The device ROW is already gone — deleted in the transaction above —
        // so what is left for this call is the legacy `fcm_tokens` store, which
        // is keyed by token, carries no device id, and therefore can only be
        // cleared on the last-device-out gate.
        await DeviceLifecycleService.release(uid, deviceId, didDeactivate);
    }

    /**
     * Remove account documents for [email] whose auth user provably no longer
     * exists, keeping [keepUid].
     *
     * The invariant this restores: **one email, one account.** Firebase Auth
     * enforces it on its side; nothing enforced it on ours, because every read
     * and write here is keyed by uid and no code path ever looked at the email
     * across documents. So an orphan was undetectable by construction.
     *
     * Deliberately conservative — a document is deleted ONLY when
     * `auth.getUser` reports its uid gone. A lookup that fails for any other
     * reason (network, quota) leaves the document alone: the cost of skipping a
     * cleanup is a stale row, and the cost of getting it wrong is somebody's
     * account.
     *
     * Best-effort throughout. This runs on the signup path, and a failure to
     * tidy up must never stop a real user creating their account.
     */
    /**
     * Delete everything hanging off a user document, and the device rows that
     * point at it, so the caller can delete the document itself cleanly.
     *
     * ## Why subcollections need saying out loud
     * Firestore KEEPS subcollections when a parent document is deleted. The
     * parent becomes a "phantom": `get()` reports it does not exist while the
     * console still lists it, greyed, because it is a path with children. So a
     * deleted account leaves a visible husk — and, far worse, a live one:
     * `fcm_tokens` under a phantom still resolves for a uid-targeted send.
     * Measured on staging, `users/UJ3Pgl4PIkgibH5FC7f9tht16Q92` held
     * `fcm_tokens(1)` after its account was deleted.
     *
     * ## Enumerated, never named
     * Listing the collections rather than naming them is the whole point. The
     * original named `activity` explicitly and therefore missed `fcm_tokens`,
     * and the orphan sweep kept that bug for months after `deleteAccount` was
     * fixed — because the fix was applied to a copy rather than to a shared
     * rule. A subcollection added tomorrow is swept by this without anyone
     * remembering it exists.
     *
     * Best-effort throughout: a failure here must not abort a deletion the user
     * asked for and the rest of which has already happened.
     */
    private static async purgeUserSubtree(
        userRef: FirebaseFirestore.DocumentReference,
        uid: string,
    ): Promise<void> {
        try {
            const subcollections = await userRef.listCollections();
            // Sequential across collections, parallel within one: an account has
            // a handful of subcollections and this runs once, so the shape that
            // keeps the write rate predictable is the right one.
            for (const sub of subcollections) {
                const docs = await sub.get();
                await Promise.all(docs.docs.map(d => d.ref.delete().catch(() => { /* raced */ })));
            }
        } catch (err) {
            console.error(`USER: ⚠️ Failed to purge subcollections for ${uid}`, err);
        }
        // The device registry is a ROOT collection, so nothing above reaches it.
        await DeviceLifecycleService.purgeForUid(uid);
    }

    private static async purgeOrphanDocsForEmail(email: string, keepUid: string): Promise<void> {
        if (!email) return;
        try {
            const dupes = await this.collection.where('email', '==', email).get();
            for (const doc of dupes.docs) {
                if (doc.id === keepUid) continue;
                try {
                    await auth.getUser(doc.id);
                    // Still a live auth user. Not ours to remove — log it,
                    // because two live users on one email means the Auth project
                    // is set to allow multiple accounts per email address and
                    // that is a console setting, not something code can fix.
                    console.warn(
                        `USER: ⚠️ ${email} has a SECOND live auth user ${doc.id} — check the ` +
                        `Firebase console's "one account per email address" setting`,
                    );
                } catch (err: any) {
                    if (err?.code !== 'auth/user-not-found') throw err;
                    console.warn(`USER: 🧹 purging orphan doc ${doc.id} for ${email} (no auth user)`);
                    // Everything `deleteAccount` removes, removed the same way —
                    // this leaves behind exactly the account state that one does.
                    //
                    // It previously named `activity` alone, which is the bug
                    // `deleteAccount` was fixed for and this copy was not: an
                    // orphan kept its `fcm_tokens`, so a push token survived
                    // under a uid with no auth user behind it, still resolvable
                    // by a uid-targeted send. Enumerating the subcollections
                    // means a new one is swept by a rule that already exists.
                    await this.purgeUserSubtree(doc.ref, doc.id);
                    await doc.ref.delete();
                }
            }
        } catch (err) {
            console.error(`USER: ⚠️ orphan sweep failed for ${email}`, err);
        }
    }

    static async createOrUpdateUser(
        uid: string,
        email: string,
        data: Partial<UserProfile>,
        emailVerified: boolean = false,
        deviceId?: string,
        deviceInfo?: DeviceInfo
    ) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        const timestamp = new Date().toISOString();

        // Welcome email fires once per user, the moment we observe emailVerified flip
        // to true. For Google signups this happens at first sync (Google emails are
        // pre-verified); for email signups it happens on the post-verify sync. Either
        // way the welcome lands AFTER the user has proven their address.
        const shouldSendWelcome = (snap: typeof snapshot): boolean => {
            if (!emailVerified) return false;
            if (!snap.exists) return true;
            return snap.data()?.welcomeSent !== true;
        };

        if (!snapshot.exists) {
            // ── The uid must still be a LIVE auth user ──
            //
            // This path creates an account document for whatever uid the bearer
            // token carried, and until this check it did so unconditionally —
            // which made a deleted account resurrectable. A Firebase ID token
            // stays valid for up to an hour after the user behind it is deleted,
            // so a second device that had not yet noticed would call this
            // endpoint on its next foreground and put the document straight
            // back. Measured: `testnyk67@gmail.com` ended up with ONE auth user
            // and TWO user documents, the orphan still holding the boards the
            // other device re-pushed into it.
            //
            // The token proves who minted it, never that they still exist. Only
            // Auth can answer that, and this is the one path where asking is
            // affordable — an account is created once.
            try {
                await auth.getUser(uid);
            } catch (err: any) {
                if (err?.code === 'auth/user-not-found') {
                    console.warn(`USER: 🚫 refused to create doc for deleted auth user ${uid}`);
                    throw new Error('Account no longer exists');
                }
                throw err;
            }

            // ── One email, one account ──
            //
            // Auth already enforces this (one user per email), so a second
            // document under the same address is by definition a leftover — and
            // it is invisible: nothing reads by email, so it accumulates in
            // silence while a client keeps happily writing to it.
            //
            // Only removed when Auth CONFIRMS the owner is gone. A doc whose uid
            // still resolves is somebody's live account and is never touched
            // here, whatever it looks like from this side.
            await this.purgeOrphanDocsForEmail(email, uid);

            const sendWelcome = shouldSendWelcome(snapshot);
            const displayName = data.displayName || 'Stationly User';
            const newUser: UserProfile = {
                uid,
                email,
                displayName,
                photoURL: data.photoURL || '',
                // No `address` / `phoneNumber`: this was the ONLY writer of
                // either, and it only ever wrote an empty string. Seeding a
                // field nothing reads is how a field nobody wanted survives.
                signInProvider: data.signInProvider || 'email',
                createdAt: timestamp,
                updatedAt: timestamp,
                loggedIn: true,
                lastLoggedInTime: timestamp,
                // No session seeded HERE. The device row is written by
                // `startSession`, called explicitly after the document exists —
                // so the session is created in exactly one place for a new
                // account and a returning one. Seeding it here as well was how
                // the `loggedIn: true, sessions: {}` artefact was born: a signup
                // with no deviceId wrote an empty map beside a true flag, and
                // every later reader had to special-case it.
                emailVerified,
                welcomeSent: sendWelcome,
                stations: [],
                // Present and empty rather than absent: an empty array is the
                // true answer for a new account, and it stops
                // `deriveBoardsFromLegacy` running on every read for a user who
                // has simply not saved a board yet.
                boards: [],
                // Zero so the very first client write always wins the LWW check,
                // whatever clock that device is carrying.
                boardsUpdatedAt: 0,
            };
            await userRef.set(newUser);

            // ── The signup path needs its device row too, and used to go without ──
            //
            // AWAITED, and not `DeviceLifecycleService.bind` — that is a named
            // no-op now (the row IS the session, written inside the transaction
            // below), so this branch was creating an account with `loggedIn: true`
            // and NO device rows at all. Every invariant downstream reads that as
            // an account whose every session has ended: `check_session_state`
            // reports it as a violation, and the nightly sweep releases the
            // account's subscription holds and purges its FCM tokens — at 3am,
            // one account at a time, in complete silence.
            //
            // The window was real rather than theoretical: it closed only on the
            // account's SECOND app open, or on a `/device/register` that happened
            // to land first. Sign up in the evening, save a station, close the
            // app, and the sweep took the station back before morning.
            //
            // After `userRef.set`, so the transaction's `if (!doc.exists) return`
            // guard sees the document this branch just created. `prevLoggedIn` is
            // true on that document, so no subscription delta fires — correct, a
            // new account holds nothing yet. What it DOES do is write the row and
            // run the steal, so signing up on a phone another account still holds
            // releases that account atomically, exactly as a sign-in does.
            if (deviceId) await this.startSession(uid, deviceId, deviceInfo);
            if (sendWelcome) {
                // Fire-and-forget — never block signup on email delivery
                EmailService.sendWelcomeEmail(email, displayName);
            }
            return newUser;
        } else {
            const sendWelcome = shouldSendWelcome(snapshot);

            // Strip undefined values from data so Firestore doesn't crash, and
            // drop the fields a profile sync has no business writing.
            //
            // The controller spreads `...other` from the request body into this,
            // so anything the client sends lands here. That was survivable when
            // the document held only profile scalars; it is not now that state
            // the user cannot afford to lose sits on the same doc — a body
            // carrying `boards: []` would silently wipe every saved board
            // through an endpoint whose whole job is to update a display name.
            const cleanedData = Object.fromEntries(
                Object.entries(data).filter(([k, v]) => v !== undefined && !PROTECTED_PROFILE_FIELDS.has(k))
            );

            const existingData = snapshot.data();

            // Profile fields only — DIFF-GATED: include just the fields that
            // actually changed, so a plain re-open (identical profile) skips the
            // write entirely and never re-stamps `updatedAt`. Session state
            // (sessions/loggedIn) + subscription ref-count are handled atomically
            // by startSession() below.
            const updateData: Record<string, any> = {};
            for (const [k, v] of Object.entries(cleanedData)) {
                if (existingData?.[k] !== v) updateData[k] = v;
            }
            if (existingData?.emailVerified !== emailVerified) updateData.emailVerified = emailVerified;
            if (sendWelcome) updateData.welcomeSent = true;

            // Notify the user's other devices if the display name actually changed.
            const nameChanged =
                typeof data.displayName === 'string' &&
                data.displayName.trim().length > 0 &&
                data.displayName !== existingData?.displayName;

            // Only write when something genuinely changed — `updatedAt` rides
            // along only then (never as a standalone per-open heartbeat). The
            // rev moves on exactly the same condition, which is what keeps a
            // plain re-open (identical profile, no write) from waking every
            // other device: no write, no bump, no fetch.
            //
            // Note the bump is gated on the WRITE, not on [nameChanged]. Any
            // profile field the client can change is content a client can read
            // back, so a photo URL changing has to move the rev too; gating on
            // the display name alone would leave the others invisible to a
            // rev-gated client. The push still fires only for the name, because
            // that is the only one anything currently redraws for.
            const wrote = Object.keys(updateData).length > 0;
            if (wrote) {
                updateData.updatedAt = timestamp;
                updateData.stateRev = FieldValue.increment(1);
                await userRef.update(updateData);
            }

            // Ordered after the write so the ledger refresh reads a document
            // that already has the new value. Fired when the name changed (the
            // other devices need telling) OR when anything else was written (the
            // ledger needs to learn the new rev, even with nobody to push to).
            if (nameChanged) this.afterContentWrite(uid, 'profile');
            else if (wrote) this.afterContentWrite(uid);

            // Register this device's session (atomic; increments saved-station
            // subscriptions only on this user's first active device).
            // LEVEL-1 read saving: we already fetched the user above, so skip the
            // startSession transaction (a second Firestore read) entirely when
            // this device is ALREADY an active session and the user is logged in
            // — nothing would change. Only a NEW device or a logged-out→in
            // transition needs the atomic path. (Stale-session pruning is
            // deferred to the next real write; harmless at the 90-day TTL.)
            if (deviceId) {
                // ⚠️ Reads the device ROW, never `existingData.sessions`.
                //
                // This is where the cutover bit, and it is worth keeping the
                // scar. The guard used to read the legacy sessions map — which
                // P2c stopped WRITING but has not yet DELETED. So after a
                // sign-out deleted the device row, the frozen map still showed
                // the device as active, this short-circuit concluded there was
                // nothing to do, `startSession` never ran, and **the row was
                // never recreated on sign-in**. The device silently vanished
                // from its own account's push audience while `loggedIn` stayed
                // true on the strength of the account's OTHER devices.
                //
                // Caught on the connected iPhone, not by a test: nothing errored
                // and every request returned 200.
                //
                // The general rule this illustrates: while a superseded store is
                // still readable, "stopped writing it" is not the same as
                // "nothing reads it". Grep for every reader before flipping the
                // writer, and prefer deleting the old store early.
                //
                // One read on a known path, which is what the elision is buying:
                // `startSession`'s transaction reads the user doc, the whole
                // subcollection AND a collection-group query, so skipping it
                // when nothing has changed matters more after the move, not less.
                // THE SAME predicate the transaction uses — see
                // [rowNeedsLoginWrite]. Two copies of it is exactly how a fix
                // inside `startSession` came to have no effect at all: this
                // short-circuit answered first and the transaction never ran.
                const row = await UserDeviceService.get(uid, deviceId);
                const deviceAlreadyActive =
                    existingData?.loggedIn === true
                    && !!row
                    && !this.rowNeedsLoginWrite(row, Date.now());
                if (!deviceAlreadyActive) {
                    await this.startSession(uid, deviceId, deviceInfo);
                }
            }

            if (sendWelcome) {
                const displayName = (data.displayName || existingData?.displayName || 'Stationly User');
                EmailService.sendWelcomeEmail(email, displayName);
            }

            // ⚠️ NEVER spread `updateData` raw into a response.
            //
            // It carries Firestore SENTINELS — `stateRev: FieldValue.increment(1)`
            // — which are write instructions, not values. Serialised into JSON
            // they become an opaque object, and a client that types the field
            // (iOS declares `stateRev: Long`) throws on deserialisation.
            //
            // This shipped, and the symptom was worth recording because it looks
            // nothing like the cause: the login POST returned **200**, the server
            // state was correct, and the app bounced straight back to the login
            // screen. `LoginViewModel` catches any exception in the sync block,
            // rolls the session back and signs the user out — so a response the
            // client could not parse presented as "we couldn't reach our
            // servers". It was also intermittent in exactly the way that misleads:
            // it only fired when a profile field had ACTUALLY changed (making
            // `updateData` non-empty), so the retry immediately afterwards wrote
            // nothing, carried no sentinel, and succeeded.
            const { stateRev: _sentinel, ...safeUpdate } = updateData;
            return {
                stations: [], // Default fallback
                ...existingData,
                ...safeUpdate,
                // The optimistic next revision, as a NUMBER. Same rule as the two
                // sync endpoints: it can only ever undershoot the truth, and an
                // undershoot costs at most one extra fetch.
                stateRev: wrote ? this.nextRevOf(existingData) : Number(existingData?.stateRev ?? 0),
            } as unknown as UserProfile;
        }
    }

    /**
     * The user document, with v2 [UserProfile.boards] guaranteed present.
     *
     * This is the ONE read a client makes at login, so it has to answer
     * everything the login needs: the profile and both board lists, on one
     * document, in one round trip.
     *
     * It does NOT carry settings, and it never will — those are device-local, so
     * there is nothing here to hand back. What a login restores from the cloud is
     * what the user TRACKS; how it looks is the device's own business, read off
     * disk before the first frame.
     */
    static async getUserProfile(uid: string): Promise<UserProfile> {
        const doc = await this.collection.doc(uid).get();
        if (!doc.exists) {
            throw new Error('User not found');
        }
        const data = doc.data() as UserProfile;

        // Free ledger repair. This read already happened for the caller's own
        // reasons, so mirroring what it saw costs nothing and means every real
        // client fetch drags the watermark back onto the truth.
        //
        // Not awaited: the caller is waiting on a profile, not on a cache write,
        // and [UserRevLedger.observe] never rejects by contract — so detaching
        // it here cannot leak an unhandled promise.
        const rev = Number(data.stateRev ?? 0);
        void UserRevLedger.observe(uid, Number.isFinite(rev) ? rev : 0);

        return {
            ...data,
            // Explicit rather than left to the spread: a document written before
            // this field existed has no `stateRev`, and `undefined` would reach
            // the client as a missing key. Zero is the honest answer for "this
            // account has never had a content write since the field shipped",
            // and a client comparing against it simply fetches once.
            stateRev: Number.isFinite(rev) ? rev : 0,
            stations: data.stations ?? [],
            // Never an empty array where the user has an Android board — see
            // [deriveBoardsFromLegacy]. `boards` present-but-empty is a real
            // answer (the user deleted their last board on iOS) and is left as
            // it is; only a MISSING array is derived.
            //
            // A document still holding a superseded shape decodes client-side
            // to a board with no selections, which every reader treats as
            // ABSENT rather than empty — so it degrades to the legacy fallback
            // instead of wiping the device. Nothing is folded here on read: the
            // shapes that needed folding only ever existed in development.
            boards: data.boards === undefined
                ? this.deriveBoardsFromLegacy(data.stations ?? [])
                : (data.boards ?? []),
        };
    }

    /**
     * LEGACY board list — Android's write path, unchanged in behaviour.
     *
     * Still a full replace, still keyed on [UserProfile.stations]. It can no
     * longer take iOS's boards with it, because those are not in this array;
     * that is the whole reason [SavedBoard] is a separate list.
     */
    static async syncStations(uid: string, stations: SubscribedStation[], deviceId?: string) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        const data = snapshot.exists ? (snapshot.data() ?? {}) : {};
        const before = this.effectiveStationIds(data);

        await userRef.update({
            stations,
            updatedAt: new Date().toISOString(),
            // Content changed, so the account's revision moves. Same write, no
            // extra cost, and atomic under concurrency — see [UserProfile.stateRev].
            stateRev: FieldValue.increment(1),
            // Android's write path sweeps it too, so an account that never
            // touches iOS still sheds the dead field. Free — same write.
            ...DROP_LEGACY_PREFERENCES,
        });

        // Diffed against the UNION, so replacing Android's list never releases
        // a station an iOS board still holds.
        this.applySubscriptionDelta(before, this.effectiveStationIds({ ...data, stations }));

        this.afterContentWrite(uid, 'stations', deviceId);

        // The optimistic next rev, handed back so the WRITING device can stamp
        // its own `localRev` and not refetch its own echo on the next
        // foreground. `excludeDeviceId` only stops the push; without this the
        // writer would still see the ledger move and go and read the profile it
        // just wrote.
        //
        // Optimistic is safe HERE though it is not safe in the ledger: the true
        // rev after this write is at least `read + 1`, never less, so this can
        // only ever undershoot. An undershoot makes the device fetch when it did
        // not strictly need to, which is the harmless direction. The ledger's
        // problem is the opposite one — see [UserRevLedger].
        return { success: true, count: stations.length, rev: this.nextRevOf(data) };
    }

    /**
     * v2 board list — the platform-neutral write path. A full replace, like its
     * legacy counterpart, because a partial apply of a board list is not a state
     * any client can recover from.
     *
     * iOS is the only caller today; Android reaches the same endpoint unchanged
     * when it adopts the board model, which is why nothing here is conditional on
     * the platform. The legacy `stations` array stays exactly as it is until then
     * — see [effectiveStationIds] for the union that keeps both honest.
     *
     * ## Rejected rather than merged when stale
     * [clientUpdatedAt] is the device's clock at the moment the user changed
     * something. A write carrying a timestamp at or before the stored one is
     * dropped and reported as such, which is what stops a device that has been
     * offline from replaying an old board list over a newer one when it comes
     * back. A client that omits the timestamp is trusted (older builds, and the
     * first write on an account), since refusing those would break the very
     * upgrade this schema exists for.
     *
     * ## An empty list has to be asked for
     * `boards: []` is a request to delete every board on the account, and it is
     * indistinguishable from a client whose local database is momentarily empty.
     * That is not hypothetical: a client's login path wipes local storage before
     * repopulating it from here, so a device backgrounded inside that window
     * posts an empty list stamped `Date.now()`, which always wins the LWW guard
     * above. The user loses every board, on every device, and nothing logs it.
     *
     * So the destructive case needs [allowEmpty], which a client sets only when a
     * USER action emptied the list. It defaults to false, so a caller that has
     * never heard of the flag cannot clear an account by omission — the safe
     * direction for the exact clients this back-compat window exists for.
     */
    static async syncBoards(
        uid: string,
        boards: SavedBoard[],
        clientUpdatedAt?: number,
        allowEmpty = false,
        deviceId?: string,
    ) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        if (!snapshot.exists) throw new Error('User not found');

        const data = snapshot.data() ?? {};
        const storedAt = typeof data.boardsUpdatedAt === 'number' ? data.boardsUpdatedAt : 0;
        if (typeof clientUpdatedAt === 'number' && clientUpdatedAt <= storedAt) {
            return { success: true, applied: false, reason: 'stale', count: (data.boards ?? []).length };
        }

        const before = this.effectiveStationIds(data);
        const clean = this.sanitiseBoards(boards);

        // Refuse to clear a list that has something in it, unless asked. Logged
        // loudly rather than silently: reaching here means a client sent an empty
        // list it could not justify, which is a bug worth seeing, and the user is
        // one accepted write away from losing everything.
        const stored = Array.isArray(data.boards) ? (data.boards as SavedBoard[]) : [];
        if (clean.length === 0 && stored.length > 0 && !allowEmpty) {
            console.warn(
                `SYNC_BOARDS: ⚠️ refused empty write for ${uid} — ${stored.length} stored board(s) kept (allowEmpty not set)`,
            );
            // A 200, not an error. The client must NOT retry: the same payload
            // would be refused again, and treating it as transient would put a
            // destructive write in a loop.
            return { success: true, applied: false, reason: 'empty_rejected', count: stored.length };
        }

        const updatedAt = typeof clientUpdatedAt === 'number' ? clientUpdatedAt : Date.now();

        await userRef.update({
            boards: clean,
            boardsUpdatedAt: updatedAt,
            updatedAt: new Date().toISOString(),
            // Only on this branch. The two declined branches above returned a
            // 200 having written nothing, and bumping there would tell every
            // device to refetch a document that never moved.
            stateRev: FieldValue.increment(1),
            ...DROP_LEGACY_PREFERENCES,
        });

        this.applySubscriptionDelta(before, this.effectiveStationIds({ ...data, boards: clean }));
        // The device that made the edit already has this state — see
        // [UserSyncOptions.excludeDeviceId]. A client that sends no device id
        // (every build shipped so far) is notified exactly as before.
        this.afterContentWrite(uid, 'boards', deviceId);

        // See [syncStations] for why the writer gets an optimistic rev back.
        return { success: true, applied: true, count: clean.length, rev: this.nextRevOf(data) };
    }

    /**
     * Drop unknown-shaped entries and normalise the optional fields.
     *
     * Firestore rejects a write containing `undefined` anywhere in the object
     * graph, and a board is mostly optional fields — so a client that omits a
     * filter (i.e. almost every board) would otherwise fail the whole write
     * with an error that names the field but not the board.
     */
    private static sanitiseBoards(boards: SavedBoard[]): SavedBoard[] {
        return (Array.isArray(boards) ? boards : [])
            .filter(b => b && typeof b.id === 'string' && b.id.length > 0)
            .map(b => this.stripUndefined({
                id: b.id,
                name: b.name ?? '',
                selections: (b.selections ?? [])
                    // A selection without a naptan is unfetchable, so it is not
                    // a board — dropping it here is better than storing
                    // something that can only ever render empty.
                    .filter(sel => sel && typeof sel.naptanId === 'string' && sel.naptanId.length > 0)
                    .map(sel => ({
                        naptanId: sel.naptanId,
                        line: sel.line ?? '',
                        mode: sel.mode ?? '',
                        direction: sel.direction ?? '',
                        filter: {
                            mode: sel.filter?.mode ?? 'ALL',
                            destinationIds: sel.filter?.destinationIds ?? [],
                            destinationNames: sel.filter?.destinationNames ?? [],
                            viaIds: sel.filter?.viaIds ?? [],
                            viaNames: sel.filter?.viaNames ?? [],
                            // ⚠️ This is an ALLOW-LIST, not a pass-through. A
                            // filter field missing from here is silently dropped
                            // on every sync, so the device that saved it keeps
                            // working and every OTHER device — and the same
                            // device after a reinstall — gets the board back
                            // with that half of the filter gone. Add new filter
                            // fields HERE as well as to the client model.
                            viaKeys: sel.filter?.viaKeys ?? [],
                            patternIds: sel.filter?.patternIds ?? [],
                            patternNames: sel.filter?.patternNames ?? [],
                            resolvedAt: typeof sel.filter?.resolvedAt === 'number' ? sel.filter.resolvedAt : 0,
                        },
                    })),
                addedAt: typeof b.addedAt === 'number' ? b.addedAt : Date.now(),
            }) as SavedBoard)
            // A board with no usable selection says nothing and must not be
            // stored: every reader treats it as absent anyway, and keeping it
            // would let a truncated write look like a real board list.
            .filter(b => b.selections.length > 0);
    }

    /** Recursively remove `undefined`, which Firestore refuses to store. */
    private static stripUndefined<T>(value: T): T {
        if (Array.isArray(value)) return value.map(v => this.stripUndefined(v)) as unknown as T;
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                if (v !== undefined) out[k] = this.stripUndefined(v);
            }
            return out as T;
        }
        return value;
    }

    static async addStation(uid: string, station: SubscribedStation) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        if (!snapshot.exists) throw new Error('User not found');

        const userData = snapshot.data() as UserProfile;

        // As requested by user: For now we are only allowing user to have one board
        const updatedStations = [station];

        await userRef.update({
            stations: updatedStations,
            updatedAt: new Date().toISOString(),
            stateRev: FieldValue.increment(1),
        });

        // Diffed against the union so collapsing the LEGACY list to one board
        // cannot release a station an iOS v2 board still holds.
        this.applySubscriptionDelta(
            this.effectiveStationIds(userData),
            this.effectiveStationIds({ ...userData, stations: updatedStations }),
        );

        this.afterContentWrite(uid, 'stations');

        return { ...userData, stations: updatedStations };
    }

    static async removeStation(uid: string, stationId: string, lineId: string) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        if (!snapshot.exists) throw new Error('User not found');

        const userData = snapshot.data() as UserProfile;
        const updatedStations = (userData.stations ?? []).filter(s => !(s.id === stationId && s.line === lineId));

        await userRef.update({
            stations: updatedStations,
            updatedAt: new Date().toISOString(),
            stateRev: FieldValue.increment(1),
        });

        // Was an unconditional decrement, which was wrong the moment a station
        // could appear twice: removing ONE line at an interchange released the
        // station out from under the other lines still tracked there. The diff
        // only fires when the id has left both lists entirely.
        this.applySubscriptionDelta(
            this.effectiveStationIds(userData),
            this.effectiveStationIds({ ...userData, stations: updatedStations }),
        );

        this.afterContentWrite(uid, 'stations');

        return { ...userData, stations: updatedStations };
    }

    static async deleteAccount(uid: string) {
        const userRef = this.collection.doc(uid);

        // Drop the rev watermark. Deliberately NOT a content bump — the document
        // is going away, and `deleted` tells clients to log out rather than to
        // fetch. Forgotten rather than left behind so that a uid which is ever
        // reused starts from nothing: a stale high watermark against a fresh
        // account would sit above every client's localRev and suppress the one
        // fetch a new account most needs.
        void UserRevLedger.forget(uid);
        void UserWatchIndex.forget(uid);

        // Notify the user's other devices BEFORE we delete the doc + tokens,
        // so they can force-log-out instead of showing a ghost session.
        await UserSyncNotifier.notify(uid, 'deleted');

        // ── Kill every outstanding token NOW, before anything else ──
        //
        // The push above is best-effort and a device can miss it. This is the
        // part that does not depend on delivery: it marks every already-issued
        // ID token as revoked, so the next authenticated request from ANY device
        // fails the `checkRevoked` verification in `validateUserToken` and the
        // client is told `account_gone`.
        //
        // Without it there is an ~1h window in which a device that missed the
        // push still holds a token this backend accepts — and one of the things
        // it can do with it is re-create the very document being deleted here.
        // That is not hypothetical; it is how this account ended up duplicated.
        //
        // First, not last: `deleteUser` below revokes as a side effect, but
        // everything between here and there is time in which the window is open.
        try {
            await auth.revokeRefreshTokens(uid);
        } catch (err: any) {
            if (err?.code !== 'auth/user-not-found') {
                console.error(`USER: ⚠️ could not revoke tokens for ${uid}`, err);
            }
        }

        // ── Device registry rows go BEFORE the session teardown ──
        //
        // ## The ordering trap is GONE, not reordered
        //
        // This used to carry a careful note: "the device purge must precede the
        // session teardown, because the teardown clears the `uid` the purge
        // queries on". That constraint dissolved entirely when the rows moved
        // inside the account, and it is the single clearest win of the nesting.
        //
        // There is no separate device purge left to order. The rows are INSIDE
        // the subtree, so `purgeUserSubtree` removes them by walking
        // `listCollections()` — which it already does, and which is exactly why
        // it must keep DISCOVERING subcollections rather than naming them.
        //
        // `endSession` still runs first, but now only for its TRANSITION: the
        // subscription decrement and the audience invalidation. Not for the
        // deletion.
        //
        // The retired root collection is still purged for as long as it exists,
        // so a rolled-back deploy does not leave orphans behind it. Delete this
        // line with the collection.
        await DeviceLifecycleService.purgeForUid(uid);

        // Release this user's subscription hold ATOMICALLY via endSession: it
        // clears all sessions, flips loggedIn=false, and decrements each saved
        // station EXACTLY ONCE — and only if still logged in. Routing through the
        // same transactional, loggedIn-gated path as logout (instead of a plain
        // decrement loop) prevents a double-decrement if a logout on another
        // device races this deletion, which could otherwise push a station's
        // count below what OTHER users contribute and cut them off. The decrement
        // captures the station ids inside the transaction, so deleting the doc
        // immediately after is safe.
        await this.endSession(uid);

        // Drop every subcollection before the document — see [purgeUserSubtree]
        // for why Firestore makes this necessary and why they are ENUMERATED
        // rather than named. That enumeration is what now removes the device
        // rows for free: they are a subcollection like any other, so nothing
        // here has to know they exist.
        await this.purgeUserSubtree(userRef, uid);

        // Delete Firestore document
        await userRef.delete();

        // Delete Firebase Auth user via Admin SDK
        try {
            await auth.deleteUser(uid);
        } catch (err: any) {
            // If user is already deleted from Auth, that's fine — still return success
            if (err.code !== 'auth/user-not-found') throw err;
        }

        return { success: true };
    }

    /**
     * Sign a single device out. Multi-device aware: removes only THIS device's
     * session. The user stays "logged in" (and keeps their subscription hold)
     * until the LAST device signs out, at which point we decrement their saved
     * stations. The `stations` array is always preserved for re-login restore.
     *
     * If no deviceId is supplied (legacy clients / "sign out everywhere"), all
     * sessions are cleared and the decrement runs.
     */
    static async logOut(uid: string, deviceId?: string) {
        // endSession atomically removes this device's session and, only when the
        // LAST device signs out, flips loggedIn=false and releases the user's +1
        // hold on each saved station. SubscriptionService.updateCount floors at 0
        // and deletes a station from the registry only when the TOTAL across all
        // users hits 0 — so a station any other user/device still watches is
        // never removed.
        await this.endSession(uid, deviceId);
        return { success: true };
    }
}
