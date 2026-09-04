# Device identity, sessions and push audiences — handover

_Backend only (`stationly-backend`, branch `dev_13Jul`). No client change in this
work, and none required to deploy it. Session 2026-08-13, continuing the device
registry thread opened in `StationlyUI/docs/SESSION_2026-08-12_SYNC_AND_IDENTITY.md` §13.4/§14._

---

## 0. Read this first

Four bugs, all live on staging, all in the same place: **the three stores that
each record which account a device belongs to, maintained by code that had never
been reconciled.**

1. **Every disruption push has been delivering to nobody.** The `lines` field the
   client sends to `/device/register` was never read by the controller, so the
   audience query it feeds matched zero devices — and reported success. §2
2. **Logout left a phone in its old account's push audience.** §3
3. **The orphan-account sweep kept a bug that `deleteAccount` had already been
   fixed for** — it purged one named subcollection and missed `fcm_tokens`. §4
4. **A session write could 500 the login** on a `undefined` Firestore value. §5

The unification proposed in §14 of the iOS handover — one device record under
`users/{uid}/devices/{deviceId}` — **cannot be built from the backend alone.**
Two hard constraints kill it, both documented in §7. What landed instead unifies
the device *lifecycle* behind one service while leaving the storage where it is.

**Android compatibility was a hard requirement and is preserved in full.** Every
request and response shape Android sends or reads is unchanged; see §8 for the
endpoint-by-endpoint audit.

Verified: `tsc --noEmit` clean, `npm test` **55/55** (47 pre-existing + 8 new).

---

## 1. The shape of the problem

A *device belonging to a user* is recorded in three places:

| Store | Keyed by | Written by |
|---|---|---|
| `users/{uid}.sessions[deviceId]` | deviceId | `UserService.startSession` / `endSession` |
| `devices/{deviceId}.uid` (root) | deviceId | `/device/register` |
| `users/{uid}/fcm_tokens/{token}` | **the token** | `/user/fcm/register` |

No single fact is wrong in any of them. The problem is that **"this device now
belongs to X" had three implementations**, so a fix applied to one was silently
absent from the others — which is the literal history of §3 and §4 below.

---

## 2. `lines` was dropped on the floor — disruption pushes reached nobody

### The bug
`DevicePushController.register` destructured
`{ deviceId, widgetToken, appToken, environment, iosVersion, appVersion, stations }`.
There is no `lines` in that list, and no `lines` anywhere else in the file. The
client has always sent it (`DevicePushCoordinator.register` posts
`"lines": tracked.lines`), and `DeviceRegistryService.register` has always
accepted it — so every row in `devices` was written with `lines: []`.

### Why that is not cosmetic
TfL reports disruption **by line**, so `DisruptionTriggerService` scopes its
pushes through `DevicePushService.send({ lines })` →
`DeviceRegistryService.listForLines`, which is an `array-contains-any` over
exactly that field. Against an empty array it matches nothing:

- the audience resolved to **zero devices**,
- `send` returned a successful outcome with `devicesTargeted: 0`,
- and `UserSyncNotifier`-style logging only prints when `devicesTargeted > 0`.

So the automatic disruption push — the entire feature — delivered to nobody,
with no error anywhere. The registry's own doc comment warned about this precise
failure mode. The warning was written; the wiring was not.

### Fix
`lines` is destructured and forwarded, through a shared `asStringList` helper
that both scoping arrays now use — they are written straight into documents that
audience queries run against, so a stray non-string is a row that silently never
matches.

⚠️ **Deploying this fixes the audience but not the index.** `listForLines` needs
a Firestore index on `devices.lines`; it has never been exercised against
non-empty data, so confirm the query actually returns rows on staging before
declaring the feature working.

---

## 3. Logout did not deactivate the device (§13.4)

`UserService.logOut` called `endSession` and nothing else. `endSession` cleared
the `sessions` map — and only that. So after signing out:

- `devices/{deviceId}.uid` still named the account, so `listForUid` still found
  the phone and `user.sync` over APNs still reached it, **including
  `reason=deleted`**, which tells a client to tear its session down;
- the FCM token document was still filed under the account.

