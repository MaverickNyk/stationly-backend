# Production cutover plan — `dev_13Jul` → `main` → `release_staging` → `release_prod`

_Working document. Written 2026-09-01. **This file is the single source of truth for
where we are.** Update the STATUS block below before ending any session._

Companion reading:

| Document | For |
|---|---|
| **this file** | what to do, in order, and what is done so far |
| `docs/HANDOVER_SESSION_SYNC.md` | why the session/device model is shaped the way it is |
| `docs/DEVICE_IDENTITY_AND_SESSIONS.md` | the device-lifecycle bugs this release fixes |
| `docs/SUPPORT_CONTRIBUTIONS.md` | the Stripe contribution design |
| `docs/LIMITS_AND_QUOTA_SPEC.md`, `docs/SDUI_CONFIG.md` | the served-config surface |

---

## STATUS — read this first, update it last

```
╔══════════════════════════════════════════════════════════════════════════╗
║  RESUME HERE ▸  A8   commit Phase A   ⚠️ NEEDS USER APPROVAL             ║
║                 then C9/C10, then Phase B (staging re-proof)             ║
╚══════════════════════════════════════════════════════════════════════════╝

UPDATED:      2026-09-02 (b)
STATE:        Phase A complete and verified EXCEPT the commit.
              A10 (sweep disabled) landed 2026-09-02 and is part of the A8 commit.
              C0, C1, C3-C8, C11 closed. THE INDEXES ARE LIVE ON PRODUCTION
              and C8's gate has PASSED — the hard blocker on D1 is gone.
              All 5 core secrets verified present; all 5 Stripe secrets set;
              both repos carry LIVESTREAM_INGEST_SECRET.
              Phase C is DONE except C9 (survey) and C10 (process manager),
              both of which need production access.
              NOTHING IS COMMITTED. All repo work is in the working tree.
BLOCKED ON:   user approval for A8. Nothing else is blocked.
```

**Decisions pending — do not lose these between sessions**

| # | Decision | Default if unanswered |
|---|---|---|
| 1 | **A8** — commit Phase A? | hold; nothing is committed |
| 2 | **A9** — export `HEAL_TRUE_TO_FALSE` and pin it with a test? | not done |
| 3 | ~~Rotate the 4 production secrets pasted into a chat transcript on 2026-09-01?~~ | ☑ **DECIDED 2026-09-02: NO, not now.** See `C11` — carry the 4 forward as-is, unblocking `C0` |
| 4 | Run the read-only production survey (`C9`) now? | not run |

**Phase checklist**

- [~] **A** — Repo changes on `dev_13Jul` — A1–A7, A10 ✅ verified · A8 pending approval · A9 undecided
- [ ] **B** — Staging re-proof
- [~] **C** — Production prerequisites — C0–C8, C11 ✅ done · **only C9, C10 outstanding**
- [ ] **D** — The deploy window
- [ ] **E** — Soak
- [ ] **F** — Enable maintenance — **reconcile only**; sweep disabled at `A10`, returns at `G5`
- [ ] **G** — Legacy cleanup and finish

> **Why C6 is done before Phase B.** It turned out to be verify-only: the live
> nginx already has everything this release needs. Closing it early costs
> nothing and removes it from the deploy-day critical path. No other Phase C
> task may be pulled forward past `C8`, which is a hard gate on `D1`.

**What is currently uncommitted in the working tree**

```
M  .github/workflows/deploy-prod.yml          A6 — 8 Stripe/support keys exported
M  .gitignore                                 A3 — index JSONs allowlisted
M  docs/HANDOVER_SESSION_SYNC.md              A4 — 4 corrections
M  server-config/nginx.conf                   A5 — replaced with a live mirror
M  src/services/sessionMaintenanceService.ts  A1 — HEAL_TRUE_TO_FALSE = false
                                              A10 — SWEEP_ENABLED = false + early return
A  ops/maintenance.crontab                    A2 — moved, paths fixed
                                              A10 — sweep cron line commented out
A  ops/maintenance_cron.sh                    A2 — moved, mode 100755
?? docs/PROD_CUTOVER_PLAN.md                  this file
?? firebase.json                              A3 — now visible to git
?? firestore.indexes.json                     A3 — now visible to git
```

---

## 0. How to run this across sessions

1. **Read the STATUS block, then the phase you are in.** Do not re-derive the plan.
2. **Tasks have stable ids** (`A1`, `C4`, …). Refer to them by id. Never renumber —
   append `A9`, `C11` if something new is needed.
3. **One phase per commit** where the phase touches the repo. Commit message:
   `chore(cutover): <phase id> — <what>`.
4. **Gates are marked `⛔ GATE`.** Do not pass one because it "looks fine". Each gate
   names a command whose output decides.
5. **Append to §10 (Session log) before you stop**, even if you did nothing. A session
   that leaves no trace is a session the next one has to reconstruct.
6. **If you deviate from this plan, edit this plan.** A runbook that disagrees with what
   was actually done is worse than no runbook — that is exactly how
   `HANDOVER_SESSION_SYNC.md` §6 Step 1 ended up describing a probe that had since been
   fixed (see `A4`).

### Credentials and hosts — never write these into this file

| Thing | Where it lives |
|---|---|
| Prod Firestore key | `~/workspace/Projects/Stationly/Env/Prod/firebase/service_account.json` |
| Staging Firestore key | `~/workspace/Projects/Stationly/Env/Staging/firebase/service_account.json` |
| Prod SSH | `~/workspace/Projects/Stationly/Env/Prod/ssh/` (`connect.sh`) |
| Staging SSH | `~/workspace/Projects/Stationly/Env/Staging/ssh/` (`connect.sh`) |

Referred to below as `$PROD_KEY`, `$STAGING_KEY`, `<PROD_HOST>`, `<STAGING_HOST>`.

> **Every probe prints its project id on line 1. Read it every single time.**
> Without `--key=` they fall back to this repo's staging key. Staging is
> `mindthetimefcm`; production is `stationly-prod`.

---

## 1. What is shipping

31 commits. The load-bearing change is **P2**: a device's session moves from a
`sessions` map on the user document to a row at `users/{uid}/devices/{deviceId}`,
whose *existence is the session*. Alongside it: `stateRev` read-gating, a live
line-status stream fed by the Syncer, a client version gate (dormant), Stripe
contributions (dormant), and the SDUI config expansion.

**Production is Android-only and has never had an iOS install.** That is what makes
this migration safe in most respects and lethal in one: production today has
`loggedIn: true` on every account and **no `users/{uid}/devices` subcollection at all**.
Anything that reads "no live device row" as "release this account" will therefore
release *every account on the platform*, in one night, reporting success.

Two jobs do exactly that: `reconcile`'s true→false heal (gated by a constant, `A1`)
and `sweep` (gated by nothing but the crontab not being installed, `F4`).

**A release does not sign anyone out.** `loggedIn` is a server flag no client reads.
What it does is drop the account's stations from `metadata/subscribed_stations` so the
Syncer stops polling them (boards go stale and do **not** self-heal, because Android
only calls `syncProfile` on explicit sign-in) and purge `users/{uid}/fcm_tokens`
(push dies, and does not recover, because Android's `FcmTokenRegistrar` short-circuits
on a watermark in SharedPreferences that nothing server-side can clear).

---

## 2. Invariants — the things that must not be broken

1. **Indexes before code.** `startSession` runs a `collectionGroup('devices')` query
   inside the sign-in transaction with no fallback. No index ⇒ every Android login 500s.
2. **Backfill before any release job.** Both `sweep` and the true→false heal read the
   new store. Against an empty one, every account looks abandoned.
3. **`HEAL_TRUE_TO_FALSE = false` until the legacy stores are gone.** It is a
   compile-time `const` with no env override — the value in the branch is the value
   production runs, and it cannot be changed from the box.
4. **The crontab is the last thing installed, not the first.**
5. **No catch-all `location /` on nginx's 443 block.** It is the only reason
   `/internal/*` is unreachable from the internet.
6. **Never spread `updateData` into a response.** It carries Firestore sentinels; this
   already shipped once and broke login while logging 200.
7. **`stateRev` stays in `PROTECTED_PROFILE_FIELDS`** — the profile sync spreads unknown
   body keys onto the document.
8. **Android's required response keys** — `uid`, `email`, `displayName`, `stations` on
   the profile; `id`/`name`/`mode`/`statusSeverityDescription`/`reason`/`lastUpdatedTime`
   on a line status. A nullable field with no Kotlin default is still a *required key*.
   Pinned by the `ANDROID CONTRACT` tests.
9. **Do not add a global Jackson inclusion setting to the Syncer.** `NON_NULL` would drop
   `"reason": null` and break the Android line-status screen from the other repo.

