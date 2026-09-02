import admin from 'firebase-admin';
import { db } from '../config/firebase';

const FieldValue = admin.firestore.FieldValue;
import { toEpochMs } from '../utils/timestamps';

/**
 * `users/{uid}/devices/{deviceId}` — the merged device-and-session row.
 *
 * ## The row's EXISTENCE is the session
 * This is the whole point of the shape. Signing in creates the row; signing out
 * deletes it. There is no `loggedIn` field on it to get wrong and no second
 * record to disagree with it.
 *
 * It replaces two stores that could contradict each other:
 *
 *   users/{uid}.sessions[deviceId]   platform, model, osVersion, appVersion, firstSeen, lastSeen
 *   devices/{deviceId}               uid, environment, appToken, widgetToken, stations[], lines[], iosVersion
 *
 * Both claimed to know which account a device belonged to, and every
 * device/session bug in the August handovers came from them disagreeing. One
 * store makes that class of bug unrepresentable rather than merely unlikely.
 *
 * ## What did NOT come across, and why
 * `stations[]` and `lines[]` are dropped rather than moved. They are named like
 * device data and hold ACCOUNT data — the value came from the directory of every
 * station the account tracks, rebuilt from the synced boards. That is why a
 * single board edit currently rewrites the device row on EVERY device: each one
 * re-registers its copy of the list on next foreground. After this it is one
 * write to one document, and the audience is resolved from the SQLite mirror
 * that already re-derives from `boards`.
 *
 * `uid` is not a field either: the parent document IS the uid, so storing it
 * again is a second copy that can drift from the path holding it.
 *
 * ## But `deviceId` IS stored as a field, deliberately
 * A collection-group query cannot filter on document id across unknown parents,
 * and the login steal check (§4.1 of the design) is exactly such a query. The
 * retired root collection stored it as a field for the same reason.
 */
export interface UserDeviceRow {
    deviceId: string;
    platform: 'ios' | 'android' | 'web';
    model?: string;
    /** RENAMED from the registry's `iosVersion` — this row is cross-platform. */
    osVersion?: string;
    appVersion?: string;
    /**
     * APNs ONLY. An APNs token is valid against exactly one host, so a token and
     * the environment it was minted for have to travel together.
     *
     * Never give this an FCM meaning. FCM tokens are not environment-scoped, and
     * a field that means two things is a field that gets read wrong.
     */
    environment?: 'sandbox' | 'production';
    appToken?: string;
    widgetToken?: string;
    /**
     * Reserved for Android-next and web. **Nothing writes or reads it today.**
     *
     * Declared because defining a field costs nothing and reserves the name;
     * writing a code path with no producer costs a maintainer. See §12 of the
     * design, which lists this as deliberately unbuilt.
     */
    fcmToken?: string;
    /** Epoch ms. The house watermark convention — never ISO strings. */
    firstSeen: number;
    lastSeen: number;
}

/**
 * A device row plus the account it belongs to — the shape the push path speaks.
 *
 * `uid` is restored from the PARENT document, never stored on the row: the path
 * already names the account, and a second copy is a second thing that can drift.
 *
 * This replaces `RegisteredDevice` from the retired root-collection service. The
 * fields are the same minus `stations[]` / `lines[]`, which §3.1 removed because
 * they described the ACCOUNT rather than the device (see the class comment).
 */
export interface AddressableDevice extends UserDeviceRow {
    uid: string;
}

export class UserDeviceService {

    /**
     * A device unheard-from this long is treated as gone.
     *
     * Deliberately the same 90 days as the sessions map it replaces — the TTL is
     * a product decision about abandoned installs, not a property of the storage
     * shape, so moving the storage must not quietly move the threshold.
     */
    static readonly TTL_MS = 90 * 24 * 60 * 60 * 1000;

    /** The account's device collection. A known path — needs no index. */
    static devices(uid: string) {
        return db.collection('users').doc(uid).collection('devices');
    }

