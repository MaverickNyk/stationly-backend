# Device Sessions, Subscription Ref-Counting, Auth & Rate Limiting

_Backend design notes. Introduced in commit `093ae98` (branch `dev_25Apr`)._

This document covers how the backend tracks **per-device login sessions**, how it
keeps the **`subscribed_stations` registry** (the list the Syncer polls) correct
across multi-device usage, and the **auth / rate-limit** model that protects user
data. Read this before touching `userService.ts`, `subscriptionService.ts`,
`authMiddleware.ts`, or `rateLimitMiddleware.ts`.

---

## 1. The data-storage philosophy (do not break)

Stationly's backend minimises Firestore reads/writes by keeping **Firestore as the
source of truth + a local SQLite mirror for hot-path reads**, kept in sync by
Firestore `onSnapshot` listeners:

- `api_keys` → SQLite mirror (`AuthMiddleware`), API-key validation is a **0-read**
  RAM-cache lookup.
- `metadata/subscribed_stations` → SQLite mirror (`SubscriptionService` +
  `LocalDbService`), so the **Syncer reads station subscriptions from SQLite**, never
  Firestore.

**Rule:** anything on a hot path (polled frequently, e.g. by the Syncer) must read
from the SQLite mirror. Per-user data (`users/{uid}`) is only read on **cold paths**
(login, logout, account changes, the debounced cross-device reconcile), so it stays
on Firestore and is not mirrored.

---

## 2. Per-device session model

Each user doc carries a **`sessions` map** keyed by a stable per-install `deviceId`
(generated client-side, sent on login/sync). `loggedIn` is a denormalised mirror of
"`sessions` is non-empty" (kept because Firestore can't query map-emptiness and it
gates `deleteAccount`).

```
users/{uid}
  loggedIn: boolean              // = sessions non-empty
  lastLoggedInTime: ISO          // aggregate "last sign-in on any device"
  sessions: {
    "<deviceId>": {              // one entry per signed-in device
      platform, osVersion, model, appVersion,   // DeviceInfo (client-supplied)
      firstSeen: ISO, lastSeen: ISO
    }
  }
  stations: SubscribedStation[]  // saved boards (kept across logout for re-login)
```

`lastLogoutTime` was **removed** — nothing read it, and per-device `lastSeen`
supersedes it.

### Lifecycle (`UserService`)

| Method | When | What it does |
|---|---|---|
| `startSession(uid, deviceId, deviceInfo?)` | login / profile sync | **Transaction:** prune stale sessions, add/refresh this device's entry, set `loggedIn=true`. Increments subscriptions only on the `loggedIn` **false→true** transition. |
| `endSession(uid, deviceId?)` | logout | **Transaction:** prune, remove this device (or all if no `deviceId`), recompute `loggedIn`. Decrements subscriptions only on the **true→false** transition (last device out). |
| `createOrUpdateUser(..., deviceId?, deviceInfo?)` | login / sync | New user: seeds `sessions`. Existing: writes profile fields, then calls `startSession`. |
| `logOut(uid, deviceId?)` | `POST /user/logout` | Delegates to `endSession`. |
| `deleteAccount(uid)` | `POST /user/delete-account` | Sends `user_sync` `deleted` push, then `endSession(uid)` (releases subscriptions safely), then deletes the doc + Firebase Auth user. |

### Stale-session pruning (TTL)

`pruneStaleSessions` drops sessions whose `lastSeen` is older than
`SESSION_TTL_MS` (**90 days**), inside the same transaction as start/end. This
reclaims sessions orphaned by reinstalls/uninstalls that never logged out.
**Limitation:** a fully-abandoned logged-in user (never logs in/out again) keeps
their entry until a future **sweep cron** runs it — see §6.

---

## 3. Subscription ref-counting (`subscribed_stations`)

`metadata/subscribed_stations.stationCounts` maps `naptanId → count`, where count =
**number of users who have the station saved AND have ≥1 active device session.**
The Syncer polls exactly the stations with count > 0.

### The safety invariant (critical)

> A station is removed from the registry **only when its total count across all
> users reaches 0.** Each user contributes **+1** per saved station while active and
> releases it **exactly once** when they go fully inactive. Never over-decrement.

This is enforced by gating every increment/decrement on the **`loggedIn` flag
transition inside a Firestore transaction** (`startSession`/`endSession`):

- **first device logs in** (`false→true`) → +1 each saved station
- **additional devices log in** → no change (already counted)
- **one of several devices logs out** → no change (still active elsewhere)
- **last device logs out** (`true→false`) → −1 each saved station
- **station added/removed while logged in** → `addStation`/`removeStation`/`syncStations`
  apply the diff (±1 for the changed station)
- **account deleted** → `endSession` releases once (transaction-safe), then doc deleted