---

## Phase A — repo changes on `dev_13Jul`

All local. Nothing deploys. Finish with `A8`.

### ☑ A1 — Flip the heal flag

`src/services/sessionMaintenanceService.ts:67`

```diff
-const HEAL_TRUE_TO_FALSE = true;
+const HEAL_TRUE_TO_FALSE = false;
```

It reads `true` because it was enabled for **staging** on 2026-08-25, once staging's
preconditions held. None of them hold on production. Turned back on in `G3`.

### ☑ A2 — Move the maintenance files to a tracked `ops/`

`.gitignore:62` ignores `.scripts/`, and **zero files under it are tracked**. Staging
gets them because `staging_deploy.sh` rsyncs the working tree; production builds from
`actions/checkout`, which contains only tracked files — so they would never arrive and
a crontab installed there would point at a path that does not exist.

Move **only these two**. The rest of `.scripts/` (`staging_deploy.sh`,
`watch_stream.mjs`, `compare_predictions.mjs`, `soak_stream.mjs`) are local dev tools
that never need to reach a server, and the doc references to them stay correct.

```bash
mkdir -p ops
mv .scripts/maintenance_cron.sh .scripts/maintenance.crontab ops/
git add ops/maintenance_cron.sh ops/maintenance.crontab
git ls-files -s ops/          # maintenance_cron.sh MUST show mode 100755
```

- `ops/maintenance_cron.sh` — **no functional change needed.** It derives its own root
  via `APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"`, so it works from any
  directory one level under the app root. Only the stale `.scripts/` mention on line 26
  needs updating.
- `ops/maintenance.crontab` — three path edits: the two cron lines, and the
  `Install with:` line in the header.

> **If the exec bit is lost, cron fails with "Permission denied" at 3am and nothing
> else tells you.** `git update-index --chmod=+x ops/maintenance_cron.sh` if needed.

`ops/` is excluded by neither deploy path, so it reaches both boxes.

### ☑ A3 — Track the two Firestore config files

`.gitignore:21`'s blanket `*.json` is a deliberate security control
(`# Firebase keys / Sensitive data`) with an allowlist beneath it, and it is correctly
catching `serviceAccountKey.json`. Extend the allowlist in the file's own style rather
than `git add -f` — a force-add tracks your copy but does not stop the next person's
from vanishing:

```diff
 !tsconfig.json
 !openapi.json
+!firestore.indexes.json
+!firebase.json
```

Audited: the only other things that rule hides are probe outputs
(`.sweep-prediction.json`, `.reconcile-prediction.json`), `docs/tfl-api-spec.json`, and
the service account key. Nothing else needs rescuing.

### ☑ A4 — Fix the stale runbook text

`docs/HANDOVER_SESSION_SYNC.md`:

- §3.1 (line ~146), §6 Step 0 (~361–373), §9 (~598) — update the `.scripts/` references
  and mark Step 0 done, so the next reader does not do `A2` a second time.
- **§6 Step 1 is factually wrong now.** It says of `check_session_sweep.cjs`: *"It
  currently reads the OLD store, so it tells you the truth about today."* The script has
  since been fixed — its own comment says `THE STORE THE SWEEP ACTUALLY READS` — and it
  now reads `users/{uid}/devices`, counting legacy `users.sessions` entries separately as
  a printed note. On production pre-backfill it will therefore correctly predict that
  **every account would be released**. That is the right warning; the doc primes you to
  dismiss it. Fix the text.

### ☑ A5 — Replace `server-config/nginx.conf` with a mirror of the live vhost

The repo copy was not merely stale, it was a **different and materially worse
file** than the one running: wrong TLS certificate path (`api.stationly.co.uk`,
which does not exist — the live cert is the shared `stationly.co.uk` one), no
upstream `keepalive`, no security headers, no server-level `proxy_set_header`
block, and a `/StationlySyncer/api/v1/admin/` block that publicly exposed the
Java syncer's admin route.

Because it read as a reference copy, the obvious move was to scp it onto the box
— which would have dropped every security header, broken keepalive, and failed
TLS on a path that does not exist. **A stale reference file is worse than none.**

Replaced with a verbatim mirror of the running config plus explanatory comments,
and a header recording that truth flows BOX → REPO. Verified MD5-identical to
the live file once comments and blank lines are stripped.

### ☑ A6 — Add the Stripe / support keys to the prod workflow

`.github/workflows/deploy-prod.yml` — the `env:` block of the "Assemble production .env"
step. `.env.remote` already lists these keys, but the workflow never exports them, so
they resolve empty and can never reach the box no matter what GitHub secrets exist.

```yaml
          SUPPORT_MONEY_ENABLED: ${{ secrets.SUPPORT_MONEY_ENABLED }}
          STRIPE_WEBHOOK_SECRET: ${{ secrets.STRIPE_WEBHOOK_SECRET }}
          SUPPORT_MONEY_PAYMENT_URL_T4: ${{ secrets.SUPPORT_MONEY_PAYMENT_URL_T4 }}
          SUPPORT_MONEY_PAYMENT_URL_T8: ${{ secrets.SUPPORT_MONEY_PAYMENT_URL_T8 }}
          SUPPORT_MONEY_PAYMENT_URL_T12: ${{ secrets.SUPPORT_MONEY_PAYMENT_URL_T12 }}
          SUPPORT_MONEY_PAYMENT_URL_ONEOFF: ${{ secrets.SUPPORT_MONEY_PAYMENT_URL_ONEOFF }}
          SUPPORT_MONEY_MIN_BOARDS: ${{ secrets.SUPPORT_MONEY_MIN_BOARDS }}
          SUPPORT_MONEY_MIN_DAYS: ${{ secrets.SUPPORT_MONEY_MIN_DAYS }}
```

Safe to add before the secrets exist: an unset secret substitutes an empty string, the
assembly loop logs `⚠️ Warning: <KEY> is empty or not provided`, and `.env.defaults`
keeps its value — which is `SUPPORT_MONEY_ENABLED=false`.

### ☑ A7 — Verify

```bash
npx tsc --noEmit          # must be silent
npm test                  # 210/210 at the time of writing
```

### ☐ A8 — Commit

```
chore(cutover): phase A — prod-safety flags, ops/ move, tracked index config
```

### ☐ A9 — PROPOSED, decision needed: pin the heal flag with a test

**Not done. Decide before Phase G.**

Nothing in the 210-test suite asserts `HEAL_TRUE_TO_FALSE`. It is the single
most consequential constant in this release — the one whose wrong value releases
every production account — and it reached this branch set to `true` with nothing
but human review catching it.

It cannot be tested as-is because it is not exported. The change would be:

```ts
export const HEAL_TRUE_TO_FALSE = false;
```

plus one assertion in `src/tests/run.ts`. That makes `G2` a deliberate act: the
person turning it back on must also change the test, which is exactly the
friction wanted on a switch that can empty the subscription registry.

Cost: one export and three lines of test. Risk of NOT doing it: the same silent
regression happens again, and the next reviewer may not catch it.

### ☑ A10 — Disable `sweep` — DONE 2026-09-02

**Decision: the sweep does not ship in this release.** Reconcile does.

`src/services/sessionMaintenanceService.ts` — a new compile-time `SWEEP_ENABLED = false`,
same mechanism as `HEAL_TRUE_TO_FALSE`, with an early return that logs
`sweep SKIPPED — SWEEP_ENABLED is off` and returns the normal result shape with an empty
`released`. `ops/maintenance.crontab` — the `0 3 * * *` sweep line commented out; the
`20 3 * * *` reconcile line is untouched.

**Why.** The 90-day TTL is measured on `lastSeen`, refreshed at most once a day by
`startSession`, whose one live caller is `POST /user/sync/profile` — which the shipped
Android build calls **on explicit sign-in only, never at launch**. So `lastSeen` records
the last SIGN-IN, not the last app open, and the predicate currently means "has not
signed in for 90 days". A user who opens the app daily but signed in once satisfies it.

Releasing such an account is silent and does not self-heal: nobody is signed out
(`loggedIn` is a server flag no client reads), while their stations leave
`metadata/subscribed_stations` so the Syncer stops polling and their board goes stale,
and `fcm_tokens` is purged on the last device out so push dies permanently.

This is a **different failure from the cutover hazard** in §1. That one is temporary and
the backfill closes it. This one survives the backfill and would first bite roughly 90
days after go-live, on real active users.

**Why a code gate and not just leaving it out of the crontab.** An uninstalled cron line
is a fact about one box that no reader of the source can see, and `run_maintenance.cjs`
and the `/internal/maintenance/sweep` route both reach `sweep()` without cron.

