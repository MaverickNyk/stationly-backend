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

/** Result shape that surfaces whether a read was served from cache. */
export interface TokenReadResult {
    tokens: string[];
    /** True when served from the in-memory cache (zero Firestore reads). */
    cached: boolean;
}

export class UserFcmTokenService {

    /**
     * Per-uid in-memory token cache — the minimal-read tier for the ONE
     * collection that isn't replicated into SQLite (fcm_tokens is per-user
     * subcollection data, not global metadata, so it stays out of the
     * DataCacheService master→slave replication).
     *
     * Same spirit as the shared PredictionCache: freshness is enforced at
     * READ time, so a stale entry is never served past its TTL even before
     * any sweep. A repeated `uid`-audience send or
     * an admin token-count lookup for the same uid within the TTL costs
     * ZERO Firestore reads. Writes (register/unregister) invalidate the
     * uid's entry so the cache can't serve a list that's missing a freshly
     * added token or still holding a removed one.
     *
     * Process-local (not cross-instance): on a multi-instance deploy each
     * worker keeps its own cache, bounded by the TTL. That's fine — token
     * lists are advisory (FCM prunes dead tokens, the app re-registers on
     * every cold launch), and the admin lookup is informational.
     */
    private static cache = new Map<string, { tokens: string[]; at: number }>();
    private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

    private static invalidate(uid: string): void {
        this.cache.delete(uid);
    }

    /**
     * Idempotent register. Use `set(merge=true)` so re-registering the
     * same token from the same UID is a cheap no-op that refreshes
     * the `updatedAt` watermark for future cleanup of stale tokens.
     */
    static async register(uid: string, token: string, meta?: FcmTokenMeta): Promise<void> {
        if (!uid || !token) throw new Error('uid and token are required');
        if (token.length < 20) throw new Error('Token looks malformed (too short)');

        const now = Date.now();
        const doc: Record<string, unknown> = {
            token,
            updatedAt: now,
            createdAt: now,            // merge → keeps original on update
        };
        // Assigned only when present. Firestore REJECTS `undefined` anywhere in
        // a write (the Admin SDK is initialised without
        // `ignoreUndefinedProperties`), so spreading the optional metadata in
        // unconditionally turned a request that merely omitted `appVersion`
        // into a 500 on a path whose whole job is to be a cheap idempotent
        // no-op. Today's clients always send the key — a curl, a new platform,
        // or a client configured to drop nulls would not.
        if (meta?.platform !== undefined) doc.platform = meta.platform;
        if (meta?.appVersion !== undefined) doc.appVersion = meta.appVersion;

        await db
            .collection('users').doc(uid)
            .collection('fcm_tokens').doc(token)
            .set(doc, { merge: true });
        // Drop the cached list so the next read reflects this token.
        this.invalidate(uid);
    }

    static async unregister(uid: string, token: string): Promise<void> {
        if (!uid || !token) return;
        await db
            .collection('users').doc(uid)
            .collection('fcm_tokens').doc(token)
            .delete()
            .catch(() => { /* already gone, fine */ });
        this.invalidate(uid);
    }

    /**
     * Cache-first read of a uid's tokens. Serves from the in-memory cache
     * when the entry is younger than `maxAgeMs` (default TTL); otherwise
     * does ONE subcollection query and repopulates. Pass `bypassCache` to
     * force a fresh read (admin "refresh" action).
     */
    private static async readForUid(
        uid: string,
        opts?: { bypassCache?: boolean; maxAgeMs?: number },
    ): Promise<TokenReadResult> {
        if (!uid) return { tokens: [], cached: false };

        const maxAge = opts?.maxAgeMs ?? this.CACHE_TTL_MS;
        if (!opts?.bypassCache) {
            const hit = this.cache.get(uid);
            if (hit && Date.now() - hit.at < maxAge) {
                return { tokens: hit.tokens, cached: true };
            }
        }

        const snap = await db
            .collection('users').doc(uid)
            .collection('fcm_tokens')
            .get();
        const tokens = snap.docs
            .map(d => d.data()?.token as string)
            .filter((t): t is string => typeof t === 'string' && t.length > 20);

        this.cache.set(uid, { tokens, at: Date.now() });
        return { tokens, cached: false };
    }