Intended behaviour has always been that a logged-out device is inactive.

### Fix — `DeviceLifecycleService`
New `src/services/deviceLifecycleService.ts` owns the fan-out, so the three
stores can no longer drift:

```
bind(uid, deviceId)                          → session start
release(uid, deviceId?, lastDeviceOut)       → logout
purgeForUid(uid)                             → account deletion
```

`endSession` now awaits `release(...)`, passing the logged-in → logged-out
transition **computed inside its own transaction**.

Two asymmetries that are deliberate, and load-bearing:

- **The registry is released per device.** That store is keyed by deviceId, so
  the phone that left is always identifiable.
- **The FCM purge is all-or-nothing, and only on the last device out.**
  `fcm_tokens` is keyed by the token; `/user/fcm/register` carries no device id
  and the installed Android builds never will, so the backend cannot attribute a
  token document to a device. What it *can* say with certainty is that when the
  last session ends, no device is signed in. Purging on any single logout would
  silently mute push on the user's other phones.

`release` is **awaited**, unlike the subscription delta: `logOut`'s 200 is read
by the client as "this device is signed out everywhere that matters", and
returning early leaves a window in which the phone can still be woken by the
account it just left.

### `bind` is what makes it recoverable — and it fixes account-switching too
`/device/register` resolves the uid from the bearer token, so an account switch
*should* rewrite the row on the next foreground. It does not: the client skips a
POST whose body is unchanged, and **the uid is not in the body** — it is derived
server-side from the header. Signing out of A and into B leaves every field the
client's signature covers identical, so the request is elided and the row goes on
naming A.

That was already a bug (A's board changes wake B's phone; A's deletion signs B
out). It also means the release in §3 would never be undone. `bind` on session
start is the only point that reliably observes the switch, so both directions are
now correct.

Wired at both session entry points — `startSession` (gated on the same "something
actually changed" answer that gates the session write, so a plain re-open stays
free) and the new-account branch of `createOrUpdateUser`, which seeds `sessions`
directly and would otherwise miss it.

---

## 4. The orphan sweep kept a bug `deleteAccount` had already been fixed for

`purgeOrphanDocsForEmail` deleted `doc.ref.collection('activity')` — one
subcollection, named explicitly — and then the document. `deleteAccount` had
exactly that bug, was fixed by enumerating subcollections with `listCollections()`,
and the sweep was never updated. So an orphaned account kept its `fcm_tokens`: a
push token surviving under a uid with no auth user behind it, still resolvable by
a uid-targeted send.

### Fix
Both call sites now share `purgeUserSubtree(userRef, uid)`, which enumerates
subcollections rather than naming them **and** purges the root `devices` rows the
enumeration cannot reach. This is the same rule stated once instead of twice, so
a subcollection added later is swept by something that already exists.

### ⚠️ An ordering trap this introduced, and how it is resolved
`endSession` now *releases* the account's device rows — it clears the `uid` that
`deleteAllForUid` queries on. Purging after it would match nothing and leave a
row per device behind. So in `deleteAccount` the device purge runs **before** the
session teardown, and the device half of `purgeUserSubtree` is a harmless no-op
by the time it runs. Both comments say so at the point of use. **Do not reorder
these.**

---

## 5. A `undefined` could 500 the login

Firestore rejects `undefined` anywhere in a write, and the Admin SDK here is
initialised **without** `ignoreUndefinedProperties` (`src/config/firebase.ts`).

- `buildSessionEntry` returned `{ platform, osVersion, model, appVersion }` from
  `info?.x ?? existing?.x`. A client sending a `deviceId` with no `deviceInfo` —
  the field is optional on the wire and defaults to null on both clients —
  produced four undefined values inside the session transaction and threw. That
  is the **login path**: the whole sign-in would 500 on metadata nothing reads.
- `UserFcmTokenService.register` spread `platform`/`appVersion` in
  unconditionally, so a request that merely omitted `appVersion` 500'd an
  endpoint whose entire contract is "cheap idempotent no-op".

Both now omit absent fields. The session path reuses the existing
`stripUndefined`, which was written for this exact hazard on the boards path and
had simply never been applied here. `platform` is additionally narrowed to the
values the schema documents, so an unexpected string cannot quietly become a
category in the admin breakdown.