**Why this costs nothing.** Reconcile is the job that motivated the pair — it repairs the
registry drift a lost post-transaction write leaves behind (104 keys against a correct 13
on staging). Without the sweep the registry merely keeps over-counting abandoned
accounts, which is the direction the design deliberately errs in: over-counting polls a
station nobody needs; under-counting takes a live station from someone who does.

Bringing it back is `G5`.

⛔ **GATE A** — `tsc` silent, tests green, `git ls-files ops/` shows both files with
`maintenance_cron.sh` at mode `100755`, and `git ls-files | grep firestore.indexes.json`
returns a line.

---

## Phase B — staging re-proof

The point is not to test the features again; staging has been running them for weeks.
The point is to prove **the arrangement production will receive** — the `ops/` layout,
from a clean checkout — because until now staging has been running your working tree.

> The `limits` commit message says this outright: *"this file was deployed from a dirty
> tree, so `git log -S` finds no commit for them."* Deploying from a clean checkout is
> the only way to prove that what is committed is what works.

### ☐ B1 — PR `dev_13Jul` → `main`

Branch Guard allows `dev_*`, `feature/*`, `fix/*`, `hotfix/*` into `main`. Merging opens
the `main` → `release_staging` PR automatically.

### ☐ B2 — Merge `main` → `release_staging`

This deploys **nothing**. There is no staging workflow — `release_staging` is a
promotion gate. Merging it opens the `release_staging` → `release_prod` PR
automatically: **leave that one sitting unmerged until GATE C.**

### ☐ B3 — Deploy staging from a clean checkout

```bash
git clone <repo> /tmp/stationly-staging-deploy
cd /tmp/stationly-staging-deploy && git checkout release_staging
```

> **This is not a mode of the deploy script.** There is no "clean checkout" flag, and
> `staging_deploy.sh` always rsyncs whatever is on disk. What B3 does is run the SAME
> script from a freshly cloned tree instead of your working tree. That is the only way
> to learn whether a file is committed, because rsync cannot tell tracked from untracked
> and production's `actions/checkout` contains only tracked files.

> **Gotcha 1 — `staging_deploy.sh` is itself untracked**, matched by *both*
> `.gitignore:59` (`staging_*.sh`) and `:62` (`.scripts/`), so a clean checkout does not
> contain it and `A2` does not change that. Copy it in from your working tree. Do not
> "fix" this by tracking it; it carries a host address and a key path.

> ⛔ **Gotcha 2 — `.env` is untracked too (`.gitignore:13`), and forgetting it STRIPS
> STAGING'S SECRETS.** Found 2026-09-02, before this task was ever run. The assembly
> loop's fallback is `if [ -f .env ]`; in a fresh clone that is false, so every key in
> `.env.remote` resolves empty, nothing is written for them, and the file `scp`'d over
> staging's `.env` is `.env.defaults` alone. `.env.defaults` carries `PORT`,
> `FIREBASE_KEY_PATH`, the TfL tuning and the support defaults — and NONE of
> `TFL_APP_KEY`, `RESEND_API_KEY`, `STATIONLY_ADMIN_KEY`, `LIVESTREAM_INGEST_SECRET` or
> the Stripe values. The deploy would go green and staging would come back up gutted.

```bash
SRC=~/workspace/Projects/Stationly/stationly-backend
cp $SRC/.scripts/staging_deploy.sh /tmp/stationly-staging-deploy/.scripts/
cp $SRC/.env                       /tmp/stationly-staging-deploy/.env
cd /tmp/stationly-staging-deploy && bash .scripts/staging_deploy.sh
```

**Before running, diff the two trees** — that comparison IS the test, and it is cheaper
to read than to debug after the fact:

```bash
diff -rq $SRC /tmp/stationly-staging-deploy \
  -x node_modules -x .git -x dist -x data -x graphify-out -x .env
```

Anything the clean tree is missing that the box needs is a file that would never reach
production either. `ops/` and `firestore.indexes.json` must NOT appear as missing.

Then confirm on the box that `ops/` arrived and `maintenance_cron.sh` is still mode 755
(the exec bit must survive git AND rsync — verified intact on 2026-09-02), and re-run the
`GET /sdui/app/support-money-config` + webhook-returns-400 checks from the 09-02 (c) log
to prove the secrets survived the round trip.

### ☐ B4 — Reinstall the staging crontab at the new path, and canary it

```bash
ssh <STAGING_HOST> 'crontab ~/stationly-backend/ops/maintenance.crontab && crontab -l'
```

Then prove cron can actually **exec** it — installing a crontab proves a file is in
place, not that `PATH`, `HOME`, the exec bit and `.env` readability all line up. Append
a `* * * * *` copy of the sweep line, wait two minutes, confirm two new lines in
`~/logs/maintenance.log`, then reinstall the clean crontab.

### ☐ B5 — Two clean nights

Both scheduled jobs fire from `ops/` on two consecutive nights. Read
`~/logs/maintenance.log` each morning.

### ☐ B6 — Regression pass on staging

On a real device against staging: sign in, save a board, sign out, sign back in,
account switch, delete account. Plus `GET /lines/status`, a station board, and a live
stream connection.

⛔ **GATE B** — two clean scheduled runs from `ops/`, and the device pass clean.

---

## Phase C — production prerequisites

**None of this deploys code.** It can all run during Phase B's soak. `C8` is the gate
that releases Phase D.

### ☑ C11 — Secret rotation: DEFERRED, decided 2026-09-02

`TFL_APP_KEY`, `RESEND_API_KEY`, `STATIONLY_ADMIN_KEY` and `LIVESTREAM_INGEST_SECRET`
were pasted into a chat transcript on 2026-09-01. **Decision: do not rotate as part of
this cutover.** `C0` therefore proceeds with the values currently on the box, and the
GitHub secrets are set once, from those values.

This is a deliberate acceptance, not an oversight. What it means concretely:

| Secret | If the transcript leaked |
|---|---|
| `LIVESTREAM_INGEST_SECRET` | the `/internal/*` jobs could be triggered by anyone who could also reach loopback — which the nginx invariant (§2.5) already prevents from the internet |
| `STATIONLY_ADMIN_KEY` | admin console access |
| `TFL_APP_KEY` | third-party quota abuse, no data exposure |
| `RESEND_API_KEY` | outbound mail could be sent as us |

The mitigating fact is the transcript's audience, not the secrets' strength. Revisit if
that assumption ever changes.

**Rotate them as a separate piece of work after the cutover**, when a rotation can be
done and verified on its own rather than tangled with a migration. Rotating
`LIVESTREAM_INGEST_SECRET` in particular touches three places — the prod `.env`, the
backend GitHub secret (`C1`) and the Syncer's (`C2`) — and a mismatch there fails
**closed** (503 on `/internal/*`), so it is safe but noisy, and not something to
discover mid-deploy.

### ☑ C0 — Audit the repository secrets against the live `.env` — DONE 2026-09-02

**Result: all five core secrets exist AND are populated on the box.** `LIVESTREAM_INGEST_SECRET`
has existed as a repository secret since 2026-08-02, which was the one this task most
expected to be box-only.

Box fingerprints, recorded for the post-`D1` diff (sha1 first 8, value length; values
never left the box):

```
TFL_APP_KEY               717a4400  len=32
FIRESTORE_PROJECT_ID      b215257c  len=14
RESEND_API_KEY            1d78a548  len=36
STATIONLY_ADMIN_KEY       ccecbcd3  len=64
LIVESTREAM_INGEST_SECRET  99091a4d  len=64
```

Also on the box and NOT secret-backed, all hardcoded in the workflow or `.env.defaults`
and therefore safe: `PORT`, `FIREBASE_KEY_PATH`, `TFL_TRANSPORT_MODES`, `TFL_API_TIMEOUT`,
`TFL_ARRIVAL_PREDICTION_COUNT`, `APP_ENV`, `APP_BASE_URL`, `APP_WEB_URL`.

⚠️ **The one thing this audit CANNOT establish, and nor can anyone.** GitHub secrets are
write-only — no API, UI or workflow log can read a value back. So "does the secret hold
the same value the box holds?" is unanswerable by inspection. If certainty is wanted,
re-paste the five from the box so they match by construction. Otherwise the fingerprints
above are the post-deploy check, and the failure they guard against is
`LIVESTREAM_INGEST_SECRET` differing: `/internal/*` then answers 503, the Syncer's ingest
is refused, and the backend silently falls back to polling TfL once per mode per 60s —
stale boards, no error.


**The production `.env` is hand-maintained and cannot be reproduced from the repo.**
Verified 2026-09-01: `.env.remote` does not exist on `main`, and `main`'s workflow
never exported `LIVESTREAM_INGEST_SECRET` — yet the box has a value for it. The
file on the box is `main`'s `.env.defaults` verbatim with an environment block
appended by hand.