    /**
     * Is this row still inside the TTL?
     *
     * The device-row counterpart of `UserService.isSessionLive`, and it reads
     * `lastSeen` as a NUMBER because the merged row stores epoch ms where the
     * sessions map stored an ISO string. That difference is the whole reason
     * this is a separate predicate rather than a shared one: a single function
     * accepting either would have to guess, and guessing wrong in the permissive
     * direction pins an account's subscription holds open forever.
     *
     * Reads TTL_MS through the class name, not `this`. Callers pass this
     * DETACHED to `.filter` / `.some`, which supply no receiver — the same trap
     * `isSessionLive` carries a test for.
     */
    static isRowLive(row: { lastSeen?: unknown } | undefined): boolean {
        const seen = row?.lastSeen;
        if (typeof seen !== 'number' || !Number.isFinite(seen)) return false;
        return seen >= Date.now() - UserDeviceService.TTL_MS;
    }

    /**
     * Build a row from the two stores being merged. **Pure** — no I/O, so the
     * merge rules are unit-testable without Firestore.
     *
     * The two sources are unequal on purpose:
     *
     *   - the **session** supplies what the device IS (platform, model, os, app
     *     version) and when it was seen. Only the sessions map ever had
     *     `platform` and `model`, which is why the push registry today cannot
     *     say what a device it is pushing to actually is.
     *   - the **registry row** supplies how to REACH it (environment, the two
     *     APNs tokens).
     *
     * Either may be absent. A session with no registry row is a device that
     * signed in but never registered for push; a registry row with no session
     * is a device that registered while signed out, or whose session was pruned.
     * Both are real and both must produce a usable row.
     */
    static rowFrom(
        deviceId: string,
        session: Record<string, any> | undefined,
        registry: Record<string, any> | undefined,
    ): UserDeviceRow {
        const now = Date.now();

        // ISO in the sessions map, epoch ms in the registry, epoch ms on the
        // merged row. `toEpochMs` is the house coercion and handles both, which
        // is why this does not hand-parse either.
        const firstSeen = toEpochMs(session?.firstSeen) ?? toEpochMs(registry?.updatedAt) ?? now;
        const lastSeen = toEpochMs(session?.lastSeen) ?? toEpochMs(registry?.updatedAt) ?? firstSeen;

        const row: UserDeviceRow = {
            deviceId,
            // Every row in the field today is iOS, and the registry never stored
            // a platform at all — so an absent one is inferred rather than left
            // blank. Guessing here is safe in a way it would not be later: this
            // only runs over rows that predate the field, and every one of them
            // was written by an iOS build (Android registers push through
            // `/user/fcm/register`, which never touched the device registry).
            platform: (session?.platform as UserDeviceRow['platform']) ?? 'ios',
            firstSeen,
            // A row cannot have been last seen before it was first seen. The two
            // sources can disagree, because they were written by different paths
            // at different times.
            lastSeen: Math.max(firstSeen, lastSeen),
        };

        // Written only when actually present. Firestore rejects `undefined`
        // anywhere in the object graph, and a null token is worse than an absent
        // one: `listForUid`-style filters match a row that has the field, so a
        // null-token row joins the push audience and is then undeliverable.
        const model = session?.model;
        const osVersion = session?.osVersion ?? registry?.iosVersion;
        const appVersion = session?.appVersion ?? registry?.appVersion;
        const environment = registry?.environment;
        const appToken = registry?.appToken;
        const widgetToken = registry?.widgetToken;

        if (typeof model === 'string' && model) row.model = model;
        if (typeof osVersion === 'string' && osVersion) row.osVersion = osVersion;
        if (typeof appVersion === 'string' && appVersion) row.appVersion = appVersion;
        if (environment === 'sandbox' || environment === 'production') row.environment = environment;
        if (typeof appToken === 'string' && appToken) row.appToken = appToken;
        if (typeof widgetToken === 'string' && widgetToken) row.widgetToken = widgetToken;

        return row;
    }

    // [listForUid] was deleted here — it had no callers. Every reader that wants
    // an account's rows needs the SNAPSHOT rather than the data (the push path
    // wants `.docs` for the ids, the transactions read inside `tx.get`), so a
    // helper returning bare row objects was one nobody could use.

    /** One row, or null. */
    static async get(uid: string, deviceId: string): Promise<UserDeviceRow | null> {
        const doc = await this.devices(uid).doc(deviceId).get();
        return doc.exists ? (doc.data() as UserDeviceRow) : null;
    }