**Latency, not luck, is why this had not fired:** today's clients always send the
keys. A curl, a new platform, or a client configured to drop nulls would have
found it.

---

## 5b. Second review pass — a race, and two silent failures

Found on a second read of the finished diff, not in the original hunt.

### The transaction callbacks were not idempotent (pre-existing, now fixed)
`startSession` and `endSession` declare their result flags **outside**
`runTransaction` and only ever set them to `true`. Firestore **retries** that
callback on contention, so a retry permanently inherits the first attempt's
answer:

- attempt 1 reads `loggedIn: false` → sets `didActivate`
- another device wins the race
- attempt 2 reads `loggedIn: true` and correctly decides not to activate
- `didActivate` is still `true` → **both devices increment**, and every saved
  station on the account is counted twice for one logical activation

An inflated count is not self-correcting: `SubscriptionService.updateCount`
releases a station only at 0, so it stays in the registry and the Syncer polls
TfL for it forever. `endSession` has the mirror image, and that direction is
worse — a spurious decrement can push a station below what OTHER users
contribute and cut them off, which is the exact hazard `deleteAccount`'s comment
already warns about.

Fixed by resetting the flags at the top of every attempt. Idempotence is
Firestore's stated contract for a transaction callback, not a nicety.

### `bindUid` / `releaseUid` swallowed every error
Both were written `.catch(() => {})` because `update()` on a missing row is the
normal Android case. That also absorbed permission errors, quota rejections and
outages — push targeting could stop being maintained with no trace anywhere.
Now `swallowMissingDoc` swallows gRPC `NOT_FOUND` (5) and rethrows the rest, so
`DeviceLifecycleService`'s handlers actually log something.

### `/device/register` forwarded unvalidated body fields
`widgetToken`, `appToken`, `iosVersion`, `appVersion` went from an `any` body
straight into Firestore and, for the tokens, on to the APNs client. A non-string
token stored fine and failed later as a delivery error on a device that looked
correctly registered. All four now go through `asString`, and the
presence check runs on the **normalised** values so a malformed token is a 400
rather than a 500 from the service's own identical check.

---

## 5c. Observed on staging, NOT changed

Two things worth a decision, deliberately left alone because both touch the
subscription ref-count that §7 says must not be folded into this pass.

1. **`loggedIn: true` with an empty `sessions` map.** `createOrUpdateUser`'s
   new-account branch writes `sessions: deviceId ? {…} : {}` and
   `loggedIn: true` unconditionally — so a signup that sends no deviceId breaks
   the stated invariant ("`loggedIn` means ≥1 active session") at creation.
   `caramcavinchey@gmail.com` is in exactly that state on staging. It is
   self-consistent in practice (a later logout still computes
   `prevLoggedIn && !nowLoggedIn` and releases the hold), and both clients send
   a deviceId today, so this is a legacy artefact rather than a live bug.
2. **`/device/unregister` has no ownership check.** It is API-key-only by the
   same design that keeps `/device/register` reachable when signed out, so any
   holder of the app key can delete any device's registration given its id. Ids
   are random UUIDs, so this is not enumerable, but there is no check that the
   caller owns the row. Fixing it properly means letting a signed-in caller prove
   ownership while still allowing the signed-out case — a real design decision,
   not a patch.

---

## 6. Performance and cleanliness

| Change | Why |
|---|---|
| `listForStations` / `listForLines` collapsed onto one `listWhereArrayContains` helper, chunks now run **concurrently** | They differed only in the field name; the 30-value chunking and dedup map were duplicated verbatim. A mode-wide incident naming 90 lines was three **sequential** round trips on the path that fires while a disruption is unfolding. |
| `pruneToken` scans both token fields concurrently | Independent queries, run per dead token in the post-broadcast sweep. |
| `applySubscriptionDelta` parallel within each group | Ids are distinct by construction (both sides are Sets), so no two operations touch the same row — the sequential await bought only latency. Groups stay ordered: release before re-acquire, so a replaced board never reads as a higher count than the truth. Both groups now log on failure instead of rejecting unobserved inside `setImmediate`. |
| `UserFcmTokenService.deleteDocs` shared by `pruneStale` and `purgeAllForUid`, chunked at 500 | Firestore's batch cap is a hard error, not a truncation. |
| `RegisteredDevice.uid` documented as *absent* rather than null | `listForUid` filters on equality; a row that lacks the field matches no account. `releaseUid` uses `FieldValue.delete()` for that reason. |