The deploy at `D1` **regenerates `.env` from scratch** — `cp .env.defaults .env.prod`,
substitute from `.env.remote` using repository secrets, then `scp` over the top.
So **any value on that box not backed by a GitHub secret is silently replaced or
dropped.** The assembly loop only prints `⚠️ Warning: <KEY> is empty or not
provided` and carries on; the deploy still goes green.

Confirm each of these exists in **Settings → Secrets and variables → Actions**,
with the value currently live on the box:

- [ ] `TFL_APP_KEY`
- [ ] `FIRESTORE_PROJECT_ID`
- [ ] `RESEND_API_KEY`
- [ ] `STATIONLY_ADMIN_KEY`
- [ ] `LIVESTREAM_INGEST_SECRET`

(`APP_ENV`, `APP_BASE_URL`, `APP_WEB_URL` are hardcoded in the workflow — safe.)

Read the current values off the box with `cat ~/stationly-backend/.env`, and do
not paste them anywhere they will be retained.

**Failure modes if one is missing**, none of which fail the deploy:

| Missing | Result |
|---|---|
| `LIVESTREAM_INGEST_SECRET` | `/internal/*` answers **503** (fails closed — not a security hole). The Syncer's ingest is rejected and the backend silently falls back to polling TfL once per mode per 60s. Stale boards, no error. |
| `TFL_APP_KEY` | Every upstream TfL call unauthenticated → throttled or refused. |
| `FIRESTORE_PROJECT_ID` | Wrong or no project. Loud. |
| `RESEND_API_KEY` | Welcome / verification / reset emails stop sending. |
| `STATIONLY_ADMIN_KEY` | The admin console cannot authenticate. |

After the `D1` deploy, diff the regenerated file against what you recorded here
before declaring the deploy good.

### ☑ C1 — GitHub secret: `LIVESTREAM_INGEST_SECRET` (backend repo) — VERIFIED 2026-09-02

Present, set 2026-08-02. Confirmed by `gh secret list`. Value match is unverifiable — see `C0`.


Generate once (e.g. `openssl rand -hex 32`). Store it where the other prod secrets live.

### ☑ C2 — GitHub secret: `LIVESTREAM_INGEST_SECRET` (StationlySyncer repo) — CONFIRMED 2026-09-02

Confirmed present by the owner. Value match with the backend's is unverifiable by
inspection (GitHub secrets are write-only, see `C0`); a mismatch shows up as the Syncer's
ingest being refused and the backend falling back to polling — check for that at `D8`.


**Byte-identical to `C1`.** The Syncer's `deploy-prod.yml` already passes it into the
properties merge. Keep `livestream.ingest-secret=` **blank** in
`application-remote.properties` — that file is a tracked manifest of key *names*, and a
key absent from it is silently skipped by the merge loop.

> If these two ever differ, the ingest is rejected and the backend falls back to polling
> TfL once per mode per 60s. Stale boards, no error anywhere.

### ☑ C3 — Stripe: create the live-mode Payment Links — DONE 2026-09-02

Four live links created and stored as repository secrets (`C5`). Return URL set per price
point — the page takes `tier`/`amount` query params, so each link differs:
`https://api.stationly.co.uk/api/v1/support-money/return?tier=t4&amount=4` (and `t8`/8,
`t12`/12, `oneoff` with no amount). Those params are cosmetic and untrusted — the
authoritative record is the webhook write.


Four links, **live mode** (staging uses test mode). A Stripe Payment Link carries its
price in the link, not in a query parameter — hence one link per fixed amount:

| Link | Amount | Secret name |
|---|---|---|
| Fixed | £4.00 | `SUPPORT_MONEY_PAYMENT_URL_T4` |
| Fixed | £8.00 | `SUPPORT_MONEY_PAYMENT_URL_T8` |
| Fixed | £12.00 | `SUPPORT_MONEY_PAYMENT_URL_T12` |
| Customer chooses | — | `SUPPORT_MONEY_PAYMENT_URL_ONEOFF` |

On each link, set **after payment → redirect to**
`https://api.stationly.co.uk/api/v1/support-money/return`. Stripe only accepts an
`https://` URL there, which is exactly why that branded holding page exists: it bounces
into the app's `stationly://support-money/thanks` deep link.

**Do not append `client_reference_id` yourself.** `SupportMoneyConfigService` stamps
`?client_reference_id={uid}` onto whatever URL you provide, and skips a URL that already
carries the parameter. Attribution is the one thing unrecoverable after the fact — a
checkout opened without it takes the money and reaches the webhook with nobody to credit.

### ☑ C4 — Stripe: create the webhook endpoint — DONE 2026-09-02

Live-mode endpoint at `https://api.stationly.co.uk/api/v1/webhooks/stripe`, two events,
signing secret stored as `STRIPE_WEBHOOK_SECRET`. Any delivery attempted before `D1`
fails `503 not configured` — correct, the webhook is fail-closed until the deploy.


- URL: `https://api.stationly.co.uk/api/v1/webhooks/stripe`
- Events: `checkout.session.completed` **and** `checkout.session.async_payment_succeeded`
  (the second is the delayed-settlement path — bank redirects and some wallets)
- Mode: **live**

Copy the signing secret (`whsec_…`).

The route is mounted before the `X-Stationly-Key` gate and before global
`express.json()`, so it is already reachable through the existing `/api/v1/` nginx block
— no nginx change needed for Stripe.

### ☑ C5 — GitHub secrets: Stripe values — DONE 2026-09-02

Verified by `gh secret list`: `STRIPE_WEBHOOK_SECRET`,
`SUPPORT_MONEY_PAYMENT_URL_{T4,T8,T12,ONEOFF}` all present.

`SUPPORT_MONEY_ENABLED`, `SUPPORT_MONEY_MIN_BOARDS` and `SUPPORT_MONEY_MIN_DAYS` are
deliberately NOT set — they now carry `true`, `1` and `1` in `.env.defaults`, and an unset
secret substitutes empty, which the assembly loop skips. See the note above about what
that inversion means.


Set `STRIPE_WEBHOOK_SECRET` and the four payment URLs (`C3`/`C4`) as prod secrets.

**⚠️ CHANGED 2026-09-02 — `SUPPORT_MONEY_ENABLED` now defaults to `true`.**

This task used to read *"leave `SUPPORT_MONEY_ENABLED` unset for now"*, on the reasoning
that unset ⇒ off. **That is no longer true.** `.env.defaults` now ships `true`, and an
unset repository secret substitutes an empty string which the assembly loop skips — so
production takes the default and ships with the support surface **enabled**.

It remains invisible on the fleet as it stands: the shipped Android APK reads no
`support_money.*` key and has no contribution surface. But the inversion matters, because
the old plan relied on "do nothing" meaning "off":

- To ship prod with support **on**, set the live Payment Link secrets (`C3`/`C5`) **before
  the iOS contribution surface ships**. An enabled card with an empty `url` is a button
  that goes nowhere — `SupportMoneyConfigService`'s "an empty URL is inert" guarantee
  holds only while `enabled` is `false`.
- To ship prod with support **off**, set the `SUPPORT_MONEY_ENABLED` repository secret
  explicitly to `false`. Leaving it unset no longer achieves this.

Also changed in `.env.defaults`: `SUPPORT_MONEY_MIN_BOARDS` and `SUPPORT_MONEY_MIN_DAYS`
2/3 → **1/1**, so the contextual banner is reachable on a fresh install. Owner's
decision, product trade only.

> Without `STRIPE_WEBHOOK_SECRET` the webhook answers **503** and refuses to process —
> deliberately fail-closed. It is not a soft failure.

### ☑ C6 — nginx — VERIFIED 2026-09-01, NO CHANGES NEEDED

Checked against the running config. Everything this release needs is present,
and the two things that must be absent are absent:

| Check | State |
|---|---|
| `location = /api/v1/stream` | ✅ present, full correct WebSocket block |
| `location /assets/` | ✅ present — the widget-guide asset resolves |
| `/reset-password`, `/verified`, `/open`, `/icons/`, `/docs`, `/openapi.json` | ✅ present |
| `/api/v1/` | ✅ present — also covers the Stripe webhook and the support-money return page |
| catch-all `location /` on 443 | ✅ **absent**. `location = /` is an EXACT match and does not count |
| `/kiosk`, `/kiosk-api/`, `/kiosk-stream` | ✅ absent |

The live config also **dropped** the `/StationlyBE/` and
`/StationlySyncer/api/v1/admin/` blocks the old repo copy carried. That is an
improvement — do not reinstate them.

Re-verify both invariants after any future edit:

```bash
sudo nginx -T | grep -nE "^[[:space:]]*location[[:space:]]+/[[:space:]]*\{"   # MUST be empty
curl -sS -o /dev/null -w '%{http_code}\n' https://api.stationly.co.uk/internal/stream-stats
# MUST be 404 (nginx never routed it), never 403/503 (which would mean Node answered)
```

### ☑ C7 — GCP: grant the index role — DONE 2026-09-02

`roles/datastore.indexAdmin` granted to `firebase-adminsdk-fbsvc@stationly-prod.iam.gserviceaccount.com`
via the IAM console. The propagation lag is real and was observed again: the apply run
immediately after the grant failed `The caller does not have permission` on both fields,
and the retry ~60s later succeeded with no other change. Do not go hunting for a second
problem if you see this — wait and retry.


Grant `roles/datastore.indexAdmin` to production's `firebase-adminsdk-*` service
account. **Allow minutes for IAM propagation** — the first run after granting failed
with "The caller does not have permission" on staging and succeeded shortly after with
no other change.

### ☑ C8 — Create the indexes, and wait for them to build ⛔ — PASSED 2026-09-02

```
requested 19:50:41   both fields accepted (COLLECTION_GROUP ASCENDING)
19:53 / 19:55        both "That index is not ready yet"   = building
19:57:15             PASS — every query P2 depends on runs
```

**~6.5 minutes end to end**, which is the shape to expect on prod and NOT what staging
saw: an index build backfills existing data, and the prod `devices` collection group is
empty, so there was nothing to backfill. It will not be this fast anywhere with rows.

One observation worth keeping. Immediately after the apply, `deviceId` reported *"That
index is not ready yet"* while `lastSeen` still reported *"You can create it here"* —
i.e. the two fields disagreed about whether the request had landed at all. It was
propagation lag, not a failed request: `lastSeen` caught up within ~2 minutes and both
built normally. **Re-poll before concluding a field did not take.**


```bash
node src/scripts/ensure_device_indexes.cjs --key=$PROD_KEY
node src/scripts/check_device_indexes.cjs  --key=$PROD_KEY    # poll until PASS
```

Two **single-field** indexes at **COLLECTION_GROUP** scope, on `devices.deviceId` (the
login steal check) and `devices.lastSeen` (the sweep). Three traps, all of which cost
real time on staging:

- They belong in `fieldOverrides`, **not** `indexes`. A single-field entry under
  `indexes` is accepted, does nothing, and the deploy still goes green while the query
  still fails.
- `PATCH …/fields/{field}?updateMask=indexConfig` — `updateMask.fieldPaths=` is rejected
  outright by this REST surface.
- Builds are **asynchronous** and run against live data. The error text is the tell:
  *"You can create it here"* = absent; *"That index is not ready yet"* = building. **Wait.**

### ☐ C9 — Survey production, read-only, and record the numbers

```bash
node src/scripts/check_state_rev.cjs       --key=$PROD_KEY   # expect every account rev=0
node src/scripts/check_device_indexes.cjs  --key=$PROD_KEY   # also reports root `devices` size
node src/scripts/check_drift_reconcile.cjs --before --key=$PROD_KEY
node src/scripts/check_session_sweep.cjs   --before --key=$PROD_KEY
```

Write the outputs into §10. You compare against them in `D6` and `F1`.

**Two of these are already banked, as a side effect of `C8`'s probe on 2026-09-02:**

```
root collection('devices')          0 docs   ✓ EMPTY, as predicted for an Android-only fleet
collectionGroup('devices')          0 docs   ✓ no subcollection rows yet — the pre-migration state
```

The root collection being empty is the one that could have stopped the release, and it
did not: nothing other than iOS has ever written it, and prod has never had iOS. Still
outstanding here are `check_state_rev.cjs`, `check_drift_reconcile.cjs --before` and
`check_session_sweep.cjs --before`.

- **Confirm the root `devices` collection is EMPTY.** Only `/device/register` writes it
  and that is iOS-only. If it is not empty, **stop** and find out what wrote it.
- `check_session_sweep --before` will predict that **every account would be released**,
  with a note counting legacy `users.sessions` entries. That is correct and expected
  pre-backfill — see `A4`. It is not a reason to stop; it is the reason `D5` exists.

### ☐ C10 — Confirm the process manager

```bash
ssh <PROD_HOST> 'pm2 list'
```

Must show **1** instance. The workflow's `-i 1` sits on the `||` fallback, and
`pm2 reload` succeeds against an existing process and inherits its instance count — so
this deploy cannot reduce a running cluster. It matters more than usual now: line
statuses live **only** in per-process memory and the Syncer's ingest POST lands on
exactly one worker, so under `-i > 1` the other workers serve stale statuses until their
own 60s TfL fallback trips.

If it is not 1: `pm2 delete stationly-backend`, then let the next deploy cold-start it.

⛔ **GATE C** — `check_device_indexes.cjs` **PASSES**, root `devices` is empty, nginx
reloaded clean, `pm2 list` shows 1, and `C1`/`C2` hold the same secret.

---

## Phase D — the deploy window

**One unbroken sitting, ~1.5 h. Not a Friday.** Everything from `D1` to `D7` must
complete in the same session.

> **Why it cannot be split.** Between the deploy and the finished backfill, every
> account has `loggedIn: true` and no device rows. An ordinary Android sign-out in that
> window reaches `endSession`, finds an empty subcollection, and takes the *self-heal*
> branch: `remaining` is empty, so it deactivates the whole account even though the
> user's other devices are still signed in. Small window, rare action, costs nothing to
> avoid.

### ☐ D1 — Merge `release_staging` → `release_prod`

The PR is already open (opened automatically at `B2`). Merging pushes to
`release_prod`, which **deploys immediately**.

### ☐ D2 — Watch the deploy and the boot

Confirm the Actions run is green, then:

```bash
ssh <PROD_HOST> 'pm2 logs stationly-backend --lines 80 --nostream'
```

Look for: the port line, `DataCacheService` initialising, no `APNS:` read failure that
matters (prod has no `.p8` and that is fine — it degrades to "push not configured"), and
no SQLite errors. New tables (`user_watch`, `user_revs`, `stripe_events`) are created on
boot by `CREATE TABLE IF NOT EXISTS`, and column additions run through `migrate()` — no
manual SQLite work is needed.

### ☐ D3 — Smoke test before touching data

- `GET /api/v1/lines/status` with the prod app key → 200, and every item carries
  `reason` (may be `null`) and `mode`.
- `GET /api/v1/stations/predictions/<a busy naptan>` → 200.
- **Sign in on a real Android device.** This is the one that exercises the new
  `startSession` and the collection-group index. A 500 here means `C8` did not actually
  finish — stop and go back.

### ☐ D4 — Backfill, dry run — and read the output

```bash
node src/scripts/backfill_device_rows.cjs --key=$PROD_KEY --dry-run
```

Sourced from the `sessions` map alone on production (no root device rows, no APNs
tokens). Check the row count against the account count from `C9`.

> **Watch for rows typed `ios`.** `rowFrom` defaults `platform` to `'ios'` when the
> source session has none — a staging-era assumption. Android always sends
> `platform: "android"`, so on an Android-only database an `ios` row means a session
> entry written without `deviceInfo`. Cosmetic only (it cannot join an APNs audience
> without a token) but it is a tell worth understanding before you commit the write.

### ☐ D5 — Backfill for real

```bash
node src/scripts/backfill_device_rows.cjs --key=$PROD_KEY
```

Idempotent. Safe to re-run.

### ☐ D6 — Verify the backfill ⛔

```bash
node src/scripts/check_device_backfill.cjs --key=$PROD_KEY   # MUST PASS
node src/scripts/check_session_state.cjs   --key=$PROD_KEY   # MUST PASS
```

`check_device_backfill` restates the union and field mapping rather than importing them
— a probe that imports the merge agrees with it by construction, including when it is
wrong. `check_session_state` asserts `loggedIn` ⇔ at least one live device row, and that
no device is claimed by two accounts. **Both must hold.**

### ☐ D7 — Seed the push-audience index

In-process, over loopback. A second process fighting the server for the SQLite lock
fails **silently** — `UserWatchIndex` swallows its own errors.

```bash
ssh <PROD_HOST> 'cd ~/stationly-backend && \
  PORT=$(sed -n "s/^PORT=//p" .env|head -1); \
  SECRET=$(sed -n "s/^LIVESTREAM_INGEST_SECRET=//p" .env|head -1); \
  curl -s -X POST "http://127.0.0.1:$PORT/internal/maintenance/reindex-watch" \
       -H "X-Internal-Secret: $SECRET"'
```

