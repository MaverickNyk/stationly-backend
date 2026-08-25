# Handover — accounts, devices, sessions and sync (backend)

_2026-08-25. Branch `dev_13Jul`. **Staging: complete and verified. Production:
nothing done.** Nothing is committed in either repo._

**This is the ONLY backend document for this work.** Everything else from the
session was folded in here and deleted.

| Read | For |
|---|---|
| **this file** | the backend, and the PRODUCTION RUNBOOK (§6) |
| `StationlyUI/docs/DESIGN_SESSIONS_AND_SYNC.md` | the design and its reasoning |
| `StationlyUI/docs/HANDOVER_SESSION_SYNC.md` | the client half |

> Where the design and this document disagree, **this one is right.** The design
> was written before implementation and four of its statements turned out to be
> wrong against a running system; each correction is called out where it applies.

---

# ⛔ READ THIS BEFORE TOUCHING PRODUCTION

**Installing the maintenance crontab on production before the device backfill
has run will sign out every Android user on the platform and release all their
subscription holds. In one night. Silently.**

The mechanism, exactly:

```
sweep:  users where loggedIn == true
          → read users/{uid}/devices
          → if NO live row  →  endSession(uid)
                                 ├─ loggedIn: false
                                 ├─ applySubscriptionDelta(stations → [])   registry
                                 └─ DeviceLifecycleService.release(uid, _, true)
                                      └─ purgeAllForUid  →  users/{uid}/fcm_tokens GONE
```

Every production account today has `loggedIn: true` and a `users.sessions` map,
and **no `devices` subcollection at all** — the subcollection is created by P2,
which has not shipped there. So on the first night the sweep would find zero
live rows for every account and release every one of them.

Nothing would error. The sweep would report a large `released` array and exit 0.

**Three things about the damage, traced through the code rather than assumed,
because "signs out every user" is the least accurate part of that sentence:**

1. **It does not sign anybody out.** `loggedIn` is a server flag no client
   reads. The Android app keeps its Firebase session and shows nothing wrong.
   That is what makes this silent rather than loud.
2. **Boards stop updating and do NOT self-heal.** The registry decrement drops
   their stations from `metadata/subscribed_stations`, so the Syncer stops
   polling TfL. Android calls `syncProfile` — the only caller of
   `startSession` — **on explicit sign-in only** (`UserSyncRepository`, from
   `LoginViewModel`), never at launch. So the account never re-activates on its
   own, and the nightly reconcile re-confirms the zero every night after that
   rather than repairing it.
3. **Push dies permanently.** The `fcm_tokens` purge is not recoverable from the
   client: Android's `FcmTokenRegistrar.registerIfAuthenticated` short-circuits
   on a `(token, uid)` pair cached in SharedPreferences, which nothing
   server-side can invalidate. `ensureRegistered` runs on every cold launch and
   returns without POSTing. Push stays dead until the FCM token rotates or the
   user signs out and back in.

**The ordering that prevents it is in §6 and is not optional.** Backfill first,
verify, then the crontab. `HEAL_TRUE_TO_FALSE` ships `false` for the same
reason. Step 4's `check_session_state.cjs` is the gate that catches an account
the backfill could not cover (`loggedIn: true` with an empty `sessions` map);
it exits non-zero, and it is a MUST PASS rather than a formality.

**One narrower window the ordering does not close, so run steps 3 and 4
together rather than a day apart.** Between deploying P2c and finishing the
backfill, every account has `loggedIn: true` and no device rows — and an
ordinary Android sign-out in that window hits `endSession(uid, deviceId)`,
finds an empty subcollection, and takes the *self-heal* branch: `remaining` is
empty, so it deactivates the whole account even though the user's other devices
are still signed in. Same permanent-push consequence as above, for that
account, before the backfill has run. It is a small window and a rare action,
but it costs nothing to avoid.

---

## 1. What this programme is

One account, many devices, changes propagating everywhere, without burning
Firestore reads. Five phases, all shipped to staging:

| Phase | What it does | Staging | Production |
|---|---|---|---|
| **P0** | nightly `sweep` + `reconcile` crons — the safety net | ✅ scheduled, firing | ❌ |
| **P1** | `stateRev` — an app open on an unchanged account costs **0** reads | ✅ | ❌ |
| **P2** | devices/sessions merged into `users/{uid}/devices/{deviceId}` | ✅ | ❌ |
| **P3** | client consolidation (no backend work) | ✅ | n/a |
| **P4** | socket tier for `user.sync` | ✅ | ❌ |

**Tests: 85/85.** Client: 19 in `core`.

---

## 2. The model, after P2

```
users/{uid}
  uid, email, displayName, photoURL?, signInProvider?, emailVerified
  createdAt, updatedAt, welcomeSent, lastLoggedInTime
  loggedIn: boolean          // denormalised "the devices subcollection is non-empty"
  stateRev: number           // NEW — bumped on every CONTENT write, never on session churn
  stations:  SubscribedStation[]   // LEGACY v1 — the frozen APK's list. UNCHANGED.
  boards:    SavedBoard[]          // v2 — iOS. UNCHANGED.
  boardsUpdatedAt: number
  // NO sessions map. NO address. NO phoneNumber. NO preferences.

users/{uid}/devices/{deviceId}    // THE SESSION AND THE DEVICE, one row.
  deviceId                        // also a FIELD: a collection group cannot filter on doc id
  platform, model?, osVersion?, appVersion?
  environment?                    // APNs only — a token is valid against exactly ONE host
  appToken?, widgetToken?         // APNs, iOS
  fcmToken?                       // reserved for Android-next/web. NOTHING writes it today.
  firstSeen, lastSeen: number     // epoch ms

users/{uid}/fcm_tokens/{token}    // LEGACY — the frozen APK's push store. STILL LIVE.
users/{uid}/activity/{date}_{deviceId}
metadata/subscribed_stations
```

**The row's existence IS the session.** Sign-in creates it, sign-out deletes it.
No flag to get wrong, no second record to disagree.

**Deleted:** the root `devices` collection; `users.sessions`; `address`;
`phoneNumber`.

**SQLite (host-local, rebuildable):**
```
user_revs(uid, rev)             the stateRev mirror — GET /user/state/rev reads this
user_watch(uid, kind, id)       which accounts watch which stations/lines
```

---

## 3. Phase detail

### 3.1 P0 — the maintenance crons

Two nightly jobs behind `internalRoutes.ts`'s loopback + constant-time-secret
guard, driven by the host's crontab through `.scripts/maintenance_cron.sh`.

- **`sweep`** releases subscription holds on accounts whose EVERY device is past
  the 90-day TTL. Predicate is **all** stale, not any: an account with one live
  device is somebody's working phone.
- **`reconcile`** recomputes `metadata/subscribed_stations` from live accounts.

**Found on staging:** the registry held **104 keys against a correct 13**. The
first run removed 99 orphans. It has since tracked organic changes on its own.

**Why HTTP routes and not an in-process timer:** staging starts with
`pm2 start -i max` — cluster mode. A timer fires once per worker, and a nightly
registry recompute racing itself across N workers is the contention the
transactions exist to serialise. One crontab line fires once. Production is
`-i 1` today; the reasoning must not depend on that.

**Why a wrapper and not two `curl` lines:** the secret would sit in `argv`
(readable via `ps`) and in the crontab (making `crontab -l` a secret-bearing
command, and rotation a two-place edit). The wrapper reads `PORT` and
`LIVESTREAM_INGEST_SECRET` from the app's own `.env` with `sed` — **not** by
sourcing it, since sourcing executes the file and a value with a space, `#` or
`$` would break or expand.

### 3.2 P1 — `stateRev`

One integer, bumped on every **content** write, mirrored into SQLite so
`GET /user/state/rev` costs no Firestore read.