    /**
     * Create or update a row. Merge, so `/device/register` can add tokens to a
     * row login created without either path needing to know about the other.
     */
    static async upsert(uid: string, row: Partial<UserDeviceRow> & { deviceId: string }): Promise<void> {
        // Strip undefined HERE rather than at each call site. Firestore rejects
        // a write containing `undefined` anywhere in the object graph, and every
        // caller assembles this row from optional request fields — so leaving it
        // to them means the first one that forgets fails the whole registration
        // with an error naming a field the client never sent.
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) if (v !== undefined) clean[k] = v;
        await this.devices(uid).doc(row.deviceId).set(clean, { merge: true });
    }

    // [remove] was deleted here — no callers, and by design there can be none.
    // Ending a session is `UserService.endSession`, which deletes the row INSIDE
    // the transaction that also decides the last-device-out transition. A bare
    // delete beside it is exactly the second teardown path this merge removed:
    // it would drop the row without releasing the account's subscription hold.

    /**
     * Drop this device's push tokens without ending its session.
     *
     * `upsert` STRIPS undefined (Firestore rejects it anywhere in the graph), so
     * clearing a field needs `FieldValue.delete()` explicitly — passing
     * `undefined` silently does nothing, which would leave a device receiving
     * pushes it had just asked to stop.
     *
     * Tokens only, never the row: the row IS the session, so deleting it would
     * sign the user out of a device they are still using.
     */
    static async clearTokens(uid: string, deviceId: string): Promise<void> {
        // ⚠️ `update`, NOT `set(merge)`.
        //
        // `set` with merge CREATES the document when it is absent, and a
        // document whose only contents are two `delete()` sentinels is an EMPTY
        // one — so unregistering a device that has already signed out would
        // conjure a row at a path whose very existence means "this account is
        // signed in on this device". A phantom session, from a call whose entire
        // job is to remove something.
        //
        // It survives `isRowLive` (no `lastSeen`, so it reads as not live) and
        // it carries no `deviceId` field, so the login steal query cannot even
        // see it to clean it up. The lazy prune eventually gets it, which is a
        // long way to go for a row that should never have been written.
        //
        // `update` fails with NOT_FOUND instead, which is the honest outcome:
        // there is nothing to unregister. Swallowed, because a client asking to
        // clear tokens that are already gone has got what it wanted.
        try {
            await this.devices(uid).doc(deviceId).update({
                appToken: FieldValue.delete(),
                widgetToken: FieldValue.delete(),
            });
        } catch (err: any) {
            if (err?.code === 5 || err?.code === 'not-found') return;   // already gone
            throw err;
        }
    }

    /**
     * Every device row on the platform, with the account each belongs to.
     *
     * The broadcast audience and the admin status count. Skips the retired root
     * collection, which a collection group also matches until it is deleted.
     *
     * Needs no index — an unfiltered collection-group read is automatic.
     * Verified on staging rather than assumed, by `check_device_indexes.cjs`.
     */
    static async listAll(): Promise<Array<{ uid: string; row: UserDeviceRow }>> {
        const snap = await db.collectionGroup('devices').get();
        const out: Array<{ uid: string; row: UserDeviceRow }> = [];
        for (const doc of snap.docs) {
            const account = doc.ref.parent.parent;
            if (!account) continue;
            out.push({ uid: account.id, row: doc.data() as UserDeviceRow });
        }
        return out;
    }

    /**
     * Strip a token that APNs has reported permanently dead, wherever it sits.
     *
     * Cleared field by field rather than deleting the row: the row IS the
     * session, so removing it would sign the user out of a device they are still
     * using because one of its two tokens went stale.
     */
    static async pruneToken(token: string): Promise<void> {
        if (!token) return;
        for (const field of ['appToken', 'widgetToken'] as const) {
            const snap = await db.collectionGroup('devices').where(field, '==', token).get();
            for (const doc of snap.docs) {
                if (!doc.ref.parent.parent) continue;
                await doc.ref.update({ [field]: FieldValue.delete() });
            }
        }
    }

    // [findAccountsHolding] was deleted here.
    //
    // It was the login steal check as a standalone helper, and it never had a
    // caller: the steal has to run INSIDE `startSession`'s transaction, where the
    // query must go through `tx.get` so it serialises with everything else the
    // transaction reads. A helper that does its own `.get()` cannot be used
    // there, so the transaction has the query inline and this was a second,
    // untestable copy of the same rule — including the `ref.parent.parent`
    // filter, which is the part that must never be forgotten.
    //
    // The filter's reasoning now lives on the inline query, next to the code
    // that depends on it, and is covered by
    // `startSession: a ROOT-collection row is never mistaken for a session`.
}