    /**
     * All currently-registered tokens for a user. Returns empty array
     * if user has no tokens or doesn't exist. Cache-first (see readForUid).
     */
    static async listForUid(
        uid: string,
        opts?: { bypassCache?: boolean; maxAgeMs?: number },
    ): Promise<string[]> {
        return (await this.readForUid(uid, opts)).tokens;
    }

    /**
     * Token COUNT for a uid — for the admin audience-lookup screen. Never
     * returns the raw token strings (they're sensitive identifiers; the
     * admin SendResult invariant keeps them out of responses, and so do we
     * here). Reports whether the count came from cache so the UI can show
     * a "live vs cached" hint.
     */
    static async countForUid(
        uid: string,
        opts?: { bypassCache?: boolean },
    ): Promise<{ uid: string; count: number; cached: boolean }> {
        const { tokens, cached } = await this.readForUid(uid, opts);
        return { uid, count: tokens.length, cached };
    }

    static async listForUids(uids: string[]): Promise<string[]> {
        if (!Array.isArray(uids) || uids.length === 0) return [];
        // Firestore won't let us batch-query subcollections by parent id,
        // so we fan out reads. Each per-uid read is cache-first, so a repeat
        // segment within the TTL costs zero reads. Safe for small admin
        // audiences (≤ a few dozen UIDs).
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
        return this.deleteDocs(uid, snap);
    }

    /**
     * Forget EVERY token this account has — the last device has signed out, or
     * the account is being deleted.
     *
     * ## Why the whole set, and why the backend has to do it
     * These documents are keyed by the TOKEN, so there is no way to ask "which
     * of these belongs to the device that just logged out": `/user/fcm/register`
     * carries no device id (see the Android client's `FcmTokenRegistrar`), and
     * adding one cannot help the builds already installed. What the backend
     * *can* say with certainty is that when the last session ends, NO device is
     * signed in — so none of these tokens should be in a `uid` audience.
     *
     * ## This is a backstop, not the primary path
     * Android's `FirebaseAuthManager.logout()` already unregisters its own token
     * inline — but under a 3 s timeout, best-effort, racing the sign-out. When
     * that times out the token survives, and a signed-out phone goes on
     * receiving that account's `user_sync` pushes, including `reason=deleted`.
     * (`FcmTokenRegistrar.unregister` is a second, unused helper for the same
     * job; nothing calls it. It is redundant, not the gap.)
     *
     * Safe to be aggressive: every client re-registers its token on the next
     * cold launch AND immediately after sign-in, and Android's logout clears the
     * `StationlyPrefs` watermark that would otherwise short-circuit that
     * re-registration — so a user signing back in is whole again within one
     * login. The pushes this gates are best-effort convenience signalling with a
     * foreground reconcile behind them.
     */
    static async purgeAllForUid(uid: string): Promise<number> {
        if (!uid) return 0;
        const snap = await db
            .collection('users').doc(uid)
            .collection('fcm_tokens')
            .get();
        return this.deleteDocs(uid, snap);
    }

    /** Batch-delete a token query's results and invalidate the uid's cache. */
    private static async deleteDocs(
        uid: string,
        snap: FirebaseFirestore.QuerySnapshot,
    ): Promise<number> {
        if (snap.empty) return 0;
        // Batches cap at 500 writes. A single account will never approach that,
        // but the cap is a hard error rather than a truncation, so the chunking
        // costs one loop and removes the failure mode entirely.
        for (let i = 0; i < snap.docs.length; i += 500) {
            const batch = db.batch();
            snap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
        this.invalidate(uid);
        return snap.size;
    }
}