**Measured on device:** a foreground with nothing changed went from 1 Firestore
read to **0** (`+1` rev check answered from SQLite, `+0` profile reads).

**The rule that must not be "optimised":** the ledger may only hold values READ
FROM the master. Mirroring the write path's guessed `read + 1` costs no read and
is wrong:

> A and B both write, both read `stateRev = N`, both increment. Firestore
> reaches N+2 — but both compute N+1 for the ledger. Device C reads the profile
> between the two increments, genuinely sees N+1, stores it. C's next check
> compares N+1 to N+1 and never learns about B's write.

One read per content write, in the `setImmediate` that already fires the push,
buys that away.

**Five bump sites, not the three the design lists.** It omits `addStation` and
`removeStation` — live routes that mutate `stations` and fan out `user.sync`.
Without a bump a rev-gated client skips the fetch and the update is lost.

### 3.3 P2 — the storage move

**P2a, indexes.** The first deliberate index management in this repo.
`firestore.indexes.json` + `firebase.json`, applied by
`ensure_device_indexes.cjs` via the Firestore Admin REST API (there is no
Firebase CLI here). Two SINGLE-field indexes with **COLLECTION_GROUP** scope, on
`devices.deviceId` (login steal check) and `devices.lastSeen` (sweep).

- They are **`fieldOverrides`, not `indexes`**. `indexes` is for composite
  indexes; a single-field entry there is accepted and does nothing — the deploy
  succeeds and the query still fails.
- `PATCH …/fields/{field}?updateMask=indexConfig` — **not**
  `updateMask.fieldPaths=`, which this REST surface rejects outright.
- Needs **`roles/datastore.indexAdmin`** on the `firebase-adminsdk-*` account.
  Allow minutes for IAM propagation: the first run after granting still failed
  with "The caller does not have permission" and succeeded shortly after with no
  other change.
- Builds are **asynchronous**. The error text is the tell: *"You can create it
  here"* = absent; *"That index is not ready yet"* = building.

**P2b, backfill.** `backfill_device_rows.cjs` merges the two old stores.
Verified by `check_device_backfill.cjs`, which **restates** the union and field
mapping rather than importing them — a probe that imports the merge agrees with
it by construction, including when it is wrong.

Staging result: **11 rows, 6 accounts, 0 missing, 0 field problems, 0 token
losses.**

**P2c, the cutover.** Steal-aware login, delete-on-logout, deletion simplified,
audience resolution moved, `/device/register` bearer-gated, admin console moved.

**The steal, measured on device:**
```
                before   after
testnyk66 rows     4        5     ← 8DD5FE18 acquired
testnyk67 rows     3        2     ← 8DD5FE18 deleted
                        ✓ every device belongs to exactly one account
```

**Account deletion, measured:**
```
users/{uid}/devices  5 docs → gone   (via listCollections(); NOTHING named them)
registry keys        14     → 12
user_watch / user_revs rows → 0
Firebase Auth user          → absent
```
The old ordering trap — *"the device purge must precede the session teardown,
because the teardown clears the `uid` the purge queries on"* — describes a
constraint that no longer exists.

### 3.4 P4 — the socket tier

`UserSyncNotifier` hands the frame to `StationStreamHub.sendToUid`, which writes
`user_sync` to every socket that uid has open. Verified:
`USER_SYNC: 🔌 socket reason='boards' → 1 live connection(s)`.

**No `excludeDeviceId` on this tier and none is needed.** A socket is registered
with a uid and nothing else. The writing device stamps its own `localRev` from
the sync response, so its own frame arrives, the integers match, and the gate
does nothing. The rev gate makes exclusion unnecessary here.

---

## 4. Every file, and why

### New services
```
userDeviceService.ts    users/{uid}/devices — the merged row, the steal query, token pruning
userRevLedger.ts        the stateRev SQLite mirror. NOTHING here ever throws (see its header)
userWatchIndex.ts       station/line → uids, the first hop of the disruption audience
sessionMaintenanceService.ts  sweep(), reconcile(), reindexWatch()
```

