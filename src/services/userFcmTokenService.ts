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
     * Same spirit as LocalDbService's ephemeral `station_preds` cache:
     * freshness is enforced at READ time, so a stale entry is never served
     * past its TTL even before any sweep. A repeated `uid`-audience send or
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
        if (snap.empty) return 0;
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        this.invalidate(uid);
        return snap.size;
    }
}
