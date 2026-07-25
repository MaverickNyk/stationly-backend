# National Rail — research & implementation handover

**Status:** paused 2026-07-25. Station model built and 9 test docs live on **staging**. One
product decision is open (see §7) and must be settled before seeding the remaining 2,636.

**Scope of this document:** everything discovered while building National Rail selection into
`stationly-backend`. Written for an agent or engineer picking this up cold. Every number here
was measured, not estimated; sources are given so you can re-derive them.

Related: [`DATA_CACHE_ARCHITECTURE.md`](./DATA_CACHE_ARCHITECTURE.md),
[`REPLICATION.md`](./REPLICATION.md), [`ROUTE_DIRECTIONS.md`](./ROUTE_DIRECTIONS.md),
`StationlySyncer/docs/NATIONAL_RAIL_DARWIN_HANDOVER.md` (the Java prediction side, parked).

Interactive prototype of the proposed UX (real timetable data, 10 stations):
<https://claude.ai/code/artifact/021623b3-8a5e-43e3-8dab-d70ebd0d8695>

---

## 1. Where things stand

### Written to Firestore — staging (`mindthetimefcm`) only

| Doc | Content |
|---|---|
| `modes/national-rail` | seeded 2026-07-21. Mode tile appears in the app. |
| `lines/national-rail` | `{id, name:"National Rail", modeName:"national-rail", lastUpdatedTime}` |
| `stations/9100{KNGX,PADTON,STPX,CLPHMJC,MNCRPIC,ELYY,BARKING,BCSTRTN,BCSTN}` | 9 test docs |

Nothing in production (`stationly-prod`). Nothing user-visible end-to-end — the API responses
were never verified because the endpoints need a client `X-Stationly-Key` and only
`STATIONLY_ADMIN_KEY` is in `.env`. **Get a staging client key first thing.**

### On disk (all gitignored — see §9.1)

```
data/darwin/PPTimetable_20260725020500_v8.xml.gz       9.8 MB   Darwin timetable
data/darwin/PPTimetable_20260725020500_ref_v99.xml.gz  237 KB   TIPLOC↔CRS reference
data/darwin/corridors.json                             1.1 MB   REJECTED experiment (§6.2)
src/data/nationalRail/stations.json                    645 KB   2,645 stations — the seed input
```

### Uncommitted source

```
src/scripts/seedNationalRailMode.ts        mode enabler (dry-run default, --write)
src/scripts/seedNationalRailStations.ts    station seeder — the live one
src/scripts/deriveNationalRailCorridors.ts corridor derivation — rejected, keep for reference
public/icons/national-rail.png             BR double arrow
modified: modeController.ts, formatters.ts, tflUtils.ts   (icon + display name + tint)
```

---

## 2. Data sources

### 2.1 `stations.json` — the station list

2,645 stations. Built 2026-07-22 by joining **NaPTAN area 910** (`Status=active`,
`StopType=RLY`) + the `uk-railway-stations` CRS dataset + **Wikidata P4755** as an independent
cross-check (99.5% agreement).

```json
{"naptanId":"9100PADTON","tiploc":"PADTON","crs":"PAD",
 "name":"London Paddington Rail Station","shortName":"London Paddington",
 "locality":"Paddington","country":"england","lat":51.515996,"lon":-0.176174}
```

- 36 multi-naptan sites (Clapham Junction ×5, St Pancras ×2, London Bridge ×2, …)
- 9 without coordinates — **all Elizabeth line** (`ABWDXR, BARKRIV, BONDST, CANWHRF, CUSTMHS,
  FRNDXR, TOTCTRD, WCHAPXR, WOLWXR`). Each carries `coordsFrom:"910G…"` pointing at the
  existing TfL doc to inherit from.
- 24 deliberate exclusions (heritage lines, Tyne & Wear Metro, closed stations). One genuine
  miss: **Blyth Bebside**, opened 2024.

### 2.2 Darwin timetable files

**No credentials needed for seeding.** raildata.org.uk → *Darwin Timetable Files* → **Data
files** tab → browser download. Files regenerate daily around 02:05.

Download two and drop them in `data/darwin/`:
- `PPTimetable_<ts>_v8.xml.gz` — the timetable (`_vN` is the Darwin **schema** version, not a
  date; take the highest)