> ⚠️ **You are one word away from `/internal/maintenance/sweep`.** The handover records
> a near-miss of exactly this class: *"a `curl` meant to prove the deployed code was
> stale once executed the sweep instead."* Paste, do not type.

### ☐ D8 — Promote and deploy the Syncer

Same three-hop in the StationlySyncer repo. **Backend first (done at `D1`) or
simultaneously** — never Syncer-first.

Then verify the ingest is actually landing:

```bash
ssh <PROD_HOST> 'cd ~/stationly-backend && \
  PORT=$(sed -n "s/^PORT=//p" .env|head -1); \
  SECRET=$(sed -n "s/^LIVESTREAM_INGEST_SECRET=//p" .env|head -1); \
  curl -s "http://127.0.0.1:$PORT/internal/stream-stats" -H "X-Internal-Secret: $SECRET"'
```

New Syncer defaults that go live with no config from you:
`livestream.enabled=true`, `livestream.backend-url=http://127.0.0.1:3000`,
`livestream.timeout=2`, `tfl.arrival-departures.enabled=true`,
`tfl.arrival-departures.max-calls-per-cycle=60`. That last pair adds real TfL board
calls per cycle — **watch the TfL rate budget on day one.**

### ☐ D9 — Stripe, end to end on production

With `SUPPORT_MONEY_ENABLED` still unset, the card is not served — but the webhook path
is live and must be proven now, not on the day the first real contribution arrives.

1. Stripe dashboard → the webhook endpoint → **Send test event**. Expect **400**
   (`livemode` fence: a test event against production is refused). That 400 is a **pass**
   — it proves the endpoint is reachable, the signature verified, and the fence works.
2. Make one **real, small live contribution** through the `T4` link with
   `?client_reference_id=<a real prod uid>` appended by hand.
3. Confirm in the logs: `SUPPORT_MONEY: ✅ contribution #1 recorded for <uid>`.
4. Confirm `users/{uid}.supportMoney` exists in Firestore.
5. Confirm the redirect landed on the branded return page.
6. Refund it in Stripe. The refund is not a handled event type, so the badge stays —
   clear `supportMoney` on that test account by hand if you care.

> If you see **503**, `STRIPE_WEBHOOK_SECRET` did not reach the box — check the Actions
> log for `⚠️ Warning: STRIPE_WEBHOOK_SECRET is empty` and re-check `A6` and `C5`.

⛔ **GATE D** — `D6` both PASS, an Android device signs in cleanly, the stream stats show
Syncer ingest, and the Stripe test contribution recorded.

---

## Phase E — soak

**Days, not hours. 5 days.** The legacy stores are still present, nothing reads them,
and real logins are exercising the new rows. This costs nothing and is the only free
insurance in the plan.

### ☐ E1 — Daily, each morning

- [ ] No user reports of being signed out — **nothing signs anyone out yet.**
- [ ] Push still arriving (it goes through `fcm_tokens`, untouched).
- [ ] `node src/scripts/check_session_state.cjs --key=$PROD_KEY` still passes.
- [ ] `pm2 logs` — no repeated errors; `p95` on `/user/sync/profile` sane (the new
      `checkRevoked: true` adds a Firebase Auth lookup per authenticated request).
- [ ] Identity Toolkit quota in the GCP console not climbing toward a limit.

Record each day's result in §10.

---

## Phase F — enable maintenance

### ☑ F1 — SWEEP DISABLED 2026-09-02 — no longer a deploy-day task

**Superseded by `A10`.** `SWEEP_ENABLED = false` in the service, and the sweep line is
commented out of `ops/maintenance.crontab`. Nothing to run here, and nothing to gate.

The reason is not the cutover: it is that `lastSeen` does not yet measure what the job
assumes. See `A10` for the mechanism and the conditions for bringing it back. When it
does come back, this task returns as written below and is a ⛔ gate again.

<details><summary>The original F1, kept for when sweep returns</summary>

```bash
ssh <PROD_HOST> '~/stationly-backend/ops/maintenance_cron.sh sweep'
ssh <PROD_HOST> 'cat ~/logs/maintenance.log'
```

**`released` MUST be empty, or a number you can explain account by account.** A large
release here is the failure this entire ordering exists to prevent — it means the
backfill did not cover everyone. If it is not empty and not explained: **stop**, do not
install the crontab, and reconcile the accounts by hand.

</details>

### ☐ F2 — Run reconcile by hand

```bash
ssh <PROD_HOST> '~/stationly-backend/ops/maintenance_cron.sh reconcile'
node src/scripts/check_drift_reconcile.cjs --after --key=$PROD_KEY
```

Then grep the log for `loggedIn true→false heal SKIPPED`. With `HEAL_TRUE_TO_FALSE`
still `false` (`A1`), this run is a **rehearsal**: every line names an account that
*would* have been released. Zero lines is the expected result after a clean backfill.
Any lines are a list of accounts to investigate before `G3` turns the heal on.

### ☐ F3 — Install the crontab, and prove cron can exec it

```bash
ssh <PROD_HOST> 'crontab ~/stationly-backend/ops/maintenance.crontab && crontab -l'
```

Then canary: append a `* * * * *` copy of the **reconcile** line, wait two minutes,
confirm two new log lines, reinstall the clean crontab. (It used to say the sweep line;
that line is commented out as of `A10`, and a canary of a commented-out job proves
nothing. Reconcile is idempotent, so running it twice a minute apart is harmless.)

Installing the crontab proves a file is in place, **not** that cron can exec it — `PATH`,
`HOME`, the exec bit and `.env` readability are all still unproven until a line actually
fires. That is the whole point of the canary.

**Check the host timezone separately.** Staging is `Etc/UTC`, which puts `0 3 * * *` at
04:00 London under BST. Do not assume prod matches.

### ☐ F4 — Two clean scheduled nights

⛔ **GATE F** — two scheduled reconciles have fired on their own, `check_drift_reconcile.cjs
--after` is clean, and there are zero unexplained `loggedIn true→false heal SKIPPED`
lines.

_Was "`released` empty across two scheduled sweeps" — there are no scheduled sweeps any
more (`A10`). The heal rehearsal in `F2` is now the only release signal, and it is still
the thing `G2` depends on._

---

## Phase G — cleanup and finish

### ☐ G1 — Delete the legacy stores

```bash
node src/scripts/cleanup_legacy_stores.cjs --key=$PROD_KEY --dry-run
node src/scripts/cleanup_legacy_stores.cjs --key=$PROD_KEY     # typed confirmation
node src/scripts/check_session_state.cjs   --key=$PROD_KEY
```

Removes `users.sessions`, `address`, `phoneNumber`, `preferences` and the root `devices`
collection. **It does not touch `users/{uid}/fcm_tokens`** — that store stays live; it
is Android's only push channel and cannot be keyed by device.

### ☐ G2 — Turn the heal back on

Flip `HEAL_TRUE_TO_FALSE` to `true` on `dev_13Jul` and promote through all three
branches. Only now: with the old stores gone there is no stale source left for it to
ratify.

### ☐ G3 — Close out

- Update `docs/HANDOVER_SESSION_SYNC.md` §1's phase table — production is no longer ❌.
- Update this file's STATUS block to `COMPLETE`.
- Delete the `revert-116-dev_13Jul` / `revert-118-release_staging` remote branches if
  they are still not wanted (verified: never merged into any release branch).

### ☐ G5 — Later: bring `sweep` back

A separate piece of work, not part of this cutover. In order:

1. **Make `lastSeen` measure app USE, not sign-in.** Either the Android client calls
   `syncProfile` at cold start, or add a cheap `POST /user/session/touch` that only bumps
   `lastSeen`. The existing once-a-day write elision (`SESSION_REFRESH_MS`) already caps
   the cost either way.
2. **Re-confirm the client call site in `StationlyUI` at that point** rather than trusting
   the comment in `sessionMaintenanceService.ts` — it records what was true in 09/2026.
3. Wait out one full TTL, or accept that the first sweep after the change judges accounts
   on a clock that only just started.
4. Flip `SWEEP_ENABLED` to `true`, uncomment the crontab line, and run `F1` as originally
   written — by hand first, reading `released` account by account.

### ☐ G4 — Later: switch Stripe on

**Rewritten 2026-09-02.** This used to say "set `SUPPORT_MONEY_ENABLED=true` as a prod
secret and redeploy". The default is now `true` (`.env.defaults`), so the switch is
already on and this task inverts: what is left is making sure it points at something.

Before the iOS client ships a contribution surface, `C3`–`C5` must have set the live-mode
Payment Link URLs and `STRIPE_WEBHOOK_SECRET` as prod secrets. Until then production
serves an enabled support card with empty checkout URLs — harmless while no client reads
them, a dead button the moment one does.

