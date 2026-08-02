# Firestore ⇄ SQLite Replication & Read Architecture

> Audience: future agents / engineers working on `stationly-backend` and
> `StationlySyncer`. This is the canonical description of how reference data
> flows, how we keep Firestore reads/writes minimal, and the invariants you
> must not break.

## Motto

**Minimise Firestore reads & writes.** Firestore is the **master**; our local
**SQLite is a full replica (slave)**; the **in-memory cache is an exact replica
of SQLite**. We read from memory first and only ever touch Firestore/TfL on a
genuine miss. We only *write* to Firestore when something actually changed.

```
                 ┌──────────────────────────┐
   writes ─────► │  Firestore  (MASTER DB)  │ ◄──── TfL (predictions/status)
                 └────────────┬─────────────┘
                  realtime listener + boot delta
                              │  (only changed docs)
                 ┌────────────▼─────────────┐
                 │  SQLite  (SLAVE replica) │
                 └────────────┬─────────────┘
                       load on boot
                 ┌────────────▼─────────────┐
                 │  In-memory cache (Maps)  │ ◄── API reads hit here first
                 └──────────────────────────┘
```

**Service writes go to the master only.** Nobody writes SQLite directly with
"new" data — you write Firestore, and the listener fans the change down to
SQLite + memory. (The one local-only exception is `station_preds`, below.)

## The replication watermark: `lastUpdatedTime` = epoch millis (integer)

Every replicated document carries **`lastUpdatedTime` as an integer (epoch
milliseconds, UTC)**. This is the single field that drives delta sync and the
per-collection checkpoint.

Why integer and not an ISO string: integers compare **numerically and
unambiguously** in Firestore, SQLite, JS and Java. ISO strings caused real
bugs — mixed formats (`LocalDateTime.now()` produced local-time, no-`Z`,
nanosecond values that sort differently from `toISOString()`), and lexical
comparison breaks across formats. One integer everywhere removes the whole
class of problem.

- **Produce** time with `nowMs()` (TS: `src/utils/timestamps.ts`; Java:
  `TimeUtils.nowMs()`).
- **Read/coerce** any stored value with `toEpochMs()` — it accepts a number,
  an epoch-string, an ISO string, or the legacy no-`Z` format, so reads stay
  tolerant across the migration cutover.
- **Format at the API boundary only:** internally everything is an integer;
  if a client expects ISO (e.g. the mobile `LineStatus.lastUpdatedTime: String`),
  convert with `toIso()` at the `res.json` boundary — see
  `lineController.getLineStatuses`.

### The checkpoint (`sync_metadata`)

One row per collection: `last_sync_<collection>` → the **max `lastUpdatedTime`
seen** for that collection. Updated with an **atomic, monotonic** upsert:

```sql
INSERT INTO sync_metadata (key, value) VALUES (?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value
WHERE CAST(excluded.value AS INTEGER) > CAST(sync_metadata.value AS INTEGER);
```

- **Atomic** (one statement, no read-then-write) → concurrent listener
  callbacks can never race the checkpoint backwards.
- **`CAST(... AS INTEGER)`** is mandatory (both repos). It compares numerically,
  so an epoch checkpoint (`1748…`) correctly overwrites a legacy ISO one
  (`2026…`). A lexical compare would treat `1… < 2…` and **freeze the
  checkpoint** at the old ISO value → endless re-reads. (This was a real bug —
  do not "simplify" it back to `excluded.value > value`.)

## The generic replicator (`dataCacheService.ts`)

Five reference collections replicate through **one** code path
(`replicationTargets()`): `modes`, `lines`, `routes`, `stations`,
`lineStatuses`. Each target owns its `apply` (memory + SQLite upsert) and
`remove` (memory + SQLite delete).

**Boot delta (`deltaSync`)** — `where('lastUpdatedTime', '>', checkpoint).get()`,
apply each change, advance the checkpoint to the batch **max** in **one**
write. Null checkpoint ⇒ first-ever full load.

**Live listener (`listen`)** — `onSnapshot(where('lastUpdatedTime', '>',
baseline))`. Processes each snapshot's `docChanges()` **sequentially** (ordered,
no race), then advances the checkpoint to the batch max in **one** atomic write
— **never per-document**. Per-doc checkpoint writes were the original I/O storm;
don't reintroduce them.

**Why minimal-read:** the boot delta advances the checkpoint *before* the
listener reads it, so the listener's initial snapshot only covers the tiny gap
window (usually 0 docs) — never a full re-download.

