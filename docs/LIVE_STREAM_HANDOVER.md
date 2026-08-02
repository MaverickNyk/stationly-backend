# Live departure stream + shared prediction cache — handover

**Status: stations deployed to staging and verified end-to-end (2026-07-31). Line status added 2026-08-01, not yet deployed.**

**Reviewed 2026-07-31.** Fixes applied since the first cut: the `/internal` body
limit (the stream would have stalled silently under load — §4), a double-auth
race that leaked the routing table (§4), and the `streamHits` double-count.
`npm test` now exists: 27 assertions over the cache and the hub. The staging
nginx config is now committed at `server-config/nginx.staging.conf`.

`wss://staging-api.stationly.co.uk/api/v1/stream` is live. Watch real departures with:

```bash
node .scripts/watch_stream.mjs 910GHTCHEND      # Hatch End (Overground/Lioness)
```

---

## 1. Why this exists

Two problems, one solution.

**iOS could not keep a widget fresh.** Proven on-device: iOS **silently drops** the Syncer's silent pushes (`apns-push-type: background`, `priority 5`, `content-available`) while accepting alert pushes at the same moment on the same device. Everything else in the chain was healthy — Syncer publishing, FCM accepting, APNs credentials valid, topics subscribed. So the whole iOS widget path only ever updated when the app was opened. Full evidence in the `ios-widget-refresh` memory.

**TfL was being called twice for the same data.** The Syncer already fetches every subscribed station every 30s. The REST endpoint independently re-fetched the same stations whenever its 60s SQLite cache lapsed. We hit real `429 Too Many Requests` during testing.

A WebSocket fixes the first (foreground, sub-second, one KMP client serves Android + iOS + web). A shared cache fixes the second.

---

## 2. Architecture

```
TfL ──► Syncer poll (30s) ──► ChangeDetectionService
                                 ├──► fcmService.publishAll()          (unchanged, Android)
                                 └──► liveStreamPublisher.publishAll() (new, enqueue-only)
                                          │
                                          ▼  POST 127.0.0.1:3000/internal/station-updates
                                    PredictionCache  ◄──── REST TfL fetch (cache miss)
                                          │
                                          ├──► StationStreamHub ──► WebSocket subscribers
                                          └──► GET /api/v1/stations/predictions/:id
```

The cache is the centre of gravity: **both producers write to it, both consumers read from it.** A Syncer push spares a later REST caller a TfL call; a REST fetch for a station nobody subscribed to (so the Syncer never polls it) serves anyone streaming it. And REST and the stream can no longer disagree, because there is only one copy.

### Files

| File | Role |
|---|---|
| `src/services/predictionCache/` | The shared store (module dir: `index` barrel, `PredictionCache`, `types`, `README`) |
| `src/services/stationStreamHub.ts` | Routing only — `naptanId → Set<socket>`. Owns no payloads. |
| `src/services/stationStreamServer.ts` | WS server, upgrade handling, auth, subscribe protocol |
| `src/routes/internalRoutes.ts` | Syncer → backend ingest |
| `src/server.ts` | `http.createServer` (was `app.listen`), mounts, graceful shutdown |
| `.scripts/watch_stream.mjs` | Dev client — connects, authenticates, renders a live board |
| `src/services/lineStatusStreamHub.ts` | Line-status routing — `lineId → Set<socket>`. Shares the station socket; owns no payloads |
| `src/services/streamPrefetch.ts` | Cold-station TfL prefetch behind an existence gate, per-socket budget and a global concurrency cap |
| `src/tests/run.ts` | `npm test` — 46 assertions, no test framework |
| `server-config/nginx.staging.conf` | The live staging nginx, verbatim. **Includes the stream block.** |
| `StationlySyncer/.../service/LiveStreamPublisher.java` | Syncer-side dispatcher |

**Read `src/services/predictionCache/README.md` before changing the cache.** It explains the two-reads design and the `lut`/`storedAt` split.

---

## 3. Protocol

```json
→ {"action":"auth","token":"<firebase id token>"}
← {"type":"ready"}
→ {"action":"subscribe","stations":["910GHTCHEND"]}
← {"type":"snapshot","station":"910GHTCHEND","payload":{…}}   ← immediate, from cache
← {"type":"update","station":"910GHTCHEND","payload":{…}}     ← on each change
→ {"action":"unsubscribe","stations":[…]}
← {"type":"error","code":"subscription_limit","stations":[…]}
```