If iOS is going to ship before the Stripe wiring is done, set the `SUPPORT_MONEY_ENABLED`
repository secret to `false` to override the default, rather than leaving it unset.

---

## 9. Rollback

| Phase | If it goes wrong |
|---|---|
| A, B | Ordinary git. Nothing is deployed. |
| C | All additive. Indexes can be left in place harmlessly; nginx is one `git`-tracked file and a reload. |
| **D, before `D5`** | Revert `release_prod` to the previous commit and let Actions redeploy. No data has been written. |
| **D, after `D5`** | The backfill is **additive** — it creates device rows and changes nothing else. Reverting the code leaves orphan rows that nothing reads. Safe. |
| E | Same as D-after-`D5`. |
| **F, after `F1` released accounts** | **Not cleanly reversible.** Re-activation requires each user to sign in again, and purged `fcm_tokens` do not come back until the user signs out and in (which clears the client watermark). This is why `F1` is a gate. |
| G1 | **Irreversible.** The legacy stores are deleted. Only run it after `F4`. |

There is no database backup step in this plan because there is no Firestore export
configured. **If you want one, take it before `D5`** — that is the last moment it is
cheap and the first moment it matters.

---

## 10. Session log

Append one block per session. Newest at the bottom. **Never rewrite history
here** — if an earlier entry turned out to be wrong, say so in a later one.

```
### 2026-09-01 (a) — review and planning
Did:      Full review of dev_13Jul vs main (31 commits, 92 files outside web-temp).
          Android compatibility audit against StationlyUI@master (v1.0,
          versionCode 2) — derived from APK source, not taken from the handover.
Result:   NO change breaks the shipped Android build. Load-bearing reasons:
          ignoreUnknownKeys=true in NetworkModule; the 4 required profile keys
          are pinned by ANDROID CONTRACT tests; 77 of 78 SDUI keys the APK reads
          are served (the 78th is missing on main too, and is fallback-guarded);
          the version gate cannot fire three ways over; the Syncer emits
          "reason": null so LineStatus still decodes.
Found:    4 blockers — A1, A2, A3, and the C8 index dependency.
          Stale runbook text (A4). Stripe keys never exported by the prod
          workflow (A6).
Verified: tsc clean, npm test 210/210.
Changed:  Nothing in the repo.
Next:     A1.

### 2026-09-01 (b) — Phase A, and C6
Did:      A1  HEAL_TRUE_TO_FALSE -> false, and rewrote its doc comment: it had
              read as "ENABLED, preconditions met", which is true of staging and
              false of production. Now records why, and points at G2.
          A2  maintenance_cron.sh + maintenance.crontab moved to a tracked ops/.
              3 path refs updated. Exec bit confirmed 100755 via git ls-files -s.
              bash -n clean. Header rewritten to explain why .scripts/ was unsafe.
          A3  .gitignore allowlist extended with the two index JSONs. Confirmed
              serviceAccountKey.json is STILL ignored and that those two files
              are the ONLY things newly visible to git.
          A4  4 corrections in HANDOVER_SESSION_SYNC.md, including the Step 1
              text that wrongly claimed check_session_sweep.cjs reads the old
              store. It was fixed at some point and the doc never caught up.
          A5  See the correction below — this task changed shape mid-session.
          A6  8 Stripe/support keys exported from the prod workflow env block.
          C6  Closed as VERIFY-ONLY.
Verified: tsc silent; npm test 210/210; workflow YAML parses; and the check that
          actually matters for A6 — every key in .env.remote is now exported by
          the workflow (comm diff empty; 8 were missing before).

CORRECTION to A5 as originally planned:
          The plan said "add the missing /assets/ block to the repo's nginx copy".
          On reading the LIVE vhost, both predictions in the review were WRONG —
          /assets/ and the = /api/v1/stream block were already present. nginx
          needs no changes at all for this release.
          The real problem was the repo copy itself: a DIFFERENT and worse file
          than production (wrong TLS cert path, no keepalive, no security
          headers, no server-level proxy_set_header, and a
          /StationlySyncer/api/v1/admin/ block exposing the Java syncer admin
          route). Anyone treating it as authoritative and copying it onto the box
          would have broken TLS and stripped every security header.
          A5 was therefore redone as a verbatim MIRROR of the live config plus
          comments, with a header recording that truth flows BOX -> REPO.
          Verified MD5-identical to the live file once comments are stripped.

NEW FINDING -> task C0:
          The production .env is hand-maintained and NOT reproducible from the
          repo. Verified: .env.remote does not exist on main, and main's workflow
          never exported LIVESTREAM_INGEST_SECRET — yet the box has a value.
          The D1 deploy REGENERATES .env from .env.defaults + .env.remote using
          repository secrets, so any value not backed by a GitHub secret is
          silently dropped. The assembly loop only warns; the deploy still goes
          green. Five secrets to confirm before D1.
          Not a security hole: the /internal guard fails CLOSED on an unset
          secret (503). The failure mode is a silently degraded live stream.

GAP, undecided -> task A9:
          Nothing pins HEAL_TRUE_TO_FALSE in the test suite. It is not exported,
          so a test cannot reach it. That is exactly how it arrived set to `true`.

State:    NOTHING COMMITTED. All Phase A work sits in the working tree; ops/ is
          staged only. See the STATUS block for the file list.
Next:     A8 (needs approval), then C0, then C7.

### 2026-09-02 — sweep disabled (A10)
Did:      Read-back of the programme for the user, in plain terms. The question
          "does this mean a user signed in but not opening the app for 90 days
          gets logged out" turned up a real defect, distinct from the cutover
          hazard the plan was already built around.
Found:    sweep's 90-day TTL reads `lastSeen`, refreshed only by `startSession`
          <- `POST /user/sync/profile`, which the shipped Android build calls on
          EXPLICIT SIGN-IN ONLY. So the predicate means "has not signed in for
          90 days", not "has not opened the app". A daily user who signed in
          once matches it, and the release is silent + non-self-healing (stale
          board, dead push). Traced through the code this session:
          sessionMaintenanceService.sweep -> UserService.endSession(uid) ->
          applySubscriptionDelta + DeviceLifecycleService.release.
          The Android call-site half is the handover's audit of StationlyUI, NOT
          re-verified here — G5 step 2 exists to close that.
          This is NOT the §1 hazard: that one is temporary and the backfill
          closes it. This one survives the backfill and first bites ~90 days
          after go-live, on active users.
Decision: user's call — sweep waits for another iteration; reconcile ships. It
          is reconcile that does the drift repair the crons were built for, and
          without sweep the registry only ever over-counts, which is the safe
          direction by design.
Changed:  A10 — SWEEP_ENABLED = false (compile-time, no env override, same
              mechanism as HEAL_TRUE_TO_FALSE) + early return logging
              `sweep SKIPPED`, returning the normal shape with empty `released`.
              Sweep line commented out of ops/maintenance.crontab; header
              rewritten to say why and to warn that uncommenting alone is a
              no-op.
          F1 closed as superseded (original kept in a <details> for G5).
          F3 canary switched from the sweep line to the reconcile line — a
              canary of a commented-out job proves nothing.
          F4 gate restated around reconcile + the heal rehearsal.
          G5 added: the conditions for bringing sweep back.
Verified: tsc silent; npm test 210/210. Active crontab lines are now exactly
          SHELL, PATH and the 20 3 * * * reconcile.
Not done: no test pins SWEEP_ENABLED, for the same reason A9 is open — it is not
          exported. If A9 is taken, cover both constants in one change.
Next:     unchanged — A8 (needs approval), then C0, then C7.

### 2026-09-02 (b) — indexes live on production; Stripe sandbox move
Did:      C7  roles/datastore.indexAdmin granted to
              firebase-adminsdk-fbsvc@stationly-prod.iam.gserviceaccount.com.
          C8  ensure_device_indexes.cjs --dry-run (confirmed project
              stationly-prod and BOTH indexes absent), then apply, then polled
              check_device_indexes.cjs to PASS. ~6.5 min total.
          C11 secret rotation DEFERRED by the user's decision. C0 unblocked.
          Stripe staging links repointed to the new Stationly-staging sandbox.
Result:   PRODUCTION INDEXES ARE LIVE AND VERIFIED. The C8 gate on D1 is passed.
          Both C9 index-adjacent numbers banked: root collection('devices') 0
          docs, collectionGroup('devices') 0 docs.
Observed: 1. The IAM grant needs ~1 min to propagate — the first apply failed
             "The caller does not have permission" on BOTH fields, the retry
             succeeded unchanged. Documented on staging, reproduced here.
          2. NEW, not seen on staging: straight after the apply the two fields
             DISAGREED — deviceId said "That index is not ready yet" (building)
             while lastSeen still said "You can create it here" (absent). That
             is propagation lag, not a failed request; lastSeen caught up in
             ~2 min. Re-poll before concluding a field did not take.
          3. ~6.5 min is NOT a general expectation. An index build backfills
             existing data and the prod devices collection group is EMPTY.
Changed:  .env only (local, gitignored) — the 4 SUPPORT_MONEY_PAYMENT_URL_*
          values repointed from the old sandbox (…dMI0x) to the new
          Stationly-staging one (…c7u0x):
              T4 -> c7u01 (GBP 4)    T8     -> c7u02 (GBP 8)
              T12 -> c7u03 (GBP 12)  ONEOFF -> c7u00 (GBP 15 preset)
          They reach staging only on the next staging_deploy.sh run, which
          resolves each key from STAGING_<KEY> then the local .env.
          No repo file changed for Stripe. tsc silent, npm test 210/210.
OPEN, and it fails SILENTLY:
          STRIPE_WEBHOOK_SECRET in the local .env is still the OLD sandbox's.
          Signing secrets are per-endpoint per-account, so after the move
          checkout SUCCEEDS (the links are just URLs) and the webhook is then
          rejected on signature (400, "signature rejected",
          stripeWebhookController.ts:55) — money taken, supporter status never
          granted. A new endpoint must be created in the Stationly-staging
          sandbox and its whsec_ copied in before staging is redeployed.
          Not a blocker for the cutover; Stripe is dormant on prod until G4.
RESOLVED: the ONEOFF preset is GBP 15, not the GBP 8 the doc used to specify.
          User's call, and GBP 15 is now the norm — SUPPORT_CONTRIBUTIONS.md
          lines 152/176 updated to match. The preset lives on Stripe's own page
          and is never served, so nothing in the backend reads it; t8 remains
          default_tier_id, which is a separate thing (the pre-selected TIER on
          the sheet, not the custom-amount prefill).
          STILL TO CONFIRM: the link's MIN/MAX must stay GBP 1 / GBP 500. Those
          ARE asserted in the served config as custom_amount.min_minor 100 /
          max_minor 50_000, so a Stripe-side limit outside that range lets the
          client offer an amount Stripe then refuses.
          STRIPE_WEBHOOK_SECRET for the new sandbox endpoint is now set in the
          local .env; it reaches the box on the next staging_deploy.sh.
Next:     A8 (needs approval), then C0, then the rest of C9.

### 2026-09-02 (c) — staging deploy + full Stripe/maintenance verification
Did:      Ran ./.scripts/staging_deploy.sh (WORKING TREE, not a clean checkout —
          this does NOT satisfy B3). Then reinstalled the crontab at the new
          ops/ path and exercised every changed surface on the box.
CONFIRMED THE A2 HAZARD WAS REAL, on a live box:
          rsync runs with --delete and .scripts/ is NOT excluded, so the deploy
          DELETED .scripts/maintenance_cron.sh from staging while the installed
          crontab still pointed at it. Both cron lines would have failed
          "No such file or directory" at 03:00 tonight, silently. This is
          exactly the failure A2 predicted for production, observed for real.
          ops/ arrived intact: maintenance_cron.sh mode 755, both files present.
Verified on the deployed build:
          crontab   reinstalled from ops/maintenance.crontab; the only active
                    line is now `20 3 * * * ops/maintenance_cron.sh reconcile`.
                    The sweep line is commented out as intended.
          reconcile MANUAL RUN AT THE NEW PATH OK — 19:30:51Z
                    usersScanned 8, loggedInHealed [], countsChanged 0,
                    countsDeleted 0, watchAccountsIndexed 7, 2322ms.
                    Registry is stable; no drift to repair.
          sweep     GATE WORKS — 19:31:38Z {"scanned":0,"released":[],
                    "durationMs":0} and the server logged
                    "MAINTENANCE: sweep SKIPPED — SWEEP_ENABLED is off", HTTP 200.
                    The early return fires before any Firestore read.
          Stripe    GET /sdui/app/support-money-config serves all four NEW
                    sandbox links, correctly mapped and each with
                    ?client_reference_id={uid} appended:
                      t4 -> c7u01   t8 -> c7u02   t12 -> c7u03
                      cta.url_oneoff -> c7u00
                    enabled:true, default_tier_id t8, custom_amount
                    min_minor 100 / max_minor 50000 (unchanged, as required).
          webhook   POST /api/v1/webhooks/stripe unsigned -> 400, NOT 503.
                    That distinction is the proof STRIPE_WEBHOOK_SECRET actually
                    reached the box: 503 means unset, 400 means set and the
                    signature was checked and rejected.
          return    GET /api/v1/support-money/return?tier=t8&amount=8 -> 200 and
                    bounces to stationly-staging://support-money/thanks?tier=t8&
                    amount=8 — scheme correct, params passed through.
          Two prior scheduled nights were clean (01/09 and 02/09, sweep released
          nothing, reconcile changed nothing).
NOT DONE: B3 is still open. staging_deploy.sh rsyncs the WORKING TREE, so this
          proves the code works, NOT that what is committed works — which is the
          entire point of B3 and the gap that let .scripts/ stay untracked for
          months. B3 must still run from a clean checkout after A8.
          B4's cron canary (prove cron can EXEC it, not just that the file is in
          place) also still open — the manual run proves the script and the path,
          not cron's PATH/HOME/exec-bit.
Next:     A8 (needs approval), then B1-B3.
```

