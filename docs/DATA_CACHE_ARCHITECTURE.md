# 3-Layer Data Cache Architecture (Firestore + SQLite + In-Memory)

**This is the standing pattern for all reference/master data in the backend.**
Use it for every collection that is read often and changes rarely. Its whole
point is to keep Firestore reads/writes near-zero at request time — Firestore
is the durable master, but the backend almost never reads it on the hot path.

Owned by `src/services/dataCacheService.ts` + `src/services/localDbService.ts`.

## The three layers

```
        ┌─────────────────────────────────────────────┐
        │  Firestore  (MASTER, durable source of truth) │
        └───────────────┬───────────────────────────────┘
            boot delta-sync │   live onSnapshot
         (lastUpdatedTime>X)│  (lastUpdatedTime>bootTime)
                            ▼
        ┌─────────────────────────────────────────────┐
        │  SQLite  (LOCAL SLAVE / durable mirror)        │  ← survives restarts
        └───────────────┬───────────────────────────────┘
              boot load  │  (loadFromLocal)
                         ▼
        ┌─────────────────────────────────────────────┐
        │  In-Memory Map  (SERVING layer)                │  ← every request reads here
        └─────────────────────────────────────────────┘
```

1. **Firestore — master.** The persistent source of truth. Written to by the
   Syncer / admin / controllers. **Read by the backend only twice:** a bounded
   boot delta-sync, and a live listener. Never per request (see the one
   exception below).
2. **SQLite — local slave.** A full on-disk mirror. On boot the cache loads
   entirely from here (`loadFromLocal`), so the service is fully functional
   **even if Firestore is unreachable** (quota, outage) and instantly after a
   redeploy when the in-memory layer is empty.
3. **In-memory `Map` — serving layer.** Every request is served from RAM
   (`getRoute`, `getLinesByMode`, `getAllStations`, …). O(1), zero I/O.

## The lifecycle (per `DataCacheService.initialize`)

1. **`LocalDbService.initialize()`** — open SQLite, create tables.
2. **`loadFromLocal()`** — hydrate every in-memory `Map` from SQLite. The
   service can serve traffic immediately, offline-capable.
3. **Master-instance gate** — only `NODE_APP_INSTANCE === '0'` (or undefined)
   runs the sync + listeners. Other PM2 cluster workers stay **read-only from
   SQLite**, so N workers don't multiply Firestore reads.
4. **`syncWithFirestore()` → `syncCollection()` (delta sync).** For each
   collection: read `last_sync_<collection>` from `sync_metadata`, then query
   `where('lastUpdatedTime', '>', lastSync)` — **only changed docs come back**.
   Apply each to SQLite (`upsert*`) + the memory `Map`, and advance the stored
   high-water timestamp. First boot pulls everything once; subsequent boots
   pull only the delta. Wrapped in try/catch so a Firestore failure degrades
   to "serve local data," never a crash.
5. **`setupRealtimeListeners()`.** One `onSnapshot` per collection, filtered
   `where('lastUpdatedTime', '>', bootTime)`. **Critical:** without that filter
   the first snapshot replays the ENTIRE collection (e.g. 20k stations). It
   handles `added`/`modified` (upsert memory + SQLite) and `removed` (delete
   from both), keeping all three layers in lockstep in real time.

## The standard read cascade (use this everywhere)

When a request needs a piece of reference data, walk the layers cheapest-first
and stop at the first hit. Hitting an outer layer **back-fills** the inner ones
so the next request is cheaper:

```
1. memory Map            → hit: serve.
2. SQLite (local slave)  → hit: serve + warm memory.
3. Firestore (master)    → hit: serve + warm memory AND SQLite.
                            (The onSnapshot listener does NOT fire for a doc
                             whose lastUpdatedTime predates boot, so a Firestore
                             read-hit must back-fill the local layers itself.)
4. External source (TfL) → last resort. Build the value, warm THIS instance's
                            memory, then async-write Firestore ONLY (step below).
```

Rationale: memory mirrors SQLite (both hold the full set after boot), so on the
master instance a memory miss usually means a SQLite miss too — but the SQLite
tier still matters for **cluster workers** (no listener) picking up data the
master wrote to the shared SQLite file, and it keeps Firestore reads off the hot
path. Never let a request read Firestore *before* SQLite.