- `PPTimetable_<ts>_ref_v99.xml.gz` — the reference/location file

The scripts locate files by suffix, so a newer timestamp drops in without code changes.

Timetable content (2026-07-25 file):

| Element | Count | Meaning |
|---|---|---|
| `Journey` | 52,528 | services |
| `IP` | 377,373 | intermediate **calls** |
| `PP` | 335,975 | **passing** points (no stop) — reveals the physical path |
| `OR` / `DT` | 41,853 / 41,858 | origin / terminus |
| `OPOR/OPIP/OPDT` | ~10.7k each | *operational* (non-public) — always exclude |
| `Association` | 8,399 | splits & joins — **not yet handled** (§9.4) |

Reference file: 12,145 `LocationRef`, 12,667 `Via`, 43 `TocRef` (TOC code → display name).

**Filters applied everywhere** (37,012 of 52,528 journeys survive):
`isPassengerSvc="false"` (empty stock), `trainCat="BS"` (rail-replacement bus),
`toc="XR"` (Elizabeth line — already covered by the `elizabeth-line` mode).

**The file spans four service dates, unevenly.** For King's Cross:
`2026-07-24: 1 · 2026-07-25: 201 · 2026-07-26: 167 · 2026-07-27: 4`. It's a rolling
snapshot of today plus part of tomorrow. **Always filter on `ssd` for per-day figures.**

> ⚠️ `LocationRef` has 3,698 entries with a `crs`, but **1,054 of those are not stations** —
> rail-replacement bus stops (`… (Bus)`), platform-level splits (`Aberdare Platform 2`) and
> junctions whose `locname` is just the TIPLOC (`ABTSWDJ`, `ACTONTC`). **Never use
> "has a CRS" as the station test.** Gate on `stations.json` instead. Only one NaPTAN
> station is missing from the ref file (`STPADOM`).

### 2.3 Darwin live feed (prediction side — parked)

Kafka + JSON (Darwin v17), not STOMP/XML. Property keys already declared in
`StationlySyncer/src/main/resources/application.properties:91-110`, all env-injected, none
populated. Not needed for selections.

---

## 3. Verified facts about the existing system

Discovered the hard way. Several contradict reasonable assumptions.

### 3.1 `icsCode` and `stationNaptan` are null on **every** station doc

```
sum(icsCode IS NOT NULL) = 0     sum(stationNaptan IS NOT NULL) = 0     count(*) = 20,208
```

So `getGroupKey` (`dataCacheService.ts:403`) always falls through to **`commonName`**. Its
first two branches are dead code today.

**Consequence:** grouping is name-based, which is why NR stations merge with TfL ones for free
(§5.3) — and why it's fragile (`King's Cross Station` vs `King's Cross St. Pancras Underground
Station` are different groups).

### 3.2 `lastUpdatedTime` is a **number** in Firestore

Live staging sample: `1780275973032`. The **local `data/stationly.sqlite` holds ISO strings**
and is stale (pre-migration, dated 2026-07-15) — do not trust it for format.

This matters: `deltaSync` does `where('lastUpdatedTime','>',checkpoint)`
(`dataCacheService.ts:150`). Write the wrong type and your docs **never replicate**, silently.
`seedNationalRailStations.ts` reads a live doc and matches its shape — keep that behaviour.

### 3.3 There is no National Rail data in the system at all

```
.env:7  TFL_TRANSPORT_MODES="tube,overground,dlr,elizabeth-line,bus"

modes across all 20,208 station docs:
  bus 19,737 · tube 272 · overground 114 · dlr 45 · elizabeth-line 43 · national-rail 0