### Soft-delete contract (important)

The replicator treats `deleted === true` as a **remove** (both boot delta and
listener). A boot-time `where('lastUpdatedTime' > checkpoint)` can only return
documents that still **exist** — so a **hard delete** performed while a service
was offline is invisible and the slave keeps the row forever.

**Therefore: never hard-delete a replicated doc.** Soft-delete it —
`set({ deleted: true, lastUpdatedTime: nowMs() }, { merge: true })` — so the
tombstone comes back through the delta and every replica removes it. (Today no
code hard-deletes these collections, so the read-side handling is future-proof
insurance; honour this if you add a delete path.)

## Tiered reads (controllers)

API reads resolve in this order, stopping at the first hit:

1. **In-memory** (`DataCacheService` maps) — the hot path.
2. **SQLite** — on a memory miss (cold start, before `loadFromLocal`).
3. **Firestore** — on a SQL miss (read-through: backfill SQL + memory).
4. **TfL** — only for TfL-derived data (predictions, line status) that's
   missing or **stale**.

Because memory == SQLite == Firestore in steady state, tiers 2–3 are a
cold-start safety net, not the normal path.

### Predictions (`stationController.fetchPredictions`) — local-only, 60 s TTL

`stationPredictions` is **deliberately NOT in Firestore** — it's ephemeral
(stale in ~60 s) and high-churn, so persisting it would be pure read/write
waste. Instead:

- Served from the local `station_preds` table if **fresh (<60 s)** — the
  freshness window is enforced **at read time**, so a stale row is never served.
- On miss → fetch TfL → cache → **fire-and-forget** async purge of >60 s rows
  (`purgeStaleStationPreds`) so it never blocks the response.

### Line status (`lineController.getLineStatuses`) — tier-4 with 10-min staleness

Served from memory → SQLite. If **cold OR older than 10 min** (the syncer's
poll cadence), it refreshes from TfL:

- **Single-flight per mode** (`inFlightStatusRefresh`) → a burst of requests =
  one TfL call.
- **Change-detected** → only statuses whose severity/reason changed are written
  to **Firestore master** (which propagates to the syncer + replicas) and bump
  their watermark. Unchanged statuses cost nothing.
- `lastTflRefreshByMode` prevents re-polling TfL when data is old-but-unchanged.

## What is replicated where

| Collection | Backend replica | Via | Notes |
|---|---|---|---|
| `modes`,`lines`,`routes`,`stations`,`lineStatuses` | ✅ SQLite + memory | generic replicator | integer watermark, delta + listener |
| `api_keys` | ✅ SQLite | `authMiddleware` own listener | tiny (≈2 docs); full listen is fine |
| `metadata/subscribed_stations` | ✅ (counts) | `subscriptionService` + (syncer) | single doc |
| `stationPredictions` | local-only | TfL + `station_preds` | **not in Firestore**, 60 s TTL |
| `users` | ❌ on-demand | `userService` direct | per-user, unbounded — replicating all would violate minimal-read; `updatedAt` stays profile metadata |

## Timestamp migration (`src/scripts/standardizeTimestamps.cjs`)

One-off, idempotent, **resumable**, `--apply`-gated, `--only=<list>` filter.
Converts every collection's "last-updated" field to integer `lastUpdatedTime`
and drops legacy field names (`lastUpdated`, `lut`). Skips `users`.

- **Run order is migrate-LAST:** deploy the integer-aware code first, *then*
  migrate — otherwise the running (string-based) code's delta queries break.
- **Resumable:** on Spark write-quota exhaustion it stops gracefully; re-run to
  finish (already-migrated docs are skipped). `stations` (~20 k) needs ~2 days
  on the free quota.
- `auditTimestamps.cjs` is the quota-cheap read-only auditor (count + 5-doc
  sample per collection) used to plan a migration without burning reads.

## Invariants (do not break)

1. `lastUpdatedTime` is an **integer** end-to-end; format to ISO only at the
   API boundary.
2. Checkpoint upsert is **atomic + `CAST AS INTEGER`** in both repos.
3. Replicator advances the checkpoint **once per snapshot** (batch max), never
   per-doc.
4. **Soft-delete only** for replicated collections.
5. `stationPredictions` never goes to Firestore; it's local + 60 s TTL +
   read-time freshness filter + async purge.
6. Service writes go to the **master**; SQLite/memory are pure replicas.