---

## 11. Appendix — production environment matrix

| Variable | Source | Prod value | Notes |
|---|---|---|---|
| `APP_ENV` | workflow | `production` | drives `isStaging()`, the APNs topic, the URL scheme and the Stripe livemode fence |
| `APP_BASE_URL` | workflow | `https://api.stationly.co.uk` | |
| `APP_WEB_URL` | workflow | `https://stationly.co.uk` | |
| `TFL_APP_KEY` | secret | set | |
| `FIRESTORE_PROJECT_ID` | secret | `stationly-prod` | |
| `RESEND_API_KEY` | secret | set | |
| `STATIONLY_ADMIN_KEY` | secret | set | admin console |
| `LIVESTREAM_INGEST_SECRET` | secret | **`C1`** | must equal the Syncer's |
| `STRIPE_WEBHOOK_SECRET` | secret | **`C5`** | absent ⇒ webhook 503s |
| `SUPPORT_MONEY_PAYMENT_URL_{T4,T8,T12,ONEOFF}` | secret | **`C5`** | live-mode links |
| `SUPPORT_MONEY_ENABLED` | secret | **unset** | `false` via defaults until `G4` |
| `VERSION_GATE_ENABLED` | defaults | **unset** | `false`. Never raise the Android floor above `1.0` — it is the only build in the Play Store |
| `FIREBASE_KEY_PATH` | defaults | `/home/ubuntu/config/firebase-service-account.json` | deployed out of band |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_P8_PATH` | defaults | present, key file absent | iOS only; a missing `.p8` logs and degrades, it does not fail boot |
| `SUPPORT_MONEY_BADGE_DURATION_DAYS` | defaults | `30` | must match the client's `badge.duration_days` |
| `SUPPORT_MONEY_MIN_BOARDS` / `_MIN_DAYS` | defaults | `2` / `3` | banner thresholds |
| `LINE_STATUS_TTL_MS`, `PREDICTION_CACHE_*` | — | unset | tuning knobs; module defaults apply |
| `STATIONLY_URL_SCHEME`, `APNS_BUNDLE_ID` | — | unset | derived from `APP_ENV` |
| `STRIPE_ALLOW_LIVEMODE_MISMATCH` | — | **unset** | one-off replay escape hatch. Never leave it set |

### Probe reference

All read-only unless marked. All take `--key=` and all print their project id.

```
check_session_sweep.cjs      read-only   --before / --after
check_drift_reconcile.cjs    read-only   --before / --after / --email= / --uid=
check_state_rev.cjs          read-only   master vs ledger
check_device_indexes.cjs     read-only   RUNS the real queries; reports root collection size
check_device_backfill.cjs    read-only   union + field mapping + token-loss
check_session_state.cjs      read-only   loggedIn/device invariants
ensure_device_indexes.cjs    WRITES      idempotent; --dry-run
backfill_device_rows.cjs     WRITES      idempotent; --dry-run, --uid=
run_maintenance.cjs          WRITES      triggers a job with no HTTP server
cleanup_legacy_stores.cjs    ⚠️ DESTRUCTIVE — the only one. --dry-run first
```

`src/` is excluded from both deploy paths, so none of these ever reach a host. They are
developer tools that reach Firestore directly with an explicit `--key=`.