```

`910GKNGX` exists in **TfL's API** (child of `HUBKGX`) but was never synced, because
`national-rail` isn't in that list and is additionally in `EXEMPT_MODES`
(`tflUtils.ts:26`). The whole NR dataset is net-new. Nothing to migrate.

### 3.4 Read path

```
Firestore (master) ──delta+onSnapshot──► SQLite ──boot──► in-memory Map ──► every request
```

The API never reads Firestore or SQLite per request. SQLite stores the **entire doc as a JSON
blob** in `stations.raw_data`; the six typed columns are duplicated metadata and the search
path doesn't use them. **New fields like `crs` need no migration.**

Only the master instance syncs (`APP_ENV` production/staging **and** `NODE_APP_INSTANCE` `0`
or unset) — `dataCacheService.ts:33-50`.

> ⚠️ Station replication `apply` (`dataCacheService.ts:120`) is a **full doc replace**.
> Anything written only to SQLite, or into a doc the TfL sync owns, gets clobbered.

### 3.5 The station doc *is* the line index

`getLinesByMode` (`lineController.ts:277`) does, for a station:

```ts
groupKey  = getGroupKey(repr)
siblings  = allStations.filter(s => getGroupKey(s) === groupKey)
lineIds   = ∪ Object.keys(sib.modes[mode].lines)      // no computation, just a read
filtered  = getLinesByMode(mode).filter(l => lineIds.has(l.id))
```

> ⚠️ **Fallback trap:** if `lineIds` is empty it falls through and returns **every** line for
> the mode — and the app caches dropdown data for 24 h. So: seed the `lines` doc **before**
> the stations, and never write a station with `lines: {}`.

### 3.6 App constraints (StationlyUI)

| Fact | Location |
|---|---|
| Auto-skip fires only for `line`/`direction` when `options.size == 1` — **with `delay(500)`**, so single-option screens visibly *flash* | `SelectionViewModel.kt:457` |
| Step list is **hardcoded**: `listOf("mode","station","line","direction")` | `SelectionScreen.kt:231` |
| Search exists **only** on the station step (`idx == 1`) | `SelectionScreen.kt:305-318` |
| Layout fetched once at startup and cached in `cached_app_layout`; `/sdui/app/layout` takes **no parameters** → cannot vary the wizard per mode without a release | `SelectionViewModel.kt:111,136` |
| Dropdown data cached **24 h** keyed on resolved URL | `SelectionViewModel.kt` `fetchDropdownData` |

**But:** the app is a generic renderer for the *content* of each step. What the `direction`
step contains is entirely whatever `/lines/{line}/route` returns. This is the hinge that keeps
§7 cheap.

### 3.7 The SDUI chain

`sduiService.ts:612-646`:

```
mode      /modes
station   /stations/search?mode={mode}&lat={lat}&lon={lon}    dependsOn: mode
line      /lines/mode/{mode}?station={station}                dependsOn: station
direction /lines/{line}/route?station={station}&mode={mode}   dependsOn: line
```

The station step has **no `searchKey`**, so its default render is the *nearby* branch —
`getNearbyStations` (`dataCacheService.ts:374`), which **silently drops any station without
lat/lon**. Hence the 9 coordinate-less stations must inherit via `coordsFrom` or be excluded
deliberately.

---

## 4. Identifiers

**`naptanId` = `"9100"` + TIPLOC.** Not `9100`+CRS. Verified against the live NaPTAN area-910
CSV: `Bicester Village CRS=BIT → 9100BCSTRTN`, `Cambridge CBG → 9100CAMBDGE`,
`King's Cross KGX → 9100KNGX`, `Ely ELY → 9100ELYY`.

Darwin sends TIPLOC directly, so this is a **pure string concat — no lookup**.

**Collision check: 0** — all 2,645 generated ids against all 20,208 existing docs.

TfL's own NR stoppoints are `910G` + the **same TIPLOC suffix** (`910GMNCRPIC`, `910GCAMBDGE`,
`910GELYY`), which is why 154/154 matched. **Do not write into `910G`** — that namespace
belongs to the TfL sync and its full-replace would clobber us (§3.4).

`crs` is a **new field** — present on 0 of 20,208 docs. Additive, rides inside `raw_data`,
no SQLite migration. Needs adding to the `Station` interface (`src/models/index.ts:83`).
Nothing in the selection flow reads it; Darwin board lookups will.

---

## 5. The station document