### Line status (second channel)

Additive on the **same socket** — one connection, one auth, one keepalive. `stations` and `lines` may be sent in the same frame or separately; an absent field is left untouched, so existing station-only clients are unaffected.

```json
→ {"action":"subscribe","lines":["victoria","central"]}
← {"type":"snapshot","line":"victoria","payload":{…}}   ← immediate, from cache
← {"type":"update","line":"victoria","payload":{…}}     ← on each change
→ {"action":"unsubscribe","lines":[…]}
← {"type":"error","code":"unknown_line","lines":[…]}
← {"type":"error","code":"subscription_limit","lines":[…]}
```

Line frames key on **`line`**, not `station`, and errors carry **`lines`** rather than `stations` — so a client can route by field without inspecting the code. Payload is the same `LineStatus` shape the REST endpoint returns. Limit is 30 lines per socket.

Two behavioural differences from stations, both stemming from the cache underneath:

- **A snapshot is usually available**, because the Syncer pushes on every poll. "Cold" means a genuine gap — a backend restart before the first push, or a line that has not changed since. There is no `PredictionCache` equivalent and none is needed; `DataCacheService.lineStatuses` is already the single store, and adding a second would give the same data two sources of truth.
- **Warming is per mode, not per line.** TfL returns a whole mode per call, so subscribing to `victoria` warms every tube line at once, and eleven cold tube lines trigger **one** refresh. `LineController.ensureLineStatuses` caps a mode at one TfL call per 60s and single-flights concurrent callers, which is why the line path needs no `StreamPrefetch`-style budget or concurrency cap.

**Zero Firestore, zero SQLite.** Line statuses were replicated from Firestore via a live `onSnapshot` listener, which billed a document read per change on every instance, forever. That listener, the boot delta sync, the Firestore write and the SQLite tier were all removed on both sides. Statuses are now memory-only, per process, exactly like predictions.

Liveness therefore comes from **`POST /internal/line-status-updates`** — the Syncer's `LiveStreamPublisher` pushes changed statuses there each poll. The TfL refresh is only the fallback for a Syncer that is down or delayed. Fan-out hangs off `DataCacheService.setLineStatus`, the single write point both producers share; call that, never `LineStatusStreamHub.broadcast` directly, or the cache and the stream will disagree.

Watch **`lines.writes.syncer`** at `/internal/stream-stats`. If the Syncer push breaks, the TfL fallback keeps the cache populated and nothing looks wrong while every client sits up to a minute stale — a flat `writes.syncer` is the only signal.

### Cold subscribes

A `snapshot` arrives immediately only when the cache already holds the station — normally true, because the Syncer pushes every subscribed station each cycle. For a station nobody is subscribed to (so the Syncer never polls it), the cache is empty and the server fetches from TfL on demand, exactly as the REST endpoint does. That result arrives as a normal **`update`**, not a `snapshot` — so a client must paint on both frame types, and must not wait for a `snapshot` that may never come.

Three error codes report a cold subscribe that will not produce data. None of them close the socket, and none affect the subscription itself — live updates still flow if the station later changes:

| code | meaning | client action |
|---|---|---|
| `unknown_station` | the id is not in our station table, **or** TfL 404s it | permanent — the subscription is dropped server-side; stop asking |
| `prefetch_throttled` | over the per-socket budget, or the server is shedding load | transient — the next Syncer push fills the board |
| `prefetch_failed` | TfL errored (5xx, timeout, rate-limit) | transient — retry is safe |

`unknown_station` is the only one that **cancels the subscription**. It is raised in two places: cheaply, before any network call, for an id missing from the local station table; and after the fetch, for an id we do list but TfL has since retired or renamed. Both drop the subscription so it stops consuming one of the 25 slots.

Limits are per socket: 25 concurrent subscriptions, and 40 cold fetches per 60s. A normal cold app open spends ~25; browsing to an already-cached board spends none.

### Freshness windows (how long REST serves from memory)

