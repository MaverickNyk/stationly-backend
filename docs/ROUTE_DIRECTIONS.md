# Route directions — branches, "towards", and the per-destination timeline

How `GET /api/v1/lines/{lineId}/route?station={naptan}&mode={mode}` builds the
direction options the app shows after a user picks a station + line, and how the
client renders them. Pairs with `DATA_CACHE_ARCHITECTURE.md` (how routes are
cached) and `PLATFORM_DISPLAY.md`.

## The data the endpoint returns

One object per **served direction** (a direction with no downstream destinations
from the chosen station is dropped):

```jsonc
{
  "id": "inbound",                  // raw TfL direction (kept for selection)
  "directionName": "Westbound",     // passenger compass (rail) | "Towards" (bus)
  "towards": "West Brompton",        // headline next-stop (see priority below)
  "label": "Westbound towards West Brompton",   // legacy composed string
  "secondaryLabel": "…",             // legacy dot-joined common trunk
  "destinations": [                  // reachable branch TERMINI, each with…
    { "id": "940GZZLUWIM", "label": "Wimbledon", "name": "Wimbledon",
      "upcomingStations": ["West Brompton","Fulham Broadway","…","Southfields","Wimbledon"] },
    { "id": "940GZZLURMD", "label": "Richmond", "name": "Richmond",
      "upcomingStations": ["West Kensington","Barons Court","…","Richmond"] }
  ],
  "upcomingStations": ["…common trunk…"]   // stops shared by ALL branches (default timeline)
}
```

### Key idea: per-destination branches + a common trunk
At a junction (e.g. **Earl's Court** on the District line) one compass direction
splits into several branches with **different** stops. So the controller, for the
chosen station:

1. Finds every **branch run** leaving the station — `{ terminusId, stops[] }` —
   from the route's `sequences` (ordered NaPTAN lists per direction).
2. Attaches each run's `stops` to the matching **destination** object's
   `upcomingStations` (reusing that field — no new schema). So each chip carries
   *its own* branch.
3. Computes the **common trunk** = the longest ordered prefix shared by all
   reachable branches → the direction-level `upcomingStations`. One branch ⇒ the
   whole branch; a hard junction ⇒ empty.

This fixes the old bug where a single `getUpcomingStops` returned only the first
matching branch — at Earl's Court that was the 1-stop *Kensington (Olympia)* spur,
so the Wimbledon branch (incl. **Southfields**) silently vanished.

### `towards` headline (incl. junctions)
The client picks the headline target dynamically:
1. **A chip is selected** → that branch's **next stop** (tap *Wimbledon* at
   Earl's Court → "towards West Brompton").
2. **A common trunk exists** → its **first stop** (`towards`, resolved
   backend-side as: stop's TfL `Towards` → first common stop → first terminus).
3. **No common next stop (hard junction)** → the **destination list itself**,
   e.g. "towards Wimbledon, Richmond & 2 more" — exactly what the platform sign
   shows. (Per product decision the non-junction headline is the next stop, not
   the terminus.)

## How the client renders it (`SelectionScreen.kt` → `DirCard`)

- **Compass** (rail only) → a small, muted tag (a confirmation cue, not the
  headline). Buses get none.
- **`towards {next stop}`** → the bold highlighted headline.
- **Destination chips** → from `destinations`. With **>1** destination they're
  **tappable**: tapping one swaps the timeline to that branch
  (`destination.upcomingStations`); tapping again returns to the common trunk.
- **Timeline** → **always shows a sequence by default.** Preference order:
  1. selected chip's branch → label "STATIONS TO {DEST}";
  2. else the **common trunk** (`upcomingStations`) → label "STATIONS THIS WAY";
  3. else (hard junction, no shared stops) the **richest branch** (most stops)
     → label "STATIONS TO {DEST}".
  A **"routes split" note sits BELOW the stops** whenever the direction branches
  and no chip is chosen yet — never an empty card.

**Earl's Court / District example:** default shows the *richest* branch's stops
(e.g. Ealing/Richmond) with the split note below; tap *Wimbledon* → West Brompton
→ Fulham Broadway → Parsons Green → Putney Bridge → East Putney → **Southfields**
→ Wimbledon Park → Wimbledon.

## SDUI surface (everything is backend-tunable)

| Source | Drives | Where |
|---|---|---|
| `GET /lines/{id}/route` | directionName, towards, destinations(+per-branch stops), common trunk | route response |
| `getSelectionLayout()` `screen_direction_*` | step title/subtitle (with `{vehicle}`/`{station}`) | selection layout |
| `getSelectionLayout()` `dir_*` keys | card chrome: `dir_towards_label`, `dir_stations_label`, `dir_stations_to_label` (`{dest}` interpolated), `dir_split_hint` | selection layout |

The client hardcodes **only offline fallbacks**; when the backend sends these
keys/fields they win. So both the *content* (routes/branches) and the *chrome*
(labels) are server-driven and changeable without an app release.

## Compass mapping — how it's derived (and what's correct)
TfL does **not** compute compass labels from geography; it signs each line with a
**fixed convention line-wide**, even on perpendicular branches (the District's
north–south Wimbledon branch is still signed "Westbound"). So `getCompassDirection`
is a **per-line `inbound`/`outbound` → label table** — the TfL-faithful approach.
A **geographic bearing was deliberately rejected**: it would read "Southbound to
Wimbledon", contradicting the platform sign.

- **District & Metropolitan:** fixed — TfL labels the WESTERN/outer termini as
  `inbound`, so both map `inbound → Westbound, outbound → Eastbound` (opposite of
  the default). District: Wimbledon/Richmond/Ealing; Metropolitan: Amersham/
  Chesham/Watford/Uxbridge (Aldgate = the eastern end → Eastbound).
- **Northern:** audited — already correct (`inbound → Southbound` = Morden,
  `outbound → Northbound` = Edgware/High Barnet).
- **Circle:** Clockwise / Anticlockwise (Inner/Outer Rail), not compass.
- **Gold standard (deferred):** sync TfL's per-platform `CompassPoint` so the
  label is exactly what's signed, removing the table entirely. Syncer change.
