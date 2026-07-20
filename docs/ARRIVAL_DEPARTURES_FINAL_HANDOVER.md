# Prediction Sources — Final Handover (2026-07-19)

**Status: COMPLETE, staging-verified, zero regressions. NOT committed / NOT pushed /
prod untouched** (per user instruction). Working tree on `dev_13Jul`, deployed to
staging (79.72.94.209) via `./.scripts/staging_deploy.sh`. Companion doc in
StationlySyncer: `docs/ARRIVAL_DEPARTURES_FINAL_HANDOVER.md`. This page is the
single consolidated record — the per-session working notes were removed by user
decision on 2026-07-19 after consolidation.

## 1. What & why

`GET /api/v1/stations/predictions/{naptanId}` used to build every station from TfL's
Countdown arrivals feed. At Elizabeth-line/Overground termini that feed only sees the
inbound working → users got "Check Front of Train" rows and junk "due now" rows
instead of real departures, and cancelled trains were shown as running (the feed has
no status concept). TfL's `ArrivalDepartures` board (XR/OG only — same product
tfl.gov.uk renders) fixes all of it.

## 2. Architecture (`src/services/predictionSources/`)

Strategy pattern, one source per station chosen from locally-stored station modes:

- `PredictionSource.ts` — interface (`supports`, `buildStationPredictions`); ctx
  carries naptanId, station record, and the countdown arrivals as a PROMISE (board
  calls overlap the arrivals fetch — saves ~1 TfL round-trip per live fetch).
- `TubeDlrBusTramMixPredictionSource.ts` — VERBATIM port of the pre-factory
  controller loop; serves tube/dlr/bus/tram, unknown naptanIds, and per-line board
  fallback. ONE shared instance (factory-owned, injected into the board source).
- `ElizabethOvergroundPredictionSource.ts` — board source for all 154 XR/OG
  stations (`some()` gate on modes). Per-line board calls (entries carry no lineId —
  verified live), row filters (§4), 4-pass direction chain (§5), per-line countdown
  fallback ("board can only add, never blank"), duplicate-row collapse.
- `PredictionSourceFactory.ts` — registration-ordered SOURCES + universal fallback.
  Future: `DarwinPredictionSource` for national-rail slots in here.
- `predictionUtils.ts` — shared filters (departed cutoff, far-future-unassigned,
  name cleaning, route resolvers). `formatters.ts` exports `isUnassignedPlatform` +
  `UNASSIGNED_PLATFORM_LABEL` so filter and display copy can never drift.
- Controller (`stationController.ts`) is 5-line glue; logs `PRED: 🔀 {id} → {source}`.

## 3. Behaviour deltas vs prod (complete list — everything else byte-identical)

1. Termini: real destination + true departure time replaces "Check Front of Train".
2. `Delayed` board rows survive the 2-min departed filter (TfL curates their lifecycle).
3. Empty-arrivals responses carry the real station name from the local DB.
4. Board direction bucketing (§5) — never splits a direction prod kept uniform.
5. Board works with zero live arrivals (quiet-hour timetable from board).
6. **Cancelled/NotStoppingAtStation trains are never returned** (countdown can't
   express cancellation, so prod shows them as running — verified live: Farringdon
   Sunday 06:30, 6 cancelled trains on prod, correctly absent on staging).
7. **Full board horizon**: far-future board rows are kept even unplatformed
   (tfl.gov.uk shows them; the 20-min unassigned rule now applies to countdown noise
   only — Hackney/Highbury evidence). Corollary: >15-min OG rows may read
   "Platform not assigned" where prod's countdown hardcoded a platform.

## 4. Board row filters (toBoardRow, in order)

lineId-mismatch skip (defensive) → status ∈ {Cancelled, NotStoppingAtStation} skip →
eta = estimatedTimeOfDeparture ?? scheduledTimeOfDeparture, no-eta skip (still-inbound
workings) → destination==self skip → non-Delayed 2-min departed skip → duplicate
collapse on `lineId|destId|eta|rawPlatform` (TfL transiently emits workings twice —
observed live).

## 5. Direction chain (board rows carry no direction) — CORRECTED order

Pass 1 per row: destination→direction map learned from countdown arrivals
(conflict-dropped) → "inbound" in platform text → platform→direction map
(conflict-dropped, real platforms only) → route direction IF route not contradicted
by live labels. Pass 2: inherit from resolved rows on same real platform
(conflict-dropped). Pass 3: line uniformity. Pass 4: terminus departing direction →
'outbound'. **Destination-map-first + conflict-drops are load-bearing**: TfL labels
disagree per platform (Romford Platform 5: Gidea Park=inbound, Shenfield=outbound);
platform-first lookup flipped Shenfield vs prod (caught live run 2, fixed same day).

## 6. Validation evidence (all on 2026-07-19)

- Offline: harness fed identical fixtures to old vs new code (18-Jul session).
- Staging-vs-prod comparator (`.scripts/compare_predictions.mjs`, 18-station
  matrix, 4 runs pre-service→midday): **all mix stations byte-identical every run**
  (e.g. Oxford Circus 39-43 exact matches/run). Board stations: only deltas #1-#7.
  Flagship: Abbey Wood prod = 16 junk "due now" + 16 CFT rows; staging = 16 real
  departures (HT4/Reading/Maidenhead @ 7-8min headways, correct platforms).
- Push-vs-REST cross-system differ: 0 unexplained Syncer payload rows across 4
  board stations (see Syncer handover).
- Interpreting comparator flags — before treating PROD-ONLY ⚠️ as regression check:
  eta≈fetch-second → prod junk ghost class; platform label mismatch (P7 vs
  "Platform not assigned") → same train, delta #7 corollary; raw board
  `departureStatus` → cancellation (delta #6).
- Code review: 8-angle pass; all findings fixed or dispatched (fixed: arrivals∥board
  parallelization, case-contract hardening, direction-chain reorder, duplicate
  collapse, horizon fix, single fallback instance, shared platform-label constant;
  accepted/deferred: per-direction fallback granularity, cold-start gate).

## 7. Known gaps / follow-ups

- Multi-mode naptanId payload alternation (Syncer, PRE-EXISTING):
  https://github.com/MaverickNyk/StationlySyncer/issues/56 (LivSt/Stratford/Romford
  + Kew-class; verify StationlyUI merges lines by lineId first).
- Cancelled trains dropped silently — rendering tfl.gov.uk-style "Cancelled" needs a
  pred `status` field (schema + app work).
- Cold start: `server.ts` accepts traffic before `DataCacheService.initialize()`
  resolves → brief prod-identical window post-restart (readiness gate someday).
- Kew Gardens-class OG rows on tube naptans stay countdown-served (as prod).
- One late-night (~23:30+) comparator run still recommended before merge.

## 8. Ops runbook

- Deploy staging: `./.scripts/staging_deploy.sh` (working tree; prod stays on main).
  Rollback: redeploy `main` — schema unchanged, no migrations.
- Verify: `PROD_API_KEY=… STAGING_API_KEY=… node .scripts/compare_predictions.mjs
  [naptanId …]` (client keys: per-env `api_keys` sqlite; local sqlite = staging keys;
  prod via `ssh -i ~/workspace/Projects/Stationly/Env/Prod/ssh/prod_main_key
  ubuntu@141.147.91.64`). Interpretation: §6.
- Logs: backend routing `PRED: 🔀` (pm2 out log), fallback warns on stderr log.
- New prediction-source files are `git add -N`'d so `git diff HEAD` shows everything.