| | Window | Scope | Tunable |
|---|---|---|---|
| **Predictions** | **60s** (`freshForMs`) | per station | `PREDICTION_CACHE_FRESH_MS` |
| Predictions — stream snapshot | any age | per station | — |
| Predictions — retention | 10 min (`retainForMs`) | per station | `PREDICTION_CACHE_RETAIN_MS` |
| Predictions — negative cache | 5 min | per TfL-404'd id | — |
| **Line status** | **60s** (`LINE_STATUS_TTL_MS`) | per **mode** | `LINE_STATUS_TTL_MS` |
| Line status — missing-line retry | 60s (`MISSING_LINE_RETRY_MS`) | per mode | — |

The two differ in **scope**, not just duration. Predictions expire per entry: each station is independently 60s fresh, then refetched. Line status is a per-*mode* gate — the mode counts as fresh if `max(newest cached lastUpdatedTime, last TfL attempt)` is inside the window, so one recently-updated line keeps its whole mode from being refetched.

That is why both the REST endpoint and the stream pass the specific line ids they need: a mode can be "fresh" yet missing the line actually being asked for, since the Syncer pushes only *changed* lines. Without that, an unchanged line returned nothing until the staleness gate tripped.

The line-status window is a FALLBACK bound, not the liveness path — the Syncer pushes changes within a poll cycle, and every push counts as a verification. It only sets the worst case when the Syncer is down: one TfL call per mode per minute.

### REST: unknown stations

`GET /stations/{naptanId}/predictions` now returns **404** when TfL does not recognise the id, instead of 200 with an empty board named "Unknown Station":

```json
{ "error": "Station not found",
  "message": "TfL does not recognise naptanId '940GZZLUACYsdfsdfd'.",
  "naptanId": "940GZZLUACYsdfsdfd" }
```

### REST: TfL unreachable

A TfL 5xx, timeout or rate-limit now returns **503**, not a 200 with an empty board:

```json
{ "error": "Upstream unavailable",
  "message": "Could not reach TfL for this station. Please retry shortly.",
  "naptanId": "940GZZLUOXC" }
```

An empty board is a **claim** — "no trains here" — and is indistinguishable from a genuinely quiet station at 3am. Worse, it used to be *cached with a fresh `lut`* (so it beat the ordering guard and overwrote good data) and *broadcast*, meaning one failed fetch asserted "no service" to every subscriber of that station for the next 60s. Nothing is written or broadcast on failure now; the previously-held board survives untouched, and streaming clients get `prefetch_failed` rather than a blanked board.

`TflUnavailableError` is deliberately **never** added to the negative cache — that is for facts about an id, and an outage would otherwise blacklist every station it touched. Stations whose board comes from `ArrivalDepartures` (Elizabeth/overground) still serve normally when only the countdown-arrivals call fails.

Only a TfL **404** produces this. A 5xx, timeout or rate-limit still degrades to an empty board exactly as before, so an outage never turns real stations into 404s. No board data is cached on this path — previously a junk id cached a fake entry that the stream would then serve as a `snapshot`. Instead the 404 itself is remembered for ~5 minutes (a shared negative cache), so repeats — REST or stream subscribe — are refused from memory without another TfL call.

Auth is the **first frame**, not a header — browsers can't set headers on a WS handshake, and a query param would land in `morgan` access logs. It must arrive within 10s (close `4001`); a bad token closes `4003`. `decodedToken.uid` is authoritative; a uid in the frame is never trusted.

Payload is the same `{id, name, lut, lines}` shape as the REST endpoint and the FCM payload, so a KMP client can reuse `FcmPayload` + `SyncPredictionsUseCase` unchanged.

---

## 4. Things that will bite you

**`curl` cannot test this without `--http1.1`.** curl negotiates HTTP/2, where WebSocket upgrade does not exist (RFC 7540 forbids the `Upgrade` header), so you get a misleading **401** and it looks broken. This cost real debugging time. Bypassing nginx (`curl localhost:3000`) returning 101 while nginx returned 401 is what isolated it.

**The Syncer batches up to 250 stations into ONE POST; Express caps bodies at 100 kb.** At ~1–3 kB per station that ceiling is ~50 stations — and staging already caches 59. Over the limit Express returns 413 and the Syncer drops the entire batch by design (fire-and-forget, never retried), so the stream would go quiet during exactly the busiest cycles while FCM kept working — looking like a client bug. Fixed by mounting a 5 MB parser for `/internal` in `server.ts`. **It must stay ABOVE the global `express.json()`**: body-parser no-ops once `req._body` is set, so the first matching parser wins and mounting it next to the route would be too late.

