import admin from 'firebase-admin';
import { db, auth } from '../config/firebase';
import { SubscriptionService } from './subscriptionService';
import { EmailService } from './emailService';
import { UserSyncNotifier } from './userSyncNotifier';
import { DeviceLifecycleService } from './deviceLifecycleService';

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
    address?: string;
    phoneNumber?: string;
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
    sessions?: Record<string, DeviceSession>;
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
const PROTECTED_PROFILE_FIELDS = new Set([
    'uid', 'stations', 'boards', 'boardsUpdatedAt', 'preferences',
    'sessions', 'loggedIn', 'lastLoggedInTime', 'emailVerified', 'welcomeSent',
    'createdAt', 'updatedAt',
]);

export class UserService {
    private static collection = db.collection('users');

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
    private static effectiveStationIds(data: Record<string, any> | undefined): string[] {
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

    /**
     * Build/refresh a device-session entry, preserving firstSeen if it exists.
     *
     * Every optional field is omitted rather than set to `undefined`. Firestore
     * REJECTS undefined anywhere in a write — the Admin SDK is initialised
     * without `ignoreUndefinedProperties` — so a client that sent a `deviceId`
     * with no `deviceInfo` (the field is optional on the wire, and defaults to
     * null on both clients) produced an entry of four undefined values and threw
     * inside the session transaction, failing `/user/sync/profile`. That is the
     * login path: the whole sign-in would have 500'd on a metadata field nothing
     * reads. The same hazard is why `sanitiseBoards` runs [stripUndefined].
     */
    private static buildSessionEntry(
        existing: DeviceSession | undefined,
        info: DeviceInfo | undefined,
        timestamp: string
    ): DeviceSession {
        return this.stripUndefined({
            platform: info?.platform ?? existing?.platform,
            osVersion: info?.osVersion ?? existing?.osVersion,
            model: info?.model ?? existing?.model,
            appVersion: info?.appVersion ?? existing?.appVersion,
            firstSeen: existing?.firstSeen ?? timestamp,
            lastSeen: timestamp,
        });
    }

    /** Drop sessions whose lastSeen is older than the TTL (uninstalled / abandoned devices). */
    private static pruneStaleSessions(sessions: Record<string, DeviceSession>): Record<string, DeviceSession> {
        const cutoff = Date.now() - this.SESSION_TTL_MS;
        const out: Record<string, DeviceSession> = {};
        for (const [id, s] of Object.entries(sessions)) {
            const seen = Date.parse(s?.lastSeen ?? '');
            if (!Number.isNaN(seen) && seen >= cutoff) out[id] = s;
        }
        return out;
    }

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
        let sessionChanged = false;
        let stationIds: string[] = [];
        await db.runTransaction(async (tx) => {
            // ── Reset on every attempt ──
            //
            // Firestore RETRIES this callback on contention, and these flags
            // live outside it. Only ever setting them to true made a retry
            // permanently inherit the first attempt's answer: attempt 1 reads
            // `loggedIn: false` and sets didActivate; another device wins the
            // race; attempt 2 reads `loggedIn: true` and correctly decides not
            // to activate — but didActivate is still true from attempt 1, so
            // BOTH devices increment, and every saved station on the account
            // ends up counted twice for one logical activation.
            //
            // An inflated count is not self-correcting: `updateCount` releases a
            // station only at 0, so it stays in the registry and the Syncer polls
            // TfL for it forever. The transaction callback has to be idempotent —
            // that is Firestore's contract for it, not a nicety.
            didActivate = false;
            sessionChanged = false;
            stationIds = [];

            const doc = await tx.get(ref);
            if (!doc.exists) return;
            const data = doc.data() || {};
            const ts = new Date().toISOString();
            const prevLoggedIn = data.loggedIn === true;
            const before = { ...(data.sessions || {}) };
            const sessions = this.pruneStaleSessions({ ...before });
            const hadDevice = !!sessions[deviceId];
            const prunedStale = Object.keys(sessions).length !== Object.keys(before).length;
            sessions[deviceId] = this.buildSessionEntry(sessions[deviceId], deviceInfo, ts);

            // Write ONLY on a real session change — logged-out→in, a NEW device,
            // or pruned stale sessions. A plain re-open on an already-active
            // device writes NOTHING (kills the per-open heartbeat). Cross-device
            // state (new device / logout) still propagates immediately.
            // lastLoggedInTime/updatedAt are write-only metadata nothing reads,
            // so we never write them for their own sake — they just piggyback on
            // these real-change writes.
            //
            // ...with ONE exception, or the TTL above is a lie. Eliding the
            // write means `lastSeen` never advances, so it is really "when this
            // install first ran" and never "when we last heard from it". Two
            // things follow, and both are wrong in opposite directions: a
            // device in DAILY use for 90 days is pruned as abandoned, and a
            // ghost left by a reinstall looks exactly as fresh as a real one.
            //
            // Refreshing at most once per [SESSION_REFRESH_MS] restores the
            // meaning while keeping the optimisation where it pays: an ordinary
            // re-open still writes nothing.
            const seenAt = Date.parse(before[deviceId]?.lastSeen ?? '');
            const sessionStale =
                hadDevice && (Number.isNaN(seenAt) || Date.now() - seenAt > this.SESSION_REFRESH_MS);
            const needWrite = !prevLoggedIn || !hadDevice || prunedStale || sessionStale;
            if (needWrite) {
                tx.update(ref, { sessions, loggedIn: true, lastLoggedInTime: ts, updatedAt: ts });
            }
            if (!prevLoggedIn) { didActivate = true; stationIds = this.effectiveStationIds(data); }
            sessionChanged = needWrite;
        });
        // Both board lists, deduplicated — an iOS board and an Android board are
        // equally real subscriptions. See [effectiveStationIds].
        if (didActivate) this.applySubscriptionDelta([], stationIds);

        // Point the device registry at this account, so `user.sync` over APNs
        // reaches it. Gated on the same "something actually changed" answer the
        // transaction computed, because the elision above exists precisely to
        // make a plain re-open free and an unconditional write here would hand
        // that saving straight back.
        //
        // Fire-and-forget: the session is established, and a registry row that
        // is one foreground behind is corrected by the client's own
        // re-registration. Failing the login over it would be far worse.
        if (sessionChanged) {
            setImmediate(() => DeviceLifecycleService.bind(uid, deviceId));
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
     * [DeviceLifecycleService.release] applies that across all three stores from
     * one place, using the transition computed INSIDE this transaction so the
     * all-or-nothing FCM purge can never fire while another device is still
     * signed in.
     */
    static async endSession(uid: string, deviceId?: string): Promise<void> {
        const ref = this.collection.doc(uid);
        let didDeactivate = false;
        let stationIds: string[] = [];
        await db.runTransaction(async (tx) => {
            // Reset on every attempt — see the same note in [startSession]. This
            // direction is the more dangerous of the two: a retry that inherited
            // a stale `didDeactivate` decrements stations the account still
            // holds, and `updateCount` deletes a station at 0, so it can take a
            // live station away from every OTHER user watching it.
            didDeactivate = false;
            stationIds = [];

            const doc = await tx.get(ref);
            if (!doc.exists) return;
            const data = doc.data() || {};
            const ts = new Date().toISOString();
            const prevLoggedIn = data.loggedIn === true;
            let sessions = this.pruneStaleSessions({ ...(data.sessions || {}) });
            if (deviceId) delete sessions[deviceId]; else sessions = {};
            const nowLoggedIn = Object.keys(sessions).length > 0;
            tx.update(ref, { sessions, loggedIn: nowLoggedIn, updatedAt: ts });
            if (prevLoggedIn && !nowLoggedIn) { didDeactivate = true; stationIds = this.effectiveStationIds(data); }
        });
        if (didDeactivate) this.applySubscriptionDelta(stationIds, []);

        // Awaited, unlike the subscription delta: the caller is `logOut`, whose
        // 200 the client reads as "this device is signed out everywhere it
        // matters". Returning before the audience is actually updated leaves a
        // window in which the phone that just logged out can still be woken by
        // the account it left.
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
                address: data.address || '',
                phoneNumber: data.phoneNumber || '',
                signInProvider: data.signInProvider || 'email',
                createdAt: timestamp,
                updatedAt: timestamp,
                loggedIn: true,
                lastLoggedInTime: timestamp,
                // Seed the device-session map with this first device. New users
                // have no saved stations yet, so there's nothing to increment.
                sessions: deviceId
                    ? { [deviceId]: this.buildSessionEntry(undefined, deviceInfo, timestamp) }
                    : {},
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
            // This branch seeds `sessions` directly instead of going through
            // `startSession`, so it is also the one place the device binding
            // would be missed. It matters for a signup that happens in a process
            // that has ALREADY registered the device while signed out: the
            // client elides a `/device/register` whose body is unchanged, and
            // the uid is not part of that body, so nothing else would attach the
            // new account to the row until the next cold launch.
            if (deviceId) setImmediate(() => DeviceLifecycleService.bind(uid, deviceId));
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
            if (nameChanged) {
                setImmediate(() => UserSyncNotifier.notify(uid, 'profile'));
            }

            // Only write when something genuinely changed — `updatedAt` rides
            // along only then (never as a standalone per-open heartbeat).
            if (Object.keys(updateData).length > 0) {
                updateData.updatedAt = timestamp;
                await userRef.update(updateData);
            }

            // Register this device's session (atomic; increments saved-station
            // subscriptions only on this user's first active device).
            // LEVEL-1 read saving: we already fetched the user above, so skip the
            // startSession transaction (a second Firestore read) entirely when
            // this device is ALREADY an active session and the user is logged in
            // — nothing would change. Only a NEW device or a logged-out→in
            // transition needs the atomic path. (Stale-session pruning is
            // deferred to the next real write; harmless at the 90-day TTL.)
            if (deviceId) {
                const session = existingData?.sessions?.[deviceId];
                // A session whose `lastSeen` has aged past the refresh window
                // must go through the transaction even though nothing else has
                // changed — otherwise this short-circuit cancels the refresh
                // that keeps SESSION_TTL_MS honest, and `lastSeen` is frozen at
                // the first launch of the install forever.
                const seenAt = Date.parse(session?.lastSeen ?? '');
                const needsRefresh =
                    !!session && (Number.isNaN(seenAt) || Date.now() - seenAt > this.SESSION_REFRESH_MS);
                const deviceAlreadyActive =
                    existingData?.loggedIn === true && !!session && !needsRefresh;
                if (!deviceAlreadyActive) {
                    await this.startSession(uid, deviceId, deviceInfo);
                }
            }

            if (sendWelcome) {
                const displayName = (data.displayName || existingData?.displayName || 'Stationly User');
                EmailService.sendWelcomeEmail(email, displayName);
            }

            return {
                stations: [], // Default fallback
                ...existingData,
                ...updateData
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
        return {
            ...data,
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
            // Android's write path sweeps it too, so an account that never
            // touches iOS still sheds the dead field. Free — same write.
            ...DROP_LEGACY_PREFERENCES,
        });

        // Diffed against the UNION, so replacing Android's list never releases
        // a station an iOS board still holds.
        this.applySubscriptionDelta(before, this.effectiveStationIds({ ...data, stations }));

        setImmediate(() => UserSyncNotifier.notify(uid, 'stations', { excludeDeviceId: deviceId }));

        return { success: true, count: stations.length };
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
            ...DROP_LEGACY_PREFERENCES,
        });

        this.applySubscriptionDelta(before, this.effectiveStationIds({ ...data, boards: clean }));
        // The device that made the edit already has this state — see
        // [UserSyncOptions.excludeDeviceId]. A client that sends no device id
        // (every build shipped so far) is notified exactly as before.
        setImmediate(() => UserSyncNotifier.notify(uid, 'boards', { excludeDeviceId: deviceId }));

        return { success: true, applied: true, count: clean.length };
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
            updatedAt: new Date().toISOString()
        });

        // Diffed against the union so collapsing the LEGACY list to one board
        // cannot release a station an iOS v2 board still holds.
        this.applySubscriptionDelta(
            this.effectiveStationIds(userData),
            this.effectiveStationIds({ ...userData, stations: updatedStations }),
        );

        setImmediate(() => UserSyncNotifier.notify(uid, 'stations'));

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
            updatedAt: new Date().toISOString()
        });

        // Was an unconditional decrement, which was wrong the moment a station
        // could appear twice: removing ONE line at an interchange released the
        // station out from under the other lines still tracked there. The diff
        // only fires when the id has left both lists entirely.
        this.applySubscriptionDelta(
            this.effectiveStationIds(userData),
            this.effectiveStationIds({ ...userData, stations: updatedStations }),
        );

        setImmediate(() => UserSyncNotifier.notify(uid, 'stations'));

        return { ...userData, stations: updatedStations };
    }

    static async deleteAccount(uid: string) {
        const userRef = this.collection.doc(uid);

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
        // Ordering, not preference. `endSession` now RELEASES this account's
        // device rows (clears their `uid`) as part of signing every device out,
        // and those rows are found by querying on that very field. Purging
        // afterwards would match nothing and leave a row per device behind for
        // an account that no longer exists — the same class of orphan the
        // subcollection sweep below was written to stop.
        //
        // Deleted rather than released here because the account is gone: a
        // device that still has the app installed re-registers on its next
        // foreground and gets a fresh row with no owner.
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
        // for why Firestore makes this necessary and why they are enumerated
        // rather than named. The device-registry half of that helper is a
        // no-op here: those rows were already deleted above, before the session
        // teardown cleared the `uid` the query needs.
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