```json
{
  "naptanId": "9100KNGX",
  "id": "9100KNGX",
  "commonName": "London Kings Cross Rail Station",
  "lat": 51.530883, "lon": -0.122926,
  "geoHash": "gcpvjhymp",
  "stopType": "NaptanRailStation",
  "indicator": null, "stopLetter": null,
  "crs": "KGX",
  "lastUpdatedTime": 1784987649499,
  "modes": { "national-rail": { "modeName": "national-rail", "lines": {
    "national-rail": { "id":"national-rail", "name":"national-rail", "directions":["northbound"] }
  }}},
  "searchKeys": ["national-rail","national-rail_national-rail",
                 "national-rail_northbound","national-rail_national-rail_northbound"]
}
```

### 5.1 Field notes

- Same 13 fields as existing rail docs (`910GABWDXR` etc.), plus `crs`.
- `stopType: "NaptanRailStation"` — **not** NaPTAN's raw `RLY`. Drives `isMajor` via
  `stopType.includes('RailStation')` in `getNearbyStations`.
- `name` inside a line is the **lowercase id**; the display label comes from the `lines`
  collection. Verified: tube stores `{"id":"northern","name":"northern"}`.
- `searchKeys` is a mode/line/direction **cross-product, no name tokens**. Formula:
  `1 + 6×lines` for 2-direction lines — King's Cross tube has 6 lines → 37 keys. ✓
  Name search uses the `commonName` substring path instead.
- `geoHash` is 9-char. **There is no geohash generator in this repo** (it comes from the Java
  syncer), so the seeder computes it. The implementation in `seedNationalRailStations.ts`
  reproduces the stored value for `940GZZLUKSX` exactly.

### 5.2 Sizing — a non-issue

2,645 docs ≈ 1.8 MB total. Largest doc well under 3 KB against a 1 MiB limit.
Route docs (§7) measured 1.4 KB (Bicester) to 15.4 KB (Manchester Piccadilly).

### 5.3 Grouping: 164 stations merge for free

164 of 2,645 share a `commonName` with an existing doc (Abbey Wood, Barking, Acton Central,
Clapham Junction, …). Because `getGroupKey` falls back to `commonName` (§3.1), those group
automatically and `getLinesByMode` unions modes across siblings.

**So there is no merge step and no writing into TfL docs.** An earlier plan to merge
`modes["national-rail"]` into the 152 overlapping `910G` docs was abandoned for exactly this
reason — it would have been clobbered by the next TfL sync.

King's Cross is *not* one of the 164: `London Kings Cross Rail Station` ≠ `King's Cross
St. Pancras Underground Station`. Correct — different stations 200 m apart.

> Note: NaPTAN writes `Kings Cross` (no apostrophe), TfL writes `King's Cross`. Since
> `commonName` is both the group key **and** the search field, a user typing `king's cross`
> gets no substring match. Fix search by stripping apostrophes on both sides; don't change
> `commonName`, which would re-key the group.

---

## 6. Rejected approaches (do not re-litigate without new evidence)

### 6.1 TOC-as-line

Operator as the `line` tier (LNER, Great Northern, Thameslink…). **Rejected:** it gates the
board behind an operator choice. At King's Cross, Edinburgh is served by LNER + Lumo + Grand
Central, so a passenger must pick one before seeing any departure — and two of the three run a
handful of trains a day. At Doncaster the same split is worse.

Useful as *labels* on departures. Never as a gate.

### 6.2 Corridor-as-line (built, measured, rejected)

`src/scripts/deriveNationalRailCorridors.ts` → `data/darwin/corridors.json`.

Method: station-level track graph from full physical paths (calls **and** passing points, so
fast trains still contribute stations they run through) → drop "skip" edges using
journey evidence (an edge `a–b` dies if any journey ever placed a station between them) →
contract degree-2 chains. Result: **793 corridors, 2,543 stations, 0 unreconciled**.

Works rurally — `carlisle-to-carnforth` (35 stations), `dovey-junction-to-pwllheli` (26),
`newcastle-to-carlisle`, `kentish-town-to-bedford`. **Fails in London**, which is where the
users are: every station is a junction, so the busiest "corridors" are 2-station stubs —
`london-liverpool-street-to-bethnal-green` (weight 1708),
`finsbury-park-to-london-kings-cross` (733). Paddington got one corridor and **lost Heathrow
entirely**.

Three earlier iterations and why they failed, so nobody repeats them:

| Attempt | Result | Why |
|---|---|---|
| Raw junction-level graph | 2,090 corridors, 1,511 of them 2-station | Darwin's granularity is junction-level; Slough has degree 10 among `STKYJN`/`DOLPHNJ`/`HTRWAJN` |
| + 2-hop transitive reduction on shared graph neighbours | 729 corridors but **766 stations orphaned** | "shares a neighbour" also fires on junction triangles; deleted 52% of edges |
| + journey-evidence skip removal | 886, but ids like `kngxbel-to-…`, `cambridge-to-shprtbj` | junctions carrying a CRS were acting as nodes → gate on `stations.json` |

**Keep the script.** The corridor data is still the right input for the *syncer's* board
bucketing, and it was how the station list got validated.

### 6.3 Bucketing by next calling point

Measured at Paddington: 5 buckets (Reading 223, Heathrow 151, Slough 71, Ealing Broadway 31,
Acton Main Line 5). Those are **stopping patterns**, not routes — Slough and Reading are the
same line. Using the next *path* point instead gives the opposite failure: **one** bucket
(`ROYAOJN`, 451), because Heathrow and Reading trains leave on the same track and diverge six
points later at `HTRWAJN`.

### 6.4 Ranking destinations by frequency

Produces adjacent intermediate stops nobody filters by:
`Ely → Cambridge South 100 · Cambridge North 84 · Waterbeach 54`;
`Bicester Village → Oxford Parkway 67 · High Wycombe 61 · Gerrards Cross 60`.

Adding a "major station" weight (top 15% by national calling volume) helped a little —
Bicester came out perfect (Oxford, Marylebone, High Wycombe, Banbury) — but King's Cross still
offered `Stevenage`, `Finsbury Park`, `Hitchin`.

**Conclusion: intent cannot be inferred from topology.** Stop trying to rank; let the user
search.

---

## 7. THE OPEN DECISION

Two models. The **station documents are identical** under both — only the contents of
`directions[]` differ.

### Model A — compass directions (what's on staging now)

`directions` = compass quadrant of the bearing from the station to each next calling point.

Measured: **1 → 151 stations · 2 → 2,041 (79%) · 3 → 311 · 4 → 88.**

Real output: KGX `["northbound"]`, PAD `["westbound"]`, STP `["northbound","westbound"]`,
CLJ 3, MAN 4, ELY 4.

Known defects:
- **Under-splits Paddington** — one direction, so Heathrow Express (29% of daily departures)
  mixes with the West Country.
- **Over-splits Clapham Junction** — `northbound` and `eastbound` both label
  "Towards London Victoria".
- **Bicester Village** — Oxford is SW and Marylebone SE, so the London train is labelled
  *Eastbound*. Mitigated by rendering `"Towards <destination>"` and keeping compass words as
  ids only.

Fixing both needs destination-path clustering with two hand-tuned thresholds (minimum share to
split, path overlap to merge).

### Model B — destination filter (recommended)

`directions` = destination CRS codes (plus `ALL`). "Where are you going?", filtering on
**calling points**, which is exactly `filterCrs` — the only filter Darwin/LDBWS offers.

Every Model A defect disappears without thresholds: Paddington splits Reading/Heathrow
naturally; Clapham has one "London Victoria"; Waterloo→**Woking** works even though Woking is
not a terminus and appears in no destination list.

**Cost:** no search on that step without an app release (§3.6). Mitigation: cap at ~12
destinations by frequency plus `ALL` — median offerable is 8 and 41% of stations have ≤6.

### What the decision actually costs

| | Change |
|---|---|
| Firestore collections | **none** |
| Station doc schema | **none** — only `directions[]` content |
| SQLite / replication / search / grouping / nearby | **none** |
| `seedNationalRailStations.ts` | **none** — already written |
| Route generation | same pipeline, different grouping rule |
| `getLineRoute` | one `if (mode === 'national-rail')` branch |

**Model B ships with zero app changes** by putting destinations in the existing `direction`
slot — the app renders them as cards, and `direction:"CBG"` is as valid a saved value as
`direction:"northbound"`.

**The one thing that's expensive to change later** is what gets persisted in saved boards:
a compass word, or a destination CRS. Decide that before seeding all 2,645.