**nginx: the server block sets `proxy_set_header Connection ""`** for upstream keepalive, which kills every WebSocket upgrade. The `location = /api/v1/stream` block overrides it. Note **nginx does not merge `proxy_set_header` across levels** — declaring any header in a location discards ALL inherited ones, so that block must re-declare `Host` and the `X-Forwarded-*` chain (which `app.set('trust proxy', 1)` depends on). Also overrides the 60s `proxy_read_timeout`, which would otherwise cull idle sockets.

The staging config is now committed verbatim at `server-config/nginx.staging.conf` — previously it existed only on the box, so rebuilding from the repo would have reproduced the misleading 401 above. **`server-config/nginx.conf` is the prod reference and is stale** (it predates the current live prod config and has no stream block). Prod has NOT been given the stream block: it must be added before the stream ships there.

**Concurrent `auth` frames used to leak the routing table.** `authed` was only assigned after `await verifyIdToken`, so several auth frames arriving in one batch all passed the guard and each called `register()`, which installed a fresh, empty `ClientState`. A `subscribe` interleaved between two registrations left the socket in `rooms` but absent from its own station set, so `unregister()` could never clean those rooms. Now guarded two ways: a synchronous `authInFlight` flag in the server, and `register()` being idempotent in the hub. The hub-side guard is the load-bearing one — it holds no matter what the protocol layer does.

**Deploy secrets: the `*-remote` files are MANIFESTS OF KEY NAMES, not values.** `staging_deploy.sh` reads each key then looks up `STAGING_<KEY>` in the environment. A value written into `application-remote.properties` is (a) git-tracked, so it leaks, and (b) **ignored by the merge loop**, so it silently doesn't deploy. Correct usage:

```bash
export STAGING_LIVESTREAM_INGEST_SECRET=$(grep '^LIVESTREAM_INGEST_SECRET=' .env | cut -d= -f2-)
bash local_scripts/staging_deploy.sh
```

On the backend side the key must be declared in `.env.remote` **and** valued in local `.env`. A key absent from the manifest is silently skipped, and `/internal` then fails closed with 503 — which looks like the Syncer being broken.

Both sides are now set on **staging** (verified 2026-07-31): `LIVESTREAM_INGEST_SECRET` in `~/stationly-backend/.env`, and `livestream.ingest-secret` in `~/config/application.properties`. **Prod was not inspected** — check both before shipping there. If either is missing the path fails closed (backend 503, publisher disables itself at boot with a warning), so a prod deploy is inert rather than broken.

**PM2 runs `-i max`.** Staging is 1 vCPU so that resolves to one worker and everything works — confirmed 2026-07-31: `stationly-backend` is `cluster_mode`, `instances=1`. On a larger box, connections land on one worker while the Syncer's POST round-robins to another, so only ~1/N of clients get updates — and it looks like a flaky client, not a server bug. `StationStreamHub.assertSingleInstance()` warns on boot. Fix is `-i 1`, the PM2 message bus, or Redis pub/sub. **Decide this before scaling the box.**

**`/internal` security.** It is a write path for board data — public reachability means anyone can inject departures into every connected client. Three layers: nginx never proxies `/internal` (the 443 block has no catch-all `location /`); loopback check via **`req.socket.remoteAddress`, not `req.ip`** (`trust proxy` makes `req.ip` honour a spoofable `X-Forwarded-For`); and a shared secret compared with `timingSafeEqual`, failing **closed** when unset. Verified 404 from the public internet.

---

## 5. Tuning

`PredictionCache.configure()` — defaults chosen so adopting the module changed nothing observable:

| Option | Default | Notes |
|---|---|---|
| `freshForMs` | 60s | Matches the old SQLite window exactly |
| `retainForMs` | 10min | Longer on purpose — stale entries still serve stream clients and act as a TfL-outage fallback |
| `maxEntries` | 500 | Backstop |

All three are env-overridable at boot, so a box can be retuned without a code change: `PREDICTION_CACHE_FRESH_MS`, `PREDICTION_CACHE_RETAIN_MS`, `PREDICTION_CACHE_MAX_ENTRIES`. Unset vars leave the defaults alone.

