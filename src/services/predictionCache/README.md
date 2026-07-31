# Prediction cache

One in-memory store of current station predictions, shared by **both** the REST
endpoint and the WebSocket stream.

```
   Syncer push  ──┐                        ┌──►  WebSocket stream   getLatest()
  (every ~30s,    ├──►  PredictionCache  ──┤
   changed only)  │                        └──►  REST endpoint      getFresh()
   REST TfL fetch─┘
   (on miss)
```

## Why this exists

The Syncer already fetches every subscribed station from TfL every 30 seconds.
The REST endpoint used to fetch the *same* stations from TfL again whenever its
own 60-second SQLite cache lapsed — so TfL was billed twice for identical data,
and we saw real `429 Too Many Requests` during testing.

Merging the two caches means:

- A Syncer push satisfies later REST callers → **fewer TfL calls**.
- A REST fetch for a station nobody has subscribed to (so the Syncer never polls
  it) populates the cache for anyone streaming it.
- REST and the stream can no longer disagree about the same station, because
  there is only one copy.

The biggest single beneficiary is the **iOS widget refresh button**, which calls
the REST endpoint directly. Every tap outside the freshness window used to be a
live TfL round-trip; for subscribed stations it is now a memory read.

## The two reads, and why there are two

Freshness is the **caller's** decision, not the cache's:

| Caller | Method | Wants |
|---|---|---|
| REST | `getFresh(id, maxAgeMs?)` | Fresh data or `undefined` so it can refetch |
| WebSocket | `getLatest(id)` | Whatever we have, at any age |

A streaming client that connects mid-cycle needs *something* to paint straight
away — a board showing 90-second-old departures beats a blank one, and ETAs are
absolute timestamps so slightly-old data is still correct. REST, by contrast,
has an explicit contract to return current data and a cheap way to go get it.

Two named methods rather than one with a boolean, so the intent is legible at
the call site.

## `lut` vs `storedAt`

Both timestamps exist and they do different jobs:

- **`storedAt`** — when *we* wrote it. Used for every freshness/eviction check,
  because a producer's clock is not ours.
- **`lut`** — the payload's own last-updated time. Comparable between payloads
  for the same station, so it's the guard against a delayed or retried write
  clobbering newer data. Rejected writes return `false`; callers should skip
  fan-out rather than re-broadcast older data and make clients flicker backwards.

A write is only rejected when *both* sides carry a parseable `lut`, so a
producer that omits the field can still update the cache.

## Not persisted, on purpose

The previous implementation wrote to a SQLite `station_preds` table. That was
paying a disk write for data worthless within ~60s. This module is memory-only.

The cost: after a restart the cache is empty. Reads then fall through to TfL —
which is exactly the old behaviour, so it is not a regression, only a gap in the
benefit. The Syncer refills it within a poll cycle or two.

One nuance: the Syncer only re-pushes a station when it **changes**, plus a
heartbeat every ~5 cycles. So a quiet station can take ~2.5 minutes to reappear
after a restart.

## Tuning

| Option | Default | Meaning |
|---|---|---|
| `freshForMs` | `60_000` | How long REST will serve an entry. Matches the old SQLite window, so adopting this module changes no observable freshness. |
| `retainForMs` | `600_000` | How long an entry is kept at all. Deliberately much longer — stale entries still serve streaming clients and act as a fallback while TfL is erroring. |
| `maxEntries` | `500` | Backstop against unbounded growth. |
| `sweepIntervalMs` | `60_000` | TTL sweeper cadence. |

Raising `freshForMs` toward ~150s would lift the hit rate further (it covers the
Syncer's heartbeat interval), at the cost of REST serving slightly older data.
Start at 60s, watch `restHitRate`, then decide.

All three are env-overridable at boot (`server.ts` calls `configure()`), so a
box can be retuned without a code change:

| Env var | Option |
|---|---|
| `PREDICTION_CACHE_FRESH_MS` | `freshForMs` |
| `PREDICTION_CACHE_RETAIN_MS` | `retainForMs` |
| `PREDICTION_CACHE_MAX_ENTRIES` | `maxEntries` |

## Observability

`PredictionCache.stats()` is exposed at `GET /internal/stream-stats`
(loopback + shared secret), nested under `cache`. `restHitRate` is the number
this module exists to move — the share of **REST** reads answered without
touching TfL.

Stream reads are counted separately (`streamHits` / `streamMisses`) and are
deliberately excluded from `restHitRate`: a stream read never causes a TfL call,
so folding them in would drift the rate toward 1.0 and hide the signal.

`restStaleMisses` vs `restMisses` is the useful distinction: lots of
`restMisses` means the cache is cold or the station isn't subscribed; lots of
`restStaleMisses` means `freshForMs` is tighter than it needs to be.

## Caveats

**Per-process.** Under PM2 cluster (`-i max`) each worker has its own cache.
That costs some duplicate TfL fetches but is never *incorrect*. Note this is a
different, milder problem than the WebSocket hub's — see
`StationStreamHub.assertSingleInstance()`, where cross-worker state is a
correctness issue rather than an efficiency one.

**Key normalisation.** The Syncer keys by FCM topic (`Station_940GZZDLTWG`),
REST by bare naptanId. The cache strips the prefix so both write the same key —
without that they would silently maintain two separate entries per station.
