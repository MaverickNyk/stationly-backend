import { UserFcmTokenService } from './userFcmTokenService';

/**
 * The single owner of one fact: **which account a device belongs to.**
 *
 * ## Why this exists
 * That fact is recorded in three places, and until this service each was
 * maintained by different code that had never been reconciled:
 *
 * | Store | Keyed by | Written by |
 * |---|---|---|
 * | `users/{uid}.sessions[deviceId]` | deviceId | `UserService.startSession` / `endSession` |
 * | `devices/{deviceId}.uid` (root)  | deviceId | `/device/register` |
 * | `users/{uid}/fcm_tokens/{token}` | **the token** | `/user/fcm/register` |
 *
 * Every seam between them produced a bug. Logout cleared the first and neither
 * of the others, so a signed-out phone kept its place in the account's push
 * audience — over APNs because `devices/{deviceId}.uid` still named the
 * account, and over FCM because the token document was never removed. Account
 * deletion missed the same two until the subcollection purge and the device-row
 * purge were added, in two separate places, months apart.
 *
 * The pattern is not that any one of those writes was wrong. It is that
 * "this device now belongs to X" had **three implementations**, so a fix
 * applied to one was silently absent from the others. Routing every
 * ownership change through here makes the fan-out a property of the call
 * rather than something each caller has to remember.
 *
 * ## Why the stores were not simply merged
 * The obvious answer — one record per device under its owner,
 * `users/{uid}/devices/{deviceId}` — is not reachable from the backend alone,
 * for two independent reasons:
 *
 *  1. **A device does not always have an owner.** `/device/register` is
 *     API-key-only by deliberate design: a signed-out phone still runs widgets
 *     and still wants disruption pushes, and gating registration on a user
 *     token 401s exactly those devices. A subcollection under `users/{uid}` has
 *     nowhere to put a device with no uid.
 *  2. **`fcm_tokens` cannot be re-keyed by device.** `/user/fcm/register`
 *     carries no device id, and the builds already installed never will. The
 *     backend cannot map a token to a device for any client in the field.
 *
 * So the root `devices/{deviceId}` collection stays where it is — keyed by the
 * device's own identity, which is what makes token rotation an update rather
 * than an accumulation — and this service unifies the LIFECYCLE across the
 * three stores instead of the storage location.
 *
 * Everything here is best-effort and independently failure-isolated: none of it
 * may fail a login, a logout or an account deletion that has already happened.
 */
export class DeviceLifecycleService {

    // [bind] was deleted here.
    //
    // It was kept as a named no-op so its call site would still read as "and now
    // associate the device". That call site is gone: the signup path used to
    // invoke it and now calls `UserService.startSession`, which writes the row
    // inside its own transaction — the same one place a returning user's session
    // is created.
    //
    // The rule it was kept for ("delete both no-ops together or not at all")
    // applied while both had call sites. `purgeForUid` still has two, in
    // `deleteAccount` and `purgeUserSubtree`, so it stays; a no-op with NO caller
    // documents nothing and only invites someone to call it again.

    /**
     * A session has ended.
     *
     * [deviceId] is the device that signed out, or undefined for "sign out
     * everywhere" (a client that predates per-device sessions, or an account
     * deletion routing through the same path).
     *
     * [lastDeviceOut] must be the answer computed INSIDE the caller's session
     * transaction — the logged-in → logged-out transition. It gates the FCM
     * purge, which is all-or-nothing because the token documents cannot be
     * attributed to a device (see [UserFcmTokenService.purgeAllForUid]).
     * Purging on a single device's logout would silently mute push for the
     * user's other, still-signed-in phones.
     *
     * The device registry is released either way: that store IS keyed by
     * device, so the phone that left can always be identified precisely.
     */
    static async release(
        uid: string,
        deviceId: string | undefined,
        lastDeviceOut: boolean,
    ): Promise<void> {
        if (!uid) return;

        // ONLY the legacy FCM store is left to release here.
        //
        // The device row was already deleted inside `endSession`'s transaction —
        // the row IS the session, so ending the session removes the push
        // address with it, atomically. There is no second store to keep in step
        // any more, which is the point of the merge.
        //
        // `fcm_tokens` cannot follow it, and that is not an oversight: the store
        // is keyed by TOKEN and carries no device id (the frozen APK's
        // `/user/fcm/register` never sent one and never will), so a token cannot
        // be attributed to the device that is leaving. Only the last-device-out
        // gate can clear it safely.
        await this.releaseFcmTokens(uid, lastDeviceOut);
    }

    private static async releaseFcmTokens(uid: string, lastDeviceOut: boolean): Promise<void> {
        if (!lastDeviceOut) return;
        try {
            const purged = await UserFcmTokenService.purgeAllForUid(uid);
            if (purged > 0) {
                console.log(`DEVICE_LIFECYCLE: 🧹 purged ${purged} FCM token(s) for ${uid} (last device out)`);
            }
        } catch (err) {
            console.error(`DEVICE_LIFECYCLE: ⚠️ FCM purge failed for ${uid}`, err);
        }
    }

    /**
     * The account is gone — remove every trace of it from the device stores.
     *
     * The `fcm_tokens` subcollection is left to the caller's generic
     * subcollection purge, which already sweeps everything under the user
     * document; duplicating it here would be a second implementation of a rule
     * that exists precisely so a subcollection added later is not forgotten.
     * What that sweep CANNOT reach is the root `devices` collection, because it
     * is not under the user document at all.
     */
    static async purgeForUid(uid: string): Promise<void> {
        // Nothing left to do, deliberately kept as a named no-op.
        //
        // This used to delete the account's rows from the ROOT `devices`
        // collection — the one store `purgeUserSubtree`'s `listCollections()`
        // walk could not reach, because it was not under the user document.
        // That collection is gone: the rows live at `users/{uid}/devices` and
        // the generic subtree sweep removes them for free.
        //
        // With it goes the old ordering trap, which was the single clearest win
        // of nesting: "the device purge must precede the session teardown,
        // because the teardown clears the `uid` the purge queries on". There is
        // no purge left to order.
        //
        // Kept rather than deleted so the call site in `deleteAccount` keeps
        // documenting that device cleanup was CONSIDERED and is handled
        // elsewhere. Delete both together, or not at all.
        void uid;
    }
}