---

## 8. Measured data

All from the 2026-07-25 timetable, passenger services only, `toc=XR` excluded.

### 8.1 Per-station shape

```
directions per station    1:151   2:2041   3:311   4:88
destinations per station  median 5    p95 14   max 55 (Manchester Piccadilly)
destinations per DIRECTION median 2   p95 7    max 33 (Waterloo southbound)
reachable calling points  median 25   p90 58   max 322 (Manchester Piccadilly)
"offerable" destinations  median 8    p90 25   max 88   (≤6 for 41% of stations)
```

### 8.2 Departures 08:00–09:00, one service day — the chip-viability test

| Station | Departures | Distinct destinations | Chips viable? |
|---|---|---|---|
| Bicester Village | 4 | 2 | yes |
| Ely | 10 | 7 | yes |
| London Kings Cross | 11 | 9 | marginal |
| London Paddington | 16 | 12 | marginal |
| Edinburgh | 25 | 17 | **no** |
| London Liverpool Street | 26 | 13 | **no** |
| London Waterloo | 34 | 18 | **no** |
| Manchester Piccadilly | 35 | 22 | **no** |
| Clapham Junction | 38 | 14 | **no** |
| Birmingham New Street | 44 | 25 | **no** |

Almost one destination per train at the big stations. **This is why chips alone don't scale
and search is required at the top end.**

### 8.3 Whole-day departures

```
Bicester Village   66   (Oxford 52%)          King's Cross      201  (Edinburgh 13%)
Ely               173   (Kings Cross 21%)     Paddington        259  (Heathrow 29%)
Waterloo          609   (self ×72 — see §9.3) Clapham Junction  662  (Victoria 47%)
```

Beware three different counts for the same station: services **calling** (733 at KGX),
services **departing onward** (373), departures on **one service day** (201). Roughly half the
traffic at a terminus arrives and ends there.

### 8.4 Platform coverage

**82.2%** of public calling points carry `plat` (378,994 / 461,084). **100%** at Waterloo,
Manchester Piccadilly, Edinburgh, Birmingham New Street. **0%** at Paddington — GWR assigns
platforms late, so they arrive via the live Push Port feed, not the baseline.

---

## 9. Known bugs & gaps

### 9.1 `stations.json` is invisible to git

`.gitignore:21` is a blanket `*.json` (a Firebase-key guard, with existing escapes for
`package.json`, `tsconfig.json`, `openapi.json`). `.gitignore:50` `/data` hides `data/darwin/`.

`src/data/nationalRail/stations.json` **should be committed** — it's a hand-built join not
reproducible from anything in the repo, and the seeder depends on it. Add:

```gitignore
!src/data/nationalRail/*.json
```

Keep the Darwin `.gz` files ignored (licensed OGL3, regenerated daily). `corridors.json` only
needs committing if Model A/corridors is revived.

**Committing does not deploy it.** `.scripts/staging_deploy.sh` excludes `src` and `data`, and
`tsc` doesn't copy JSON assets. Seeders run **locally against Firestore**; replication
distributes the result. That's intended, not a workaround.

### 9.2 `getCompassDirection` mislabels every NR direction

`lineController.ts:74` switches on `lineId`. `national-rail` has no case, so it hits
`default: dirLower === 'inbound' ? 'Eastbound' : 'Westbound'`. Our direction id is
`"northbound"`, which isn't `"inbound"` — so **King's Cross renders "Westbound"**.

Fix — treat NR like bus, which already returns a bare `"Towards"`:

```ts
if (modeLower === 'bus' || modeLower === 'national-rail') return 'Towards';
```

This also resolves the Bicester mislabelling, since the destination then carries the meaning.

### 9.3 Self-terminating (circular) services

**Waterloo runs 72 a day** — Hounslow/Kingston loops that depart Waterloo and return to
Waterloo. It's the top "destination" at 12%, so an unfiltered board shows rows reading
`08:00 London Waterloo`. Meaningless to someone standing at Waterloo.

Same class as commit `a87895e` (TfL self-terminating → "Check Front of Train"). The NR
generator needs the equivalent: label a circular service by a distinctive mid-point
("via Hounslow"), not its terminus.