### Modified
```
userService.ts          steal-aware startSession; delete-on-logout endSession; deleteAccount
                          simplified; stateRev on 5 write paths; afterContentWrite() tail;
                          effectiveLineIds(); PROTECTED_PROFILE_FIELDS exported
devicePushService.ts    resolveAudience() — 3 scopes, 3 shapes; isReachable(); pruning moved
userSyncNotifier.ts     rev in all three transports; the socket tier
stationStreamHub.ts     sendToUid()
deviceLifecycleService.ts  reduced to the FCM half; bind/purgeForUid are NAMED NO-OPS
adminDataService.ts     AdminUser.sessions rebuilt from the subcollection
devicePushController.ts /device/register bearer-gated, writes the subcollection
localDbService.ts       user_revs + user_watch tables
userController.ts       GET /user/state/rev
apiRoutes.ts            the rev route
internalRoutes.ts       maintenance/{sweep,reconcile,reindex-watch}
tests/run.ts            85 tests
```

### Deleted
```
deviceRegistryService.ts    the whole root-collection service
UserService.buildSessionEntry / isSessionLive / pruneStaleSessions
UserProfile.sessions / .address / .phoneNumber
the /device/register dual-write
```

`deviceLifecycleService` survives with **one** job: purging `fcm_tokens` on the
last device out. That store is keyed by TOKEN and carries no device id (the
frozen APK's `/user/fcm/register` never sent one and never will), so a token
cannot be attributed to the device that is leaving and only the last-out gate
can clear it safely. `bind` and `purgeForUid` are **named no-ops** so their call
sites still document that the concern was considered — delete both together or
not at all.

---

## 5. ⚠️ What production actually looks like — and why it is NOT staging

**Production has only Android users. There has never been an iOS install.**
That changes the migration materially, mostly in your favour, with one sharp
exception.

| Store | Production reality |
|---|---|
| root `devices` collection | **Expected EMPTY.** Only `/device/register` writes it, and that is an iOS-only path. **VERIFY, do not assume.** |
| APNs tokens (`appToken`/`widgetToken`) | none |
| `users.sessions` | **POPULATED for every account** — the old `startSession` wrote it on every Android login |
| `users/{uid}/fcm_tokens` | **LIVE.** This is Android's push store and must keep working |
| `users/{uid}/devices` | **does not exist yet** |

### 5.1 What follows from that

**The backfill has one source, not two.** Device rows come from the `sessions`
map only: `platform` (Android sets it), `model`, `osVersion`, `appVersion`,
`firstSeen`, `lastSeen` (ISO → epoch ms). No tokens, no environment.

**Those rows are deliberately unreachable for push, and that is correct.**
`isReachable` requires a token AND an environment, so they never join an APNs
audience. Android push goes through `fcm_tokens`, which is untouched.

**Android devices self-migrate on next login.** After P2c deploys, the frozen
APK's `POST /user/sync/profile` runs the NEW `startSession`, which writes the
subcollection. The backfill exists for accounts that do not log in soon.

**And the sharp exception — see the box at the top of this document.** Between
deploying P2c and running the backfill, every account has `loggedIn: true` and
no device rows. Anything that reads "no live device" as "release this account"
must not run in that window. That is the sweep, and the reconcile's
`true → false` heal.

### 5.2 What is safe about deleting the legacy data

Verified, not assumed:

- **`sessions` was NEVER in the Android client model, in any commit.** The `-S`
  search across that file's whole history finds only a comment. The map has been
  arriving and being silently discarded on every Android login since launch.
- **`address` is optional with a default** (`String? = null`) in the released
  `UserProfileResponse`, so its absence decodes fine. `phoneNumber` was never in
  the model at all.
- **The four fields the APK cannot survive losing** are `uid`, `email`,
  `displayName` and `stations` — all untouched, and pinned by five
  `ANDROID CONTRACT` tests including one asserting `stations` survives
  `JSON.stringify` (an `undefined` vanishes there, which is how a required key
  goes missing on the wire while everything on this side looks fine).
- **Android reaches** `/user/sync/profile`, `/user/sync/stations`,
  `/user/stations/{add,delete}`, `/user/logout`, `/user/fcm/{register,unregister}`
  and `/user/delete-account`. It has never called `/device/register`.

---

## 6. THE PRODUCTION RUNBOOK

Do these in order. Steps 1–5 are reversible. Step 6 is not.

### Step 0 — the `.scripts/` blocker (do this first)

`.gitignore:62` ignores `.scripts/`. **Zero files under it are tracked.**
Staging does not care because `staging_deploy.sh` rsyncs the working tree.
**Production builds from `actions/checkout`, which contains only tracked
files** — so `maintenance_cron.sh` and `maintenance.crontab` would never arrive
and a crontab installed there would point at a file that never exists.

Move both to a tracked `ops/` directory, fix the absolute paths inside
`maintenance.crontab`, then **redeploy staging and reinstall its crontab** so
the arrangement production will use is the one that has been proven.

### Step 1 — survey production, read-only

```bash
PROD_KEY=~/workspace/Projects/Stationly/Env/Prod/firebase/service_account.json

node src/scripts/check_state_rev.cjs       --key=$PROD_KEY   # expect every account rev=0
node src/scripts/check_device_indexes.cjs  --key=$PROD_KEY   # expect BOTH indexes missing
node src/scripts/check_drift_reconcile.cjs --before --key=$PROD_KEY
node src/scripts/check_session_sweep.cjs   --before --key=$PROD_KEY
```

**Read the sweep prediction carefully.** It currently reads the OLD store, so it
tells you the truth about today. Note the account count — you will compare
against it later.

**Confirm the root `devices` collection is empty.** `check_device_indexes.cjs`
reports its size. If it is NOT empty, stop and work out why: it would mean
something other than iOS has written it.

### Step 2 — indexes, by hand

```bash
# Grant roles/datastore.indexAdmin to prod's firebase-adminsdk-* account first.
node src/scripts/ensure_device_indexes.cjs --key=$PROD_KEY
node src/scripts/check_device_indexes.cjs  --key=$PROD_KEY   # MUST pass before step 3
```

`deploy-prod.yml` is deliberately **not** automated for this — it carries a
comment only. Automating it needs a new secret and an IAM grant, and index
builds are asynchronous: a deploy that waited would block, one that did not
would give a false green. Builds run against live data here, so expect
*"That index is not ready yet"* for a while. **Wait.**

### Step 3 — deploy the code

Merge to `release_prod`. GitHub Actions does the rest.

At this moment: the routes exist, the new `startSession` writes device rows on
every Android login, and **nothing reads the old stores**. There is no crontab,
so nothing sweeps. This is the safe state.

Confirm `HEAL_TRUE_TO_FALSE` is `false` in the deployed build. It is committed
`true` after the staging cutover — **flip it back to `false` before merging.**

### Step 4 — backfill, then verify

```bash
node src/scripts/backfill_device_rows.cjs --key=$PROD_KEY --dry-run   # READ THE OUTPUT
node src/scripts/backfill_device_rows.cjs --key=$PROD_KEY
node src/scripts/check_device_backfill.cjs --key=$PROD_KEY            # MUST PASS
node src/scripts/check_session_state.cjs   --key=$PROD_KEY            # MUST PASS
```

`check_session_state.cjs` asserts `loggedIn` ⇔ at least one live device row, and
that no device is claimed by two accounts. **Both must hold before step 5.**

Then seed the push-audience index, in-process (a second process fighting the
server for the SQLite lock would fail silently — `UserWatchIndex` swallows its
own errors):

```bash
ssh <prod> 'cd ~/stationly-backend && PORT=$(sed -n "s/^PORT=//p" .env|head -1); \
  SECRET=$(sed -n "s/^LIVESTREAM_INGEST_SECRET=//p" .env|head -1); \
  curl -s -X POST "http://127.0.0.1:$PORT/internal/maintenance/reindex-watch" \
       -H "X-Internal-Secret: $SECRET"'
```

### Step 5 — LET IT SIT

Days, not hours. The old stores are still present, nothing reads them, and the
new rows are being exercised by real logins. This costs nothing and is the only
free insurance in the whole plan.

Watch for: Android users reporting sign-outs (there should be none — nothing
signs anyone out yet), and push still arriving (it goes through `fcm_tokens`,
which is untouched).

### Step 6 — the crontab (IRREVERSIBLE in effect)

Only now. Run each job **manually once** and read the result before scheduling:

```bash
ssh <prod> '~/stationly-backend/<ops-dir>/maintenance_cron.sh sweep'
ssh <prod> 'cat ~/logs/maintenance.log'
```

**`released` MUST be empty or a number you can explain account by account.** A
large release here is the failure this whole ordering exists to prevent — it
means the backfill did not cover everyone.

If sweep is clean:
```bash
ssh <prod> '~/stationly-backend/<ops-dir>/maintenance_cron.sh reconcile'
node src/scripts/check_drift_reconcile.cjs --after --key=$PROD_KEY
```

Then install the schedule, and **prove cron actually fires it** — installing a
crontab proves a file is in place, not that cron can exec it (`PATH`, `HOME`,
the exec bit and `.env` readability are all still unproven):

```bash
ssh <prod> 'crontab ~/stationly-backend/<ops-dir>/maintenance.crontab && crontab -l'
# canary: append a `* * * * *` copy of the sweep line, wait 2 minutes,
# confirm two new log lines, then reinstall the clean crontab.
```

### Step 7 — clean the legacy data

Only after a soak with the crons running cleanly.

```bash
node src/scripts/cleanup_legacy_stores.cjs --key=$PROD_KEY --dry-run
node src/scripts/cleanup_legacy_stores.cjs --key=$PROD_KEY     # typed confirmation required
node src/scripts/check_session_state.cjs   --key=$PROD_KEY
```

Removes `users.sessions`, `address`, `phoneNumber` and the root `devices`
collection (expected already empty on prod).

### Step 8 — enable the heal

Flip `HEAL_TRUE_TO_FALSE` to `true` and deploy. Only now: with the old stores
gone there is no stale source left for it to ratify.

---

## 6.9 Staging, measured — the numbers to compare production against

Everything below was observed, not estimated.

| | |
|---|---|
| Registry drift found and repaired | **104 keys → 13** (99 orphans), later tracked to 12 organically |
| Device backfill | 11 rows / 6 accounts, **0 missing, 0 field problems, 0 token losses** |
| Read budget, one unchanged foreground | `GET /user/state/rev` **+1**, `GET /user/sync/profile` **+0** |
| Steal | testnyk66 4→5 rows, testnyk67 3→2, every device owned once |
| Account deletion | 5 device rows gone, registry 14→12 keys, `user_watch`/`user_revs` 0, Auth user absent |
| Watch index seed | `usersScanned 7, accountsIndexed 6, stationRows 17, lineRows 16` |
| Legacy cleanup | 21 fields across 7 accounts + 7 root device docs deleted |
| Cron proven to fire | canary at `21:34:02` and `21:35:01`; then real runs at 03:00/03:20 UTC |

**On production expect the shapes to differ:** no root device rows, no APNs
tokens, and a backfill sourced from `users.sessions` alone (§5).

## 7. Scripts

All read-only unless marked. All take `--key=` and all print their project id.

```
check_session_sweep.cjs      read-only   --before / --after
check_drift_reconcile.cjs    read-only   --before / --after / --email= / --uid=
check_state_rev.cjs          read-only   master vs ledger, --uid=, --watch=
check_device_indexes.cjs     read-only   RUNS the real queries; tracks the root collection size
check_device_backfill.cjs    read-only   union + field mapping + token-loss
check_session_state.cjs      read-only   loggedIn/device invariants, side by side
ensure_device_indexes.cjs    WRITES      idempotent; --dry-run
backfill_device_rows.cjs     WRITES      idempotent; --dry-run, --uid=
backfill_user_watch.cjs      WRITES SQLITE — do NOT run against a host with the server up
run_maintenance.cjs          WRITES      triggers a job with no HTTP server
cleanup_legacy_stores.cjs    ⚠️ DESTRUCTIVE — the only one. --dry-run first; typed confirmation
```

**`src/` is excluded from both deploy paths**, so none of these ever reach a
host. They are developer tools that reach Firestore directly with an explicit
`--key=`.

> **A probe without `--key=` silently reports on STAGING.** Both probes fall back
> to this repo's `serviceAccountKey.json` (a staging key), and
> `run_maintenance.cjs` resolves `FIREBASE_KEY_PATH` from the local `.env`, also
> staging. Staging is `mindthetimefcm`; production is `stationly-prod`. Every
> script prints the project id on its first line. **Read it every time.**

---

## 8. Traps — the complete list

**Operational**
- `/internal/*` is unreachable from the internet ONLY because neither nginx
  vhost has a catch-all `location /` on its **443** block. Prod's `location /` is
  in the port-80 block (the HTTPS redirect), which is fine — but that file is a
  repo copy, not necessarily what is live. If a catch-all proxy is ever added to
  a 443 block, nginx forwards `/internal/*` **from 127.0.0.1**, the loopback
  check passes, and these routes become internet-reachable behind nothing but a
  shared secret.
- `nodemon` is probably watching your local tree. A `curl` meant to prove the
  deployed code was stale once *executed the sweep* instead.
- The host is `Etc/UTC`, so `0 3 * * *` is 04:00 London in BST. Verify prod's
  timezone separately.
- `staging_deploy.sh`'s `--exclude '*.md'` / `'*.sqlite'` are **inert** — the
  quotes survive unquoted expansion, so rsync looks for a file literally named
  `'*.md'`. Harmless (the real DB is `data/stationly.sqlite`, properly excluded)
  but it explains why the two hosts' trees differ.

**Code**
- **`stateRev` bumps on CONTENT ONLY.** On session churn it wakes every device
  into a fetch that finds nothing.
- **The ledger accepts only values read from the master.** §3.2.
- **`stateRev` must stay in `PROTECTED_PROFILE_FIELDS`** — the profile sync
  spreads unknown body keys onto the document, so a client posting `stateRev: 0`
  would reset the counter account-wide.
- **Never spread `updateData` into a response.** It carries Firestore SENTINELS.
  This shipped and broke login: a `FieldValue.increment` was serialised into the
  profile, iOS typed the field `Long`, threw, and the login rolled back and
  signed the user out — while the POST logged **200**.
- **Every collection-group query filters `ref.parent.parent != null`.** A
  collection group matches the ROOT collection of the same name too.
- **`isReachable` requires a token AND an environment.** An APNs token is valid
  against exactly one host; guessing returns `BadDeviceToken`, indistinguishable
  from a dead token, so the device gets pruned from its own audience.
- **`syncBoards` must not bump on `stale` or `empty_rejected`** — both return
  200 having written nothing.
- **A superseded store that is still readable is still a reader.** `users.sessions`
  stopped being written but one login guard still consulted it, so after logout
  deleted the device row the frozen map said "device active", `startSession` was
  skipped, and the row was never recreated on sign-in.

---

## 9. What is NOT done

- **Production: everything.** Nothing has been deployed, run or deleted there.
- **Two-device convergence.** One phone was available; A→B is evidenced by the
  push audience and fan-out log, not by watching B apply it.
- **`SessionLifecycle` / `SyncEngine`** (P3) — deliberately not built. See the
  client handover.
- **The `.scripts/` → `ops/` move.** Step 0 above.
- **`HEAL_TRUE_TO_FALSE` is committed `true`.** Flip it before merging to prod.