**Watch `restHitRate`** at `GET /internal/stream-stats` (loopback + secret). It counts **REST reads only** — stream reads never cause a TfL call, so folding them in would drift the number to ~1.0 and hide the signal. (That was a real bug in the first cut.)

- High `restStaleMisses` → `freshForMs` is tighter than needed. The Syncer only re-pushes on change plus a heartbeat every 5 cycles (~150s), so a quiet station's entry can legitimately be ~2.5min old and still correct. Raising toward ~150s would lift the hit rate; the cost is only missing newly-appeared or cancelled trains, since ETAs are absolute timestamps.
- High `restMisses` → cold cache, or stations nobody subscribed to.
- `coalesced` → concurrent misses absorbed by single-flight.

First live reading: `writes.syncer: 372` vs `writes.rest: 1` across 59 cached stations.

---

## 6. What changed elsewhere

- **SQLite `station_preds` deleted** (`upsertStationPreds` / `getFreshStationPreds` / `purgeStaleStationPreds` + the `CREATE TABLE`). It was a disk write for data worthless within 60s. The cost is an empty cache after restart, which falls through to TfL — the pre-existing behaviour, so no regression. The old table may still exist on disk; it is never read or written.
- **`server.ts`**: `app.listen` → `http.createServer` (a WS server needs the raw `http.Server`), plus SIGINT/SIGTERM handling, which did not exist before. PM2 reload previously severed connections abruptly.

- **REST payloads for subscribed stations now come from the Syncer, not from this codebase.** This is the sharpest edge of the shared cache and it is easy to miss. For any station someone has subscribed to, the Syncer's push usually wins the cache, so `GET /stations/predictions/:id` returns a payload built by the **Java** `DataTransformationService` / `predictionsources` — not by `src/services/predictionSources/`. The two are currently in sync (`DEPARTED_CUTOFF`, `isFarFutureUnassigned`, the self-terminating "Check Front of Train" relabel and the Elizabeth/Overground `ArrivalDepartures` board all exist on both sides), and `predictionUtils.ts` says so in a comment — but that lockstep is enforced by convention alone. **A prediction fix landed only in TypeScript will silently not apply to subscribed stations.** Port such fixes to both, or the bug reappears intermittently and only on saved boards.

---

## 7. Outstanding

1. ~~**Tests are not in the repo.**~~ **Done.** `npm test` runs 27 assertions from `src/tests/run.ts` — a ~40-line runner over Node's `assert`, no framework, no new dependencies. Covers single-flight, failed-fetch retry, out-of-order rejection, the REST/stream metric split, key normalisation, TTL sweep and size eviction, plus hub fan-out, room cleanup, the per-client limit, register idempotency and the ping/pong strike. Excluded from `dist/` via tsconfig, but still typechecked because ts-node typechecks what it runs.

   Not covered: `stationStreamServer.ts` (importing it initialises the Firebase Admin SDK, which needs real credentials) and the `/internal` guard. Both need either a DI seam or an integration harness — worth doing, but a bigger change than the modules above.

2. **Prod nginx has no stream block.** Verified 2026-07-31: prod's live config has no `location = /api/v1/stream`, and its server block sets `Connection ""`, so upgrades there will fail exactly as staging's did. Copy the block from `server-config/nginx.staging.conf`. Prod's `.env` / Syncer properties were not inspected — check those too.
3. **Generalise the protocol to channels** (`{"action":"subscribe","channel":"station","ids":[…]}`) before a client exists. ~10 lines now; afterwards it is a coordinated change across three platforms. Line status is the obvious second channel.
4. **KMP WebSocket client** in `commonMain`.
5. **iOS `getTimeline` should fetch REST** — closes the force-quit hole; the reload budget is already being spent.
6. **Line status streaming** — investigated and deliberately deferred. It has **two** producers (the Syncer poll *and* the backend's own on-demand refresh at `lineController.ts:236`), polls every 10min, stays valid for hours, and already serves from `DataCacheService`'s in-memory map — so Firestore is *not* in its read path. If revisited: the backend's own TfL fetch becomes the cold-start path and the Syncer POSTs live updates. Check nothing else reads the `lineStatuses` collection first.
7. **Nothing is committed** in any repo — including the review fixes above and the Syncer-side `LiveStreamPublisher`.