### 9.4 `Association` records ignored

8,399 splits/joins. A service that divides en route serves two termini, but today only its
final calling point is counted, so one destination is silently missing. Correctness gap, small
minority of services.

### 9.5 Unmapped TOC codes and non-station termini

`LS` appears as a TOC (Barking, Edinburgh) but isn't among the 43 `TocRef` records.
`DMTHKWR` appeared as a destination but isn't in `stations.json`. Both surfaced as raw codes
in generated output. Fix: fall back to the ref file's `locname`, or drop the destination —
these were single services, so dropping is safe and cleaner.

### 9.6 No line colour for NR

`TFL_LINE_COLORS['national-rail']` is undefined, so `color: null` on line cards
(`lineController.ts:305,321,345`). Fall back to the mode tint `#1D3E89`.

### 9.7 Board rows can't express National Rail

`PredictionItem` (`src/models/index.ts:37`) is `{destId, platform, eta, displayName}` —
**no status field**. `formatETA` renders a countdown ("Due", "7 min").

National Rail needs **scheduled clock time** (people plan around 08:32, not "27 min") and
**status** (On time / Expected 08:41 / Cancelled). On the most disruption-prone mode we'd
carry, a board that cannot say "Cancelled" misleads.

**This is an app change under *either* model** — it's about the board, not the selection.

### 9.8 Pre-existing: `910GPADTON` has a wrong geohash

Stored `gcpvj0u3v` doesn't match its own lat/lon (that prefix is near King's Cross, ~4 km
off). TfL-sync bug, not ours. Nothing reads `geoHash` today.

### 9.9 `metadata/subscribed_stations` is a single doc

A `stationCounts` map in one Firestore doc. Adding 2,645 stations raises doc-size and
write-contention risk. Consider sharding by ATCO prefix before NR goes wide.

---

## 10. Next steps

**Blocking:** settle §7 (compass direction vs destination CRS) — it decides what gets
persisted in users' saved boards.

Then, in order:

1. **Get a staging client `X-Stationly-Key`** and verify the three endpoints against the 9
   docs already written. Nothing has been confirmed end-to-end.
2. **Fix §9.2 and §9.6** — ~10 lines, makes the existing 9 render correctly.
3. **Build the per-station route generator.** One script emits **both** the station doc's
   `directions` and the `routes/{naptanId}` doc, from one grouping function — deriving them
   separately is how backend and syncer drift and boards render empty. Fold in §9.3 and §9.5.
   Store in the existing `routes` collection keyed by naptanId (already replicated; no
   collision, since TfL line ids are words).
4. **Branch `getLineRoute`** on `mode === 'national-rail'` to read `routes/<station>` instead
   of `routes/<lineId>`, and skip the TfL fallback. Everything downstream reuses the existing
   code path.
5. **Re-seed the 9**, review on staging, then `--write --all` for 2,645.
6. **Add `crs`** to the `Station` interface.
7. **Commit** the uncommitted files and §9.1's gitignore line.

Deferred to an app release: search on the destination step, removing the 500 ms line-step
flash, and §9.7's board row. Deferred entirely: the syncer/predictions side
(`StationlySyncer`), which needs the Kafka credentials wired.

---

## 11. Commands

```bash
# derive corridors (rejected model — reference only)
npx ts-node src/scripts/deriveNationalRailCorridors.ts

# seed stations — dry run prints the docs and checks for id collisions
npx ts-node src/scripts/seedNationalRailStations.ts
npx ts-node src/scripts/seedNationalRailStations.ts --write          # the 10-station test set
npx ts-node src/scripts/seedNationalRailStations.ts --write --all    # all 2,645

# mode enabler (already run on staging)
npx ts-node src/scripts/seedNationalRailMode.ts --write
```

`seedNationalRailStations.ts` enforces four guards, all before any write:
**1.** abort on any doc-id collision · **2.** skip stations with no derivable direction ·
**3.** write `lines/national-rail` first · **4.** match the live `lastUpdatedTime` type.

**Environment:** `.env` `FIRESTORE_PROJECT_ID` currently `mindthetimefcm` = **staging**.
Production is `stationly-prod`. Check before `--write`.

---

*Last updated 2026-07-25.*