### Echo suppression (`excludeDeviceId`) — server half only
`UserSyncNotifier.notify` fanned out to **every** device including the sender, so
the phone that just saved a board was woken by its own write and answered with a
`getUserProfile` read of state it already had — a self-inflicted push and read per
edit, on the hottest document in the system (the iOS handover §2 called this out).

`notify(uid, reason, { excludeDeviceId })` now filters the APNs audience.
`/user/sync/boards` and `/user/sync/stations` read an **optional** `deviceId` from
the body to supply it.

- **Absent on every build shipped so far, and absent is exactly the previous
  behaviour.** This lands the server side of a back-compatible contract so the
  client change is a one-line addition later.
- Only APNs can honour it. FCM tokens carry no device id, so the sender cannot be
  identified there. Android already guards on the payload `uid` and a
  self-directed reconcile is idempotent — waste, not breakage.
- The field is advisory and never authorises anything, so reading it unverified
  from the body is correct: the worst a client can do by lying is deny itself a
  push it did not need.

---

## 7. Why §14's unification was NOT built

The target shape in the iOS handover was one record per device under its owner:
`users/{uid}/devices/{deviceId}`. Two independent constraints make that
unreachable from the backend:

1. **A device does not always have an owner.** `/device/register` is API-key-only
   by deliberate design (`apiRoutes.ts` mounts it *before* the `/user/*` auth
   middleware, with a comment recording that gating it on a user token 401'd the
   first real on-device registration). A signed-out phone still runs widgets and
   still wants disruption pushes. A subcollection under `users/{uid}` has nowhere
   to put a device with no uid.
2. **`fcm_tokens` cannot be re-keyed by device.** `/user/fcm/register` carries no
   device id, and the Android builds already installed never will. No backend
   change can map a token to a device for any client in the field.

Root `devices/{deviceId}` is therefore not a wart to be migrated away — it is the
only keying that satisfies (1), and keying by device identity is already what
makes token rotation an update rather than an accumulation.

**So the lifecycle was unified instead of the storage.** §14's rule 1 ("one
entity, one record, keyed by its own identity") is satisfied where it can be;
what actually produced every bug — three independent implementations of one fact
— is gone.

### What is still worth doing, and what it needs
- **Collapsing `fcm_tokens` into the device record** requires shipping a client
  that sends `deviceId` on `/user/fcm/register`, then a dual-read window, then a
  backfill. Not a backend-only task.
- **Moving `sessions` off the user document** is possible but must not be folded
  into the same pass: `loggedIn` gates `endSession`'s transaction so subscription
  counts cannot double-decrement, and that transaction currently reads one
  document. The iOS handover says the same, and it is still right.

---

## 8. Android compatibility audit

Android and iOS share `core/service/SduiApiService`, so this is the complete
surface. Every shape below is byte-identical to before.

| Endpoint | Request | Response | Verdict |
|---|---|---|---|
| `POST /user/sync/profile` | unchanged | unchanged | ✅ `buildSessionEntry` is strictly more permissive; `bind` is a no-op (Android has no `devices` row) |
| `GET /user/sync/profile?uid=` | — | unchanged | ✅ untouched |
| `POST /user/sync/stations` | now *also* reads optional `deviceId`; Android omits it | `{success, count}` unchanged | ✅ absent ⇒ previous behaviour exactly |
| `POST /user/sync/boards` | same | unchanged | ✅ Android does not call it yet |
| `POST /user/logout` | `{uid, deviceId}` unchanged | `{success:true}` unchanged | ⚠️ behaviour change — see below |
| `POST /user/delete-account` | unchanged | unchanged | ✅ ordering fixed internally |
| `POST /user/fcm/register` | `{token, platform, appVersion}` unchanged | unchanged | ✅ strictly more tolerant |
| `POST /user/fcm/unregister` | unchanged | unchanged | ✅ untouched |
| FCM `user_sync` payload | `{type, reason, uid, ts}` unchanged | — | ✅ wire format explicitly preserved |
| `POST /device/register` | now reads `lines` the client already sends | unchanged | ✅ iOS-only; Android never calls it |