`SubscriptionService.updateCount` floors at 0 and deletes the key only at 0, then the
`onSnapshot` listener rebuilds the in-memory set and `LocalDbService`
`DELETE`s the SQLite row.

### Why it's safe in every case

- **Retries / double-calls** (e.g. logout fired twice, delete retried): gated on the
  stored `loggedIn` flag, so the second call is a no-op.
- **Concurrent multi-device login/logout:** the Firestore transaction serialises them,
  so the transition fires exactly once.
- **`deleteAccount` racing a logout on another device:** both go through the
  transactional, `loggedIn`-gated path → exactly one decrement. (Before `093ae98`,
  `deleteAccount` used a plain loop and could double-decrement, cutting other users
  off — fixed.)
- **Crash between the session write and the `setImmediate` count update:** the
  decrement is lost → the station stays counted (**over**-count). This is the *safe*
  direction — a station is polled slightly longer, nobody is cut off.

**Every failure mode errs toward over-counting, never under-counting.**

---

## 4. Cross-device sync push (`UserSyncNotifier`)

When a user's server-side state changes, the backend sends a **silent, uid-targeted
`user_sync` FCM data message** to all the user's registered device tokens so other
devices reconcile without waiting for a cold launch.

- Wire format: `data = { type: "user_sync", reason, uid, ts }` — **no
  `notification_payload`**, so the client renders no notification; it just triggers a
  client-side fetch (trigger-then-fetch, not push-the-data).
- `reason ∈ { "stations", "profile", "deleted" }`.
- Targets `UserFcmTokenService.listForUid(uid)`; multicasts in ≤500 chunks; prunes any
  token FCM reports as `registration-token-not-registered`.
- Sent from: `syncStations` / `addStation` / `removeStation` (`stations`),
  `createOrUpdateUser` on a real display-name change (`profile`), and `deleteAccount`
  (`deleted`, **before** the doc/tokens are deleted).

The client verifies `uid` matches the signed-in user before acting (a token can
linger on a device that has since switched accounts). See the StationlyUI doc.

> **Prerequisite:** the device's FCM token must be registered under the account.
> The client registers it **on login** (not just app launch) — see the UI doc.

---

## 5. Auth & rate limiting

### IDOR protection (`authMiddleware.validateUserToken`)

The authoritative uid is always `decodedToken.uid`. The middleware rejects (403) any
request whose `req.params.uid || req.body.uid || req.query.uid` differs. (The
`query.uid` check was added in `093ae98` — `GET /user/sync/profile?uid=` was
previously an IDOR.) `GET /sdui/app/profile/:uid` is now gated by `validateUserToken`.

### Rate limiting per-UID (`rateLimitMiddleware`)

`keyByUidOrIp` keys limiters by **Firebase UID** when authenticated, else by **IP**.
We deliberately do **not** key by `X-Stationly-Key`: every app install ships the same
client key, so keying by it created a single **global bucket** shared by all users —
one device could rate-limit everyone, and normal traffic tripped the strict
`/user/*` limiter (the source of widespread 429s, incl. on `fcm/register`).

| Limiter | Window | Max | Key |
|---|---|---|---|
| `modes`/`lines`/`stations`/`sdui` | 15 min | 300 | uid → else IP |
| `strict` (`/user/*`) | 15 min | **60** | uid → else IP |
| `developer` | 1 min | 60 | uid → else IP |
| `verifyEmail` | 15 min | 5 | uid |
| `forgotPassword` | 15 min | 3 | email |

`validateUserToken` runs before the `/user` strict limiter so `req.user.uid` is set
when it keys.

---

## 6. Known gaps / future work

- **Abandoned-session sweep cron** — prune sessions older than the TTL across all
  users (and decrement on any that empty a user's map), to reclaim counts held by
  users who never return. Lazy prune only fires on that user's own next login/logout.
- **Count-drift reconciliation cron** — periodically recompute `stationCounts` from
  `users` (sum over logged-in users' saved stations) and rewrite the registry. This
  self-heals any drift from a lost `setImmediate` and is the standard derived-counter
  safety net. (Recommended before scale; also repairs historical drift.)
- **Instant revocation** — `verifyIdToken` does not pass `checkRevoked`, and nothing
  calls `revokeRefreshTokens`. A deleted/disabled user's ID token is accepted for up to
  ~1h. For instant server-side "sign out everywhere", add `revokeRefreshTokens(uid)`
  and `checkRevoked` on sensitive writes (and handle the resulting 401 client-side).
- **Login cold-path cost** — login does `get` + `update` (profile) + a `startSession`
  transaction (read+write). Acceptable on a cold path; could be folded into one
  transaction if needed, at the cost of coupling profile + session writes.
