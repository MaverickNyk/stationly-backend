import { messaging } from '../config/firebase';
import { UserFcmTokenService } from './userFcmTokenService';
import { DevicePushService } from './devicePushService';

/**
 * Cross-device session sync, on every platform.
 *
 * When a user's server-side state changes (stations added/removed,
 * display name updated, account deleted) we ping every device that
 * user is signed in on so they reconcile WITHOUT waiting for the next
 * cold launch. Otherwise device A keeps showing yesterday's board
 * after device B changed it.
 *
 *   reason = "stations"    → LEGACY saved-stations list changed (Android's)
 *   reason = "boards"      → v2 saved-boards list changed (iOS's)
 *   reason = "profile"     → display name (or other profile field) changed
 *   reason = "deleted"     → account deleted; client force-logs-out
 *
 * The two list reasons are distinct because the two lists are, and a client
 * that reconciles the wrong one does nothing at all — visibly, since the board
 * it was told about never appears. A client that does not recognise a reason
 * falls back to a full reconcile, which is correct for all of them and merely
 * does more work than the reason asked for.
 *
 * ## Two transports, one signal
 * This used to be FCM-only, which quietly meant Android-only: an iPhone got no
 * `user_sync` at all and stayed on stale account state until its next cold
 * launch. Since iOS dropped FirebaseMessaging that is no longer even
 * theoretically fixable by adding a token — so the signal now fans out over
 * BOTH transports:
 *
 *   - **FCM** to `users/{uid}/fcm_tokens` — Android, unchanged, still
 *     `{ type: "user_sync", reason }` so existing clients need no update.
 *   - **APNs** to the device registry, via [DevicePushService] — iOS, using the
 *     shared envelope vocabulary (`PushEnvelope` in commonMain).
 *
 * Both carry the same fields and mean the same thing; only the pipe differs.
 * A device registered in both places (it should not be) would reconcile twice,
 * which is idempotent.
 *
 * Note this is deliberately unlike the `Station_*` / `LineStatus_*` topics,
 * which stay Android-only on purpose: those fire every minute or ten and would
 * exhaust the iOS widget's reload quota. `user_sync` fires when a human changes
 * something, which is rare enough to be safe everywhere.
 *
 * Fire-and-forget: callers wrap this in setImmediate so the user's
 * write returns immediately and a push failure never fails the request.
 */
export type UserSyncReason = 'stations' | 'boards' | 'profile' | 'deleted';

/** Options for [UserSyncNotifier.notify]. */
export interface UserSyncOptions {
    /**
     * The device that made the change, so it is not woken by its own write.
     *
     * ## Only the APNs half can honour it
     * The device registry is keyed by device id, so excluding one is a filter on
     * the resolved audience. `fcm_tokens` is keyed by the TOKEN and carries no
     * device id — `/user/fcm/register` never sent one, and the Android builds
     * already installed never will — so on that transport the sender cannot be
     * identified, let alone skipped. Android clients already guard on the `uid`
     * in the payload, and a self-directed reconcile is idempotent; it is waste,
     * not breakage.
     *
     * Optional throughout: a caller that does not know which device it was gets
     * exactly the previous behaviour.
     */
    excludeDeviceId?: string;
}

export class UserSyncNotifier {
    /**
     * Push a `user_sync` signal to all of the user's registered
     * devices. Swallows all errors (logged) — this is best-effort
     * convenience signalling, the foreground re-sync on the client is
     * the durable fallback.
     */
    static async notify(uid: string, reason: UserSyncReason, opts?: UserSyncOptions): Promise<void> {
        // Both transports, independently: a failure or an empty audience on one
        // must not stop the other. Historically the FCM path returning early on
        // "no tokens" is exactly what would have skipped every iOS device.
        await Promise.all([
            this.notifyFcm(uid, reason),
            this.notifyApns(uid, reason, opts?.excludeDeviceId),
        ]);
    }

    /** iOS (and anything else in the device registry), over APNs. */
    private static async notifyApns(
        uid: string,
        reason: UserSyncReason,
        excludeDeviceId?: string,
    ): Promise<void> {
        try {
            const outcome = await DevicePushService.send({
                kind: 'user.sync',
                uid,
                reason,
                excludeDeviceId,
            });
            if (outcome.devicesTargeted > 0) {
                console.log(
                    `USER_SYNC: 📡 APNs reason='${reason}' → ${outcome.delivered}/${outcome.devicesTargeted} device(s) for ${uid}`,
                );
            }
        } catch (err) {
            console.error(`USER_SYNC: ❌ APNs notify failed for ${uid} (reason=${reason})`, err);
        }
    }

    /** Android, over FCM. Wire format unchanged — existing clients keep working. */
    private static async notifyFcm(uid: string, reason: UserSyncReason): Promise<void> {
        try {
            const tokens = await UserFcmTokenService.listForUid(uid);
            if (tokens.length === 0) return;

            const data: Record<string, string> = {
                type: 'user_sync',
                reason,
                // Target uid so the client can verify the push is for the
                // currently signed-in user before acting — an FCM token may
                // linger on a device that's since signed in as someone else.
                uid,
                ts: Date.now().toString(),
            };

            // FCM multicast caps at 500 tokens. A single user realistically
            // has a handful of devices, but chunk defensively anyway.
            for (let i = 0; i < tokens.length; i += 500) {
                const batch = tokens.slice(i, i + 500);
                const response = await messaging.sendEachForMulticast({
                    tokens: batch,
                    data,
                    android: { priority: 'high' },
                });

                // Prune tokens FCM reports as permanently dead so the
                // registry doesn't accumulate ghosts. Matches the
                // housekeeping convention in UserFcmTokenService.
                if (response.failureCount > 0) {
                    response.responses.forEach((r, idx) => {
                        const code = r.error?.code;
                        if (
                            code === 'messaging/registration-token-not-registered' ||
                            code === 'messaging/invalid-registration-token'
                        ) {
                            UserFcmTokenService.unregister(uid, batch[idx]).catch(() => {});
                        }
                    });
                }
            }

            console.log(`USER_SYNC: 📡 FCM reason='${reason}' to ${tokens.length} device(s) for ${uid}`);
        } catch (err) {
            console.error(`USER_SYNC: ❌ Failed to notify ${uid} (reason=${reason})`, err);
        }
    }
}
