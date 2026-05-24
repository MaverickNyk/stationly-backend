import { db } from '../config/firebase';

/**
 * Per-user FCM device-token registry.
 *
 * Why we need this: FCM messages can target a token (one device), a
 * topic (anyone subscribed), or a token list (multicast up to 500).
 * None of those are "send to user X". To support UID-based audiences
 * in NotificationService we need a UID → token list lookup, and the
 * only place to put it is Firestore (clients can't be queried directly
 * from the backend).
 *
 * Layout in Firestore:
 *   users/{uid}/fcm_tokens/{token}  ← doc id is the token itself
 *       {
 *         token: string,              ← redundant but lets us read just doc body
 *         createdAt:   Timestamp,
 *         updatedAt:   Timestamp,
 *         platform:    "android" | "ios" | "web" (optional),
 *         appVersion:  string?,
 *       }
 *
 * Using the token as the doc id gives us natural dedup: re-registering
 * the same token is a `set(merge=true)` no-op that just refreshes
 * `updatedAt`. Listing tokens for a user is a single subcollection
 * query.
 *
 * Tokens rotate (silently, by FCM, sometimes monthly) — the Android
 * client calls register on token rotation + on every cold launch so
 * stale tokens don't linger. We also prune any token an FCM
 * "registration-token-not-registered" error response cites; see the
 * dispatcher's failure handling for the cleanup path.
 */

export interface FcmTokenMeta {
    platform?: 'android' | 'ios' | 'web';
    appVersion?: string;
}

export class UserFcmTokenService {

    /**
     * Idempotent register. Use `set(merge=true)` so re-registering the
     * same token from the same UID is a cheap no-op that refreshes
     * the `updatedAt` watermark for future cleanup of stale tokens.
     */
    static async register(uid: string, token: string, meta?: FcmTokenMeta): Promise<void> {
        if (!uid || !token) throw new Error('uid and token are required');
        if (token.length < 20) throw new Error('Token looks malformed (too short)');

        const now = Date.now();
        await db
            .collection('users').doc(uid)
            .collection('fcm_tokens').doc(token)
            .set({
                token,
                updatedAt: now,
                createdAt: now,            // merge → keeps original on update
                platform: meta?.platform,
                appVersion: meta?.appVersion,
            }, { merge: true });
    }

    static async unregister(uid: string, token: string): Promise<void> {
        if (!uid || !token) return;
        await db
            .collection('users').doc(uid)
            .collection('fcm_tokens').doc(token)
            .delete()
            .catch(() => { /* already gone, fine */ });
    }

    /**
     * All currently-registered tokens for a user. Returns empty array
     * if user has no tokens or doesn't exist. Skips docs missing the
     * `token` field (corrupt write protection).
     */
    static async listForUid(uid: string): Promise<string[]> {
        if (!uid) return [];
        const snap = await db
            .collection('users').doc(uid)
            .collection('fcm_tokens')
            .get();
        return snap.docs
            .map(d => d.data()?.token as string)
            .filter((t): t is string => typeof t === 'string' && t.length > 20);
    }

    static async listForUids(uids: string[]): Promise<string[]> {
        if (!Array.isArray(uids) || uids.length === 0) return [];
        // Firestore won't let us batch-query subcollections by parent id,
        // so we fan out reads. Safe for small admin audiences (≤ a few
        // dozen UIDs). Larger segments should use the topic-based path
        // or a future denormalised top-level fcm_tokens collection.
        const all = await Promise.all(uids.map(u => this.listForUid(u)));
        return Array.from(new Set(all.flat()));
    }

    /**
     * Sweep tokens older than `staleMs` for a given uid. Called as
     * occasional housekeeping — tokens that have been rotated by FCM
     * client-side will stop being refreshed by the app's register call,
     * so their `updatedAt` falls behind. Default cutoff is 90 days,
     * matching FCM's own dormant-token threshold.
     */
    static async pruneStale(uid: string, staleMs: number = 90 * 24 * 60 * 60 * 1000): Promise<number> {
        const cutoff = Date.now() - staleMs;
        const snap = await db
            .collection('users').doc(uid)
            .collection('fcm_tokens')
            .where('updatedAt', '<', cutoff)
            .get();
        if (snap.empty) return 0;
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        return snap.size;
    }
}