### The one behaviour change, and why it is safe on Android
`/user/logout` now purges the account's FCM tokens **when the last device signs
out**. Traced end to end on the Android client:

1. `FirebaseAuthManager.logout()` already unregisters this device's token inline
   (best-effort, 3 s timeout) — so the backend purge is a **backstop for the
   timeout case**, not a duplicate.
2. That same logout calls `storageManager.clearAll()`, which wipes the
   `StationlyPrefs` file — **the same file** `FcmTokenRegistrar` keeps its
   `fcm_last_registered_token` / `_uid` watermark in. So the skip-if-unchanged
   short-circuit is cleared.
3. On the next sign-in, `LoginViewModel` calls
   `FcmTokenRegistrar.ensureRegistered(...)` explicitly, and
   `StationlyApplication` calls it on every cold launch. With the watermark gone,
   the token is re-POSTed.

Self-healing within one login. The same argument covers iOS: the registry release
in §3 is undone by `bind` on the next `/user/sync/profile`.

> Correction to an earlier note in this thread: `FcmTokenRegistrar.unregister` **is**
> dead code — nothing calls it — but Android does still unregister on logout, via
> the inline call in `FirebaseAuthManager`. The helper is redundant, not a gap.

---

## 9. Files touched

**New**
```
src/services/deviceLifecycleService.ts     the single owner of device↔account
docs/DEVICE_IDENTITY_AND_SESSIONS.md       this file
```

**Modified**
```
src/controllers/devicePushController.ts    lines forwarded; asStringList; swagger
src/controllers/userController.ts          optional deviceId on both syncs; asDeviceId;
                                           fcm register normalisation; swagger
src/services/deviceRegistryService.ts      bindUid/releaseUid/releaseAllForUid/deleteAllForUid;
                                           listWhereArrayContains; concurrent chunks + pruneToken;
                                           uid documented as absent-not-null
src/services/userFcmTokenService.ts        purgeAllForUid; shared chunked deleteDocs;
                                           undefined-safe register
src/services/userService.ts                lifecycle wiring (bind/release/purge); purgeUserSubtree
                                           shared with the orphan sweep; deleteAccount ordering;
                                           stripUndefined on sessions; parallel subscription delta;
                                           deviceId threaded to the notifier
src/services/userSyncNotifier.ts           UserSyncOptions.excludeDeviceId
src/services/devicePushService.ts          DevicePushRequest.excludeDeviceId + audience filter
src/tests/run.ts                           8 device-lifecycle regression tests
```

---

## 10. Verification state

**Proven**
- `npx tsc --noEmit` clean.
- `npm test` — **55/55** (47 pre-existing, 8 new).
- The 8 new tests stub both collaborators at the static-method boundary, so
  nothing touches Firestore. They cover: per-device release; the FCM purge firing
  only on last-device-out; sign-out-everywhere; **both** failure-isolation
  directions; the no-uid no-op; bind tolerating a missing row; purge swallowing a
  failure.
- Android's re-registration path traced end to end through the client source (§8).

- **§2 proven on staging** — `lines` written, both audience scopes resolve, no
  index needed. See the deploy-state section below for the evidence table.

**NOT proven — do these on staging.** All four need the redeploy first, since the
retry fix is not in the running build.
1. Logout → the phone stops receiving that account's `user.sync`. Baseline is
   captured: `testnyk67@gmail.com` has sessions 2 / fcm_tokens 1 / devices 1, so
   after signing out ONE device expect devices→uid cleared for that id, sessions
   1, and fcm_tokens **unchanged** (not the last device out).
2. Sign out the SECOND device → fcm_tokens 0, and the next login repopulates it.
3. Account switch on one device → the row re-binds to the new uid.
4. `deleteAccount` leaves **no** `devices` rows (the §4 ordering trap).