## The standard write rule

On an external (TfL) fetch, do **two** things and no more:

1. **Warm this instance's in-memory `Map` immediately** (`setRoute`/`setX`) — so
   concurrent/subsequent requests on this process don't re-hit the external API
   before propagation lands.
2. **Async-write the Firestore master** with a fresh `lastUpdatedTime`
   (fire-and-forget, `.catch`-logged — never `await` it on the response path).

That's it. **Do not** also write SQLite directly — the master's `onSnapshot`
listener fans the Firestore write out to SQLite + memory (including other
cluster instances). One write in, the listener does the rest. (Admin/Syncer
writes follow the same rule: write Firestore + `lastUpdatedTime`, listener
propagates.)

## Non-negotiable invariants

1. **Every document MUST carry `lastUpdatedTime` (ISO string).** The delta-sync
   high-water mark and the listener filter both depend on it. A write without
   it is invisible to sync — it won't reach SQLite/memory on other instances or
   after a redeploy.
2. **Filter the listener by `lastUpdatedTime > bootTime`.** Never attach a bare
   `onSnapshot` to a large collection.
3. **Only the master instance syncs/listens.** Gate on `NODE_APP_INSTANCE`.
4. **Firestore can't store arrays nested directly inside arrays.** Encode such
   shapes (see routes' `sequencesJson` in `src/utils/routeEncoding.ts`) — a raw
   `string[][]` field throws `INVALID_ARGUMENT: invalid nested entity`.
5. **Degrade, don't crash.** Firestore calls are wrapped so quota/outage falls
   back to the SQLite slave.

## Collections currently on this pattern

`modes`, `lines`, `routes`, `stations`, `lineStatuses` — each has: an in-memory
`Map`, a `loadFromLocal` SELECT, a `syncCollection` entry (+ memory-set branch),
an `onSnapshot` listener, and a `LocalDbService` table + `upsert*`.

### Per-collection conformance

- **routes** — fully on the pattern, and `getLineRoute` implements the canonical
  read cascade + write rule above (`memory → SQLite → Firestore → TfL`; on TfL,
  warm memory + async-write Firestore only). Because Firestore rejects the
  nested-array `sequences`, routes persist it as `sequencesJson` and decode on
  read (`src/utils/routeEncoding.ts`). **Use `getLineRoute` as the reference
  implementation for any new on-demand collection.**
- **lines** — `getLinesByMode` reads `memory → Firestore → TfL` and writes via a
  Firestore batch (listener syncs memory+SQLite). It skips the SQLite read tier;
  acceptable only because `loadFromLocal` makes lines fully memory-resident, so
  the Firestore tier effectively never fires. If lines ever become on-demand,
  add the SQLite tier to match routes.
- **lineStatuses** — `getLineStatuses` reads `memory → SQLite → TfL` and on the
  TfL fallback writes memory+SQLite but **deliberately not Firestore**. Line
  statuses are high-frequency and **owned by the Syncer**, which writes them to
  Firestore continuously; a backend write would race/clobber that. This is an
  intentional, documented exception to the write rule — the TfL fetch is a
  cold-start stopgap until the Syncer pushes.
- **modes / stations** — memory-only reads, bulk-populated by the Syncer. No
  per-request fallback needed.

## Adding a new collection to the pattern (checklist)

1. Add a `private static <name>: Map<...>` to `DataCacheService`.
2. Create the SQLite table + an `upsert<Name>` in `LocalDbService`.
3. Hydrate it in `loadFromLocal()`.
4. Add a `syncCollection('<name>', upsert)` call in `syncWithFirestore()` and a
   memory-set branch inside `syncCollection`.
5. Add an `onSnapshot` listener (filtered on `lastUpdatedTime > bootTime`) in
   `setupRealtimeListeners()`.
6. Ensure **every writer stamps `lastUpdatedTime`**.
7. For on-demand data, follow **the standard read cascade** (memory → SQLite →
   Firestore → external) and **the standard write rule** (warm memory +
   async-write Firestore only; let the listener sync the rest). Mirror
   `lineController.getLineRoute` — it's the reference implementation. Never read
   Firestore before SQLite, and never `await` a Firestore write on the response
   path.
