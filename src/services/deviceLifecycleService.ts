import { DeviceRegistryService } from './deviceRegistryService';
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

    /**
     * This device is now signed in as [uid].
     *
     * Only ever updates a device row that already exists — see
     * [DeviceRegistryService.bindUid] for why creating one here would poison the
     * broadcast audience with token-less Android phantoms.
     *
     * ## The re-bind case is the one that matters, and the client cannot fix it
     * `/device/register` resolves the uid from the bearer token, so an account
     * switch on the same phone SHOULD rewrite the row on the next foreground.
     * It does not: the client skips a POST whose body is unchanged since the
     * last one, and the uid is not in the body — it is derived server-side from
     * the header. Signing out of A and into B leaves every field the signature
     * covers identical, so the request is elided and the row goes on naming A.
     *
     * The account that is no longer signed in then keeps waking the phone with
     * its board changes, and `reason=deleted` on A would tear down B's session.
     * Binding at session start is the only point that reliably observes the
     * switch.
     */
    static async bind(uid: string, deviceId: string): Promise<void> {
        if (!uid || !deviceId) return;
        try {
            await DeviceRegistryService.bindUid(deviceId, uid);
        } catch (err) {
            console.error(`DEVICE_LIFECYCLE: ⚠️ bind failed for ${deviceId}`, err);
        }
    }

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

        // Independent, and independently failure-isolated: an FCM purge that
        // throws must not leave the device registry still pointing at an
        // account nobody is signed into, and neither may fail the logout.
        await Promise.all([
            this.releaseRegistry(uid, deviceId),
            this.releaseFcmTokens(uid, lastDeviceOut),
        ]);
    }

    private static async releaseRegistry(uid: string, deviceId?: string): Promise<void> {
        try {
            if (deviceId) await DeviceRegistryService.releaseUid(deviceId);
            // No device id means every session was just cleared, so every row
            // this account owns has to go with them.
            else await DeviceRegistryService.releaseAllForUid(uid);
        } catch (err) {
            console.error(`DEVICE_LIFECYCLE: ⚠️ registry release failed for ${uid}`, err);
        }
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
        if (!uid) return;
        try {
            const removed = await DeviceRegistryService.deleteAllForUid(uid);
            if (removed > 0) {
                console.log(`DEVICE_LIFECYCLE: 🧹 removed ${removed} device registry row(s) for ${uid}`);
            }
        } catch (err) {
            // Best-effort: a failure here must not abort a deletion the user
            // asked for and the rest of which has already happened.
            console.error(`DEVICE_LIFECYCLE: ⚠️ device registry purge failed for ${uid}`, err);
        }
    }
}