### Staging deploy state — checked 2026-08-13

A build was deployed at **09:34** (`pm2` id 1, `stationly-backend`, online, one
cluster instance). It ships `dist/` only, so the check is against the compiled
output.

**In that build:** the `lines` fix, the `asString` guards, `DeviceLifecycleService`,
`release` wired into `endSession`, and all four registry ownership methods.

**NOT in that build** — written after it, so a rebuild + redeploy is required:

| Missing | Impact |
|---|---|
| Transaction-retry reset (§5b) | **Correctness.** The double-count / spurious-decrement race is still live. |
| `swallowMissingDoc` (§5b) | Registry ownership failures are still silent. |
| `purgeAllForUid` comment correction | None (documentation only). |

Verified by grepping the deployed `dist/`: `didActivate` appears at its
declaration and its assignment but **not** as a per-attempt reset, and
`swallowMissingDoc` is absent entirely.

### Live baseline (read-only, staging Firestore)

```
users: 3            orphan device rows (uid with no user doc): 0
testnyk67@gmail.com    sessions 2   fcm_tokens 1   devices 1   ← the useful test account
devices/9157CBC6…      uid set, env=sandbox, stations=2, lines=0, updated 09:27:50
```

`lines` was still 0 at 09:27:50 because that row predated the 09:34 deploy, and
it does not correct itself: `DevicePushCoordinator.register()` skips a POST whose
body signature is unchanged, and that cache is in-memory per process.

### ✅ PROVEN after an app relaunch (09:42:47)

```
devices/9157CBC6…   stations=2  lines=2 ["dlr","elizabeth"]  widgetTok  appTok  sandbox
```

The controller now forwards `lines`. Then the audience queries — the exact ones
`DevicePushService` resolves with — run read-only against staging:

| Query | Result | Reading |
|---|---|---|
| `lines ["dlr"]` | **1 device** | a disruption push now reaches it — this is the fix |
| `lines ["elizabeth","victoria"]` | 1 device | `array-contains-any` OR semantics correct |
| `lines ["victoria"]` | 0 | correctly scoped; does not wake devices that did not ask |
| `lines ["DLR"]` (raw) | 0 | stored values really are lowercase — so `listForLines`' own lowercasing is load-bearing, not decoration |
| `stations ["940GZZDLBNK","910GTOTCTRD"]` | 1 device | station scope works on the device's real ids |

**No Firestore index was required** — Firestore auto-indexes array fields, so the
single-field `array-contains-any` needed nothing created. The §2 warning about
an index can be closed.

Caller confirmed too: `DisruptionTriggerService` sends
`{ kind: 'widget.refresh', lines: [line], reason: 'tfl:…' }`, and `widget.refresh`
is the one `widgetOnly` kind — so this device gets a widget-extension push and
the app is left asleep, which is the intended path. Whatever case TfL reports the
line in, `listForLines` lowercases it before querying.

**End to end, for the first time:** TfL status change → trigger → `listForLines`
→ non-empty audience → widget push.

Reusable read-only inspection scripts (no writes, staging service account):
`check_devices.js`, `check_stores.js`, `check_audience.js`, `check_station_scope.js`
in this session's scratchpad.

---

## 11. Traps

- **Do not reorder `deleteAccount`.** The device purge must precede the session
  teardown, because the teardown clears the `uid` the purge queries on (§4).
- **The FCM purge must stay gated on `lastDeviceOut`.** It cannot be made
  per-device — the store is keyed by token (§3).
- **`excludeDeviceId` is advisory.** Never let it authorise anything, and never
  make a client's *absence* of it change behaviour.
- **Firestore rejects `undefined`.** `ignoreUndefinedProperties` is off; any new
  optional field written to a document needs the same treatment as §5.
- **`bind` must never create a row.** Only iOS calls `/device/register`, so a
  `set(merge)` here would put token-less Android phantoms into `listAll()` — the
  broadcast audience — inflating every `devicesTargeted` with devices that can
  never receive anything.
- **A zero-device audience is not an error and does not log.** That is precisely
  why §2 survived this long. When touching push scoping, verify the audience is
  non-empty rather than verifying the send succeeded.
