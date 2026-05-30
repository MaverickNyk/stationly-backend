import { messaging } from '../config/firebase';
import { UserFcmTokenService } from './userFcmTokenService';

/**
 * Cross-device session sync via silent FCM data pushes.
 *
 * When a user's server-side state changes (stations added/removed,
 * display name updated, account deleted) we ping every device that
 * user is signed in on so they reconcile WITHOUT waiting for the next
 * cold launch. Otherwise device A keeps showing yesterday's board
 * after device B changed it.
 *
 * Wire format: a `data`-only FCM message with `{ type: "user_sync",
 * reason }`. There is deliberately NO `notification_payload` field —
 * the Android `FcmMessagingService` only renders a system
 * notification when that field is present, so `user_sync` stays
 * silent and just triggers a client-side reconcile.
 *
 *   reason = "stations"  → saved-stations list changed
 *   reason = "profile"   → display name (or other profile field) changed
 *   reason = "deleted"   → account deleted; client force-logs-out
 *
 * Fire-and-forget: callers wrap this in setImmediate so the user's
 * write returns immediately and a push failure never fails the request.
 */
export type UserSyncReason = 'stations' | 'profile' | 'deleted';

export class UserSyncNotifier {
    /**
     * Push a `user_sync` signal to all of the user's registered
     * devices. Swallows all errors (logged) — this is best-effort
     * convenience signalling, the foreground re-sync on the client is
     * the durable fallback.
     */
    static async notify(uid: string, reason: UserSyncReason): Promise<void> {
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

            console.log(`USER_SYNC: 📡 Pushed reason='${reason}' to ${tokens.length} device(s) for ${uid}`);
        } catch (err) {
            console.error(`USER_SYNC: ❌ Failed to notify ${uid} (reason=${reason})`, err);
        }
    }
}
