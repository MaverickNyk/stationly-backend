# Stationly Kiosk — the café departure board

**Status: temporary tenant.** This folder is the Stationly web app. It lives
inside `stationly-backend` for the café trial and is built to be lifted out in
one commit. Nothing else in the backend knows it exists.

This is the only document for the feature.

---

## 1. What it is

A departure board for a TV on a café wall. One screen, one station: next
departures per platform, the status of that station's lines, the wider network,
and a QR code to the app.

React + Vite, one built route (`/kiosk/:stationId`). A venue is provisioned by
being handed a URL — no per-venue build, no release to change a station.

```
┌───────────────────────────────────────────────┐
│  roundel · STATION · line pills · Stationly   │  ┐
│  ┌ next departure ┐  ┌ next departure ┐       │  │
│  └────────────────┘  └────────────────┘       │  │ ~70%
│  ┌─ dot-matrix board, grouped by platform ─┐  │  │
│  │  ─────────── status marquee ──────────  │  │  │
│  │  ─────────── blinking clock ──────────  │  │  ┘
├─────────────────────────────┬─────────────────┤
│  network status             │   Stationly QR  │  ~30%
└─────────────────────────────┴─────────────────┘
                    ⤢                              ← fullscreen
                              Last Updated: 12s ago
```

**Trial venue:** an independent coffee shop in Hackney Wick, metres from the
station, driving a wall TV from a Fire Stick. The default station
(`910GHACKNYW`) is theirs.

---

## 2. Why it lives inside the backend

Three things fall out of being in-process that no separate frontend host gets
for free.

**The API key never reaches a browser.** `/api/v1/*` is gated by
`validateApiKey`, and a key shipped to a public café screen is a published key.
In-process there is no request to sign. `mountTemporaryWebApp(app)` is called
after `express.json()` and **before** the `/api/v1` router precisely so the
kiosk's routes never meet that middleware.

**The kiosk is free.** It reads the same `PredictionCache` the Syncer already
fills. A display on a subscribed station costs a memory read and **zero extra
TfL calls**.

> ⚠️ **The dependency this creates:** a station nobody has saved in the app is
> not in the Syncer's poll set. Such a board is warmed once at connect and then
> never pushed to. **Confirm the trial station has a real subscriber.**

**Same origin**, so no CORS and the backend's `/icons/*` artwork is directly
reachable — which is why this folder carries no icon files of its own.

---

## 3. The two tenancy rules

**1. This folder imports nothing from `../src`.** Backend types are *mirrored*
in `src/api/types.ts`, never imported. Own `package.json`, own `node_modules`,
own `tsconfig.json`. React and Vite never appear in the backend's manifest.

**2. The backend touches this through exactly one file** — `../src/tempWebHost.ts`.
`src/server.ts` has two calls inside blocks marked
`⚠️ TEMP WEB HOST — DELETE THIS BLOCK ON EXTRACTION`.

That is the whole coupling. Deleting both is the whole extraction.

---

## 4. Architecture

### The data path

```
TfL → Syncer → change detection → StationStreamHub ─┬→ phones  (/api/v1/stream, authed)
                                                     └→ café TV (/kiosk-stream, in-process)
```

The wall is fed by the identical path the phones are. No polling anywhere.

### Why not `/api/v1/stream`

It closes any socket that has not presented a Firebase ID token within ten
seconds, and a screen on a wall has no user. The two wrong fixes — mint a
service account for a TV, or poke a hole in the real stream's auth — both put a
credential on a public display.

Instead the socket is registered into the *same* hub under a synthetic uid
(`kiosk:<naptan>`) by an in-process call. **No token is needed because no trust
boundary is crossed.** The phone stream is untouched.

Read-only by construction: `maxPayload: 1024`, inbound frames ignored, station
fixed from the URL for the life of the connection.

### The upgrade interception

`attachTemporaryKioskStream` **intercepts** the server's `upgrade` event rather
than appending to it, because `attachStationStream` *destroys* any socket whose
path is not its own, and Node runs every listener — so a second handler would
have its socket destroyed underneath it, in either order. The tenant lifts the
listeners off, puts itself in front, and delegates everything else untouched.

> ⚠️ Anything registering an `upgrade` listener **after** this one will not be
> delegated to. `attachTemporaryKioskStream(server)` must stay last in
> `server.ts`.

### Wire protocol

```jsonc
{"type":"snapshot"|"update", "station":"910G…", "payload":{…}}  // departures
{"type":"snapshot"|"update", "line":"mildmay",  "payload":{…}}  // one line's status
{"type":"kiosk_meta", "statuses":[…], "lineModes":{…}, "serverNowMs":…}
```

Station and line frames are told apart by **which id field is present**, not by
the type. `kiosk_meta` is sent once per connection and carries what the hub
protocol has no shape for: joined statuses, per-line mode, and the server clock.

### Layout

```
src/
├── api/types.ts            ← HAND-MIRRORED from backend models
├── config/kiosk.ts         ← URL-parameter config + NaPTAN validation
├── config/assets.ts        ← every image URL, in one place
├── time/london.ts          ← the ONLY place London time is derived
├── design/                 ← tokens.css (palette), board.css (all layout)
├── components/kiosk/       ← roundel, pills, QR, network panel, gate, fullscreen
├── features/departures/
│   ├── logic/              ← pure: eta, board, status, fallback
│   ├── hooks/              ← stream, minute tick, row transition, auto-update, wake lock
│   └── components/         ← board, split-flap, marquee, hero card, footer
└── routes/kiosk/           ← composition
```

`/`, `/board/:id` and `/login` are **deliberately not built** — absent rather
than stubbed, so nothing reads as half-working. `/board` needs the signed-in user
the kiosk avoids; `/login` should consume the backend's SDUI layout
(`GET /api/v1/sdui/app/login`) rather than hardcoding a form.

---

## 5. The rules that make it a departure board

Every one is a decision already made and defended on another surface. A web
board that behaves differently from the phone in the user's pocket is a product
bug, not a platform difference.

### ETA

| Rule | Why |
|---|---|
| **Floor, never round-half** | TfL's own. 90s and 119s both read "1 min" — they under-promise so the rider makes the train. |
| **30s departed grace** | The dwell of a train at a London platform. The board keeps showing "Due" through it because the physical platform indicator does, and that is what riders cross-check against. |
| **Sort on the target, never the label** | The label is rounded *and* bumped; reading it back is reading a lie, and two close trains land wrong exactly when it matters. |
| **Unparseable sorts last** | An unknown time is not an imminent one. |

**Per-platform monotonic bump:** two trains on one platform may not show the
same label, so a collision shifts the later one up and propagates —
`Due, Due, Due` → `Due, 1 min, 2 min`. **Cross-platform collisions are left
alone**: Platform 1 "1 min" and Platform 2 "1 min" are two trains and both true.

**Destination shortening** is the one deliberate divergence from the apps: the
café board also strips `(London)` and a trailing `Rail`. At six metres those
eleven characters are the difference between a destination you take in and one
you read.

### Board

**Platform order is fixed** (numbered numerically, then lettered, then
unassigned), *not* soonest-first like the phone. A phone board is read once by
someone deciding what to do next. A café board is read a hundred times by the
same people, and a block that moves whenever the other platform gets busier
makes them re-read the whole thing. Fixed positions mean a regular learns "left
is Richmond".

**The board keeps unassigned platforms; the hero cards drop them.** TfL stops
assigning platforms beyond ~30 minutes out. A hero card is an instruction — "the
train to move for" — and it cannot name a platform TfL has not given. The board
row carries the same train honestly. This is a **filter, never a relabel**: the
platform string stays backend-owned (`docs/PLATFORM_FORMATTING.md`).

### What an empty board says

An empty board is a **claim** — "no trains here" — and at 03:00 that is
indistinguishable from a broken screen. In evaluation order:

1. has predictions → nothing
2. offline → "Offline"
3. **a non-good-service status** → the live TfL severity (it is almost certainly
   *why* there are none, and beats the clock buckets)
4. 00:00–04:30 → "Service ended for tonight"
5. 04:30–06:00 → "Service starting soon"
6. last update ≥ 6 min → "Live updates paused"
7. otherwise → "Nothing departing right now"

**4 and 5 before 6 is load-bearing:** after the last train there is nothing to
fetch, and calling that silence "Live updates paused · Last refresh 5h ago" makes
the board blame itself for behaving correctly. Staleness is claimed only when the
age is actually known.

### Status strip

One strip, not one per line. Disrupted only, worst first, rotating every 8s.
**"Good Service" never takes a rotation slot** — saying it three times says
nothing three times. Entries de-duplicate on (severity, reason) with labels
joined, because sub-surface lines share track. An **unrecognised severity ranks
below known disruptions but above Good Service**: new TfL wording is far more
likely to be a new disruption, and burying it is the worse failure. **Red means
"you cannot travel"** — delays are amber, because a train is still coming.

### Motion

**The split-flap stagger is the effect** — a crossfade reads as a screen
redrawing itself. **Unchanged characters do not animate.** **Clipping is the
effect, not a limitation**: unclipped, glyphs draw over neighbouring rows and a
flip looks like a smear.

**Row direction encodes cause:** vertical = the world moved (new data). Horizontal
would mean "you moved", and there is no paging on a café wall, so nothing moves
horizontally at all.

**Only transitions animate.** Nothing runs while the board sits still, which is
what makes it safe for twelve-hour days.

### Colour, clocks

Line colour lives in the **chrome** — pills, roundel, hero accent — and never
enters the rows. Real platform boards are single-colour amber.

Two clocks on purpose. The **countdown** ticks on the wall-clock minute boundary
so the hero and the rows flip together and match the viewer's own watch. The
**footer clock** ticks per second with blinking separators — the board's proof of
life, since a countdown that moves once a minute is indistinguishable from a
frozen screen for fifty-nine seconds out of sixty.

All clocks are pinned to **Europe/London**; a café TV is very often on the wrong
timezone. The countdown runs on the **server's** clock (`serverNowMs` → skew), so
a TV three minutes fast does not silently drop every train before it arrives.

### Fitting the screen

The type scale is sized in **`vw`**, deliberately: on a TV the viewer's distance
tracks the screen's *width*, so width is what legibility should follow.

That assumption inverts on a wide-but-short viewport — any desktop browser that
is not fullscreen. `vw` holds every row, hero and header at TV size while the
height available for them collapses, and the board overflows its own `100dvh`
box. Because `.kiosk` is `overflow: hidden` there is no scrollbar to say so; the
excess is simply gone.

So `@media (max-height: 900px)` caps the height-driving sizes as
`min(Xvw, Yvh)` — the same clamp idiom, bounded on both axes — and trims the hero
band and the panel gaps. A second tier at `≤620px` goes further. **A 1080p TV
matches neither and renders exactly as it always did**; this is a correction for
looking at the board on a laptop, which is how it is reviewed far more often
than it is deployed.

### Unattended operation

Deployment check every 30 min (hashed bundle name), a 6-hour rolling reload, a
nightly 03:30 London reset, and a **screen wake lock** re-acquired on every
visibility change (the platform releases it silently and never hands it back).

---

## 6. Configuration

Station is a **path segment**; everything else is a query parameter. One build
serves every venue.

```
/kiosk/910GHACKNYW?k=fb-hackneywick&venue=Bloom%20Coffee&overscan=3
```

| Parameter | Default | Meaning |
|---|---|---|
| *(path)* | `910GHACKNYW` | NaPTAN id, validated client- and server-side |
| `k` | — | Access code (§7) |
| `venue` / `message` | `""` | Venue name and message — **read but not rendered**, see §9 |
| `rows` | `3` | Departures per platform block |
| `platforms` | `4` | Platform blocks on the board |
| `cards` | `2` | Hero cards. More than two get too narrow to read across a room |
| `qr` | `""` | QR caption. Empty by default: a QR on a wall needs no instructions |
| `overscan` | `0` | Edge padding, in `vh`/`vw`, for a TV that crops **in hardware**. Capped at 10 |

`overscan` is for a set that physically cuts its own edges. It is *not* a fix
for a board that looks clipped in a desktop browser — it adds padding to a
fixed-height box, so on a window the board already overflows it makes the
overflow worse. See §5's short-viewport note.

---

## 7. Access

A **doorbell, not a lock** — bypassable from devtools, and meant to be. It stops
a trial board being idly shared and tells us which tester opened what.

**The invitation link answers for the viewer.** A wall screen is driven by a TV
remote, and typing an email on a D-pad keyboard is a miserable first thirty
seconds on a board somebody waited two months for.

```
https://staging-api.stationly.co.uk/kiosk/910GHACKNYW?k=fb-hackneywick
```

`?k=` is an **access code, not an email** — board URLs get bookmarked,
photographed and read off walls. On first open it authorises, persists, and is
**stripped from the address bar** by `replaceState`; other parameters survive.
Because the code lives in the **bookmarked link**, a TV browser that clears its
site data re-authorises silently. The typed-email form remains for anyone on a
bare URL.

Add or revoke a tester: one line in `ACCESS_CODES` in `KioskGate.tsx`. That map's
values *are* the allowlist, so there is no way to add someone to one and forget
the other.

---

## 8. Running, deploying, and the Fire Stick

### Development

```bash
npm run dev                                  # repo root, :3000
cd web-temp && npm install && npm run dev    # :5174
```

Open `http://localhost:5174/kiosk/910GHACKNYW`. Vite proxies `/kiosk-api`,
`/kiosk-stream` (`ws: true`) and `/icons` to :3000.

### Deploy

```bash
cd web-temp && npm run build     # tsc -b && vite build → dist/
```

> ⚠️ **Required before every deploy.** The deploy script excludes `src` at any
> depth, so **only `dist/` ships**. Forgetting it leaves the café on the old
> bundle, or on `Kiosk build missing — run npm run build in web-temp/`, which is
> what the SPA fallback returns rather than a blank 500 on a wall.

`dist/` is gitignored: a build artifact, produced before a deploy, not committed.

> ⚠️ **A clean-checkout deploy deletes the board.** The rule above assumes
> `staging_deploy.sh`, which rsyncs the *working tree* — where `dist/` exists
> because you just built it. A deploy from a fresh `git clone` has no `dist/`
> at all (it is gitignored), and `rsync --delete` then removes the one on the
> box. Staging went down exactly this way on 2026-09-02 during cutover step B3
> and was only noticed the next day: every `/kiosk/*` request served
> `Kiosk build missing`. Any deploy path that builds from a checkout must run
> `cd web-temp && npm ci && npm run build` before the rsync, or skip
> `web-temp/dist/` in its `--delete` set. **Not yet fixed** — B3 will do it
> again.

### nginx

Three blocks in `server-config/nginx.staging.conf`. On `= /kiosk-stream` all
three non-default settings matter: `proxy_read/send_timeout 3600s` (or nginx
kills an idle-but-healthy socket every 60s) and `proxy_buffering off` (or a
"live" board updates in bursts).

### Fire TV Stick setup

Two settings must be changed by hand, and neither is discoverable:

1. **Screensaver off** — Settings → Display & Sounds → Screensaver → Start after
   → **Never**. Fire TV shows its photo screensaver after minutes of no remote
   input, and a wall display is permanently in that state. At defaults the board
   disappears behind holiday photos within five minutes and reads as our bug.
2. **Sleep → Never** — Settings → Device & Software. The wake lock covers this
   where supported; set it anyway.

Then: open the invitation link in Silk, **bookmark it**, and press **OK** to go
fullscreen (**Back** to exit — there is no Esc on a remote). The fullscreen
button is the only focusable element and takes focus on arrival, so no cursor
hunting.

**The stick must be recent.** The board uses `clamp()` 111 times and flex `gap`
39 times, putting the floor at Chromium 79/84. A current 4K / 4K Max / HD stick
is fine; a 2016 Fire OS 5 device ships Chromium 59, renders the board as a broken
pile, and no longer receives Silk updates.

**If the TV crops the edges**, append `?overscan=3` and raise until nothing is
cut.

**Not handled:** a power cut. Nothing reopens the browser on boot. Acceptable for
a trial; a product wants a kiosk browser that auto-starts.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `Kiosk build missing` | `npm run build` not run before deploy — **or** the deploy came from a clean checkout, which has no `dist/` to ship (§8, Deploy) |
| Header and hero cards missing off the **top** | The window is too short for the board and something scrolled the clipped container. Fixed 2026-09-03 (§9 bug 14); if it returns, check nothing focuses an element below the fold without `preventScroll` |
| Stuck on "Connecting…" | Socket not upgrading — check the nginx block, and that `attachTemporaryKioskStream` is still last in `server.ts` |
| Paints once, never updates | Station probably not in the Syncer's poll set — no app user has it saved (§2) |
| "Live updates paused" | Genuine: no frame for ≥6 min; the watchdog will have logged a reconnect |
| Board renders as broken text | Stick too old, Chromium < 79 |
| Corners or button cut off | TV overscan → `?overscan=3`. Only if the *set* crops; not for a short browser window, where it makes things worse |
| Vanishes after minutes, photos appear | Fire TV screensaver |
| Black after ~20 minutes | Fire TV sleep |
| Gate asks for an email on the TV | Link opened without its `?k=` code |
| Clock an hour out | No `Europe/London` tz data; falls back to device time rather than failing |
| Coloured ring instead of a roundel | No artwork for that mode (tram, national rail). By design |

---

## 9. Review log

Two full passes. `tsc --noEmit` clean on the backend, `tsc -b && vite build`
clean here. Nothing changed behaviour except where it was wrong.

The bar applied was **"nothing here becomes a landmine when this graduates"** —
and anything that would silently degrade a screen left running for *days* was
treated as a real bug, because that is the actual deployment.

### Bugs fixed

| # | Bug | Consequence |
|---|---|---|
| 1 | **`useKioskStream` had no generation guard.** The watchdog closes a socket → `wake` sees `CLOSING` and opens a replacement → the old socket's `onclose` *then* schedules a retry on top of it. | Sockets doubled per round, each registered in `StationStreamHub` and never closed. **The leak was server-side as much as on the TV**, and grew with exactly the events an unattended screen sees most. Fixed with a generation token plus `discard()` that detaches handlers before closing. |
| 2 | **State never reset on station change.** React Router swaps `:stationId` without remounting. | A repointed screen showed the *previous* station's departures under the *new* station's name until the first frame landed. Worse than showing nothing. |
| 3 | **`NextDepartureCard` parsed the ETA back off its own label.** `Number('')` is `0`. | A train whose time we could not compute rendered a confident, urgent-styled amber **"0 min"** — breaking the rule `eta.ts` states outright. `DepartureRow` now carries `etaMinutes: number \| null`. |
| 4 | **Rows keyed by array index**, discarding the stable key `useRowTransition` exists to compute. | A departing train shifted every row up one index, so the entry animation played on whichever row ended up last. The hook's entire purpose was inert. |
| 5 | **Slot arithmetic counted live rows, not padded ones**, and hardcoded `3` against a configurable `?rows=`. | Type sized for a shorter board than the one on screen; blocks overflowed the panel. |
| 6 | **`stationStatuses` fell back to the whole `statuses` array.** Harmless until `kiosk_meta` began sending all 19 network lines. | A Hackney Wick board rotated Piccadilly and Jubilee disruptions through its own marquee as if they were this station's. |
| 7 | **Hero cards counted by `maxPlatforms` (4)** instead of the hero count (2). | Four cards in a row sized for two. Split into `maxHeroCards`. |
| 8 | **`dangerouslySetInnerHTML` on `?qr=`.** | The URL handed to a café was a script-injection vector into their wall display, for a feature that prints one sentence. |
| 9 | **Unguarded `localStorage` in `KioskGate`.** Blocked site data *throws* rather than returning null. | An uncaught throw unmounted the tree: a blank screen, on the path that runs before anything renders. |
| 10 | **Bare `/kiosk/` redirect dropped the query string.** | `?k=`, `?venue=`, `?overscan=` were silently eaten — the board then asked a television for an email. |
| 11 | **Overscan padding used `%`.** CSS resolves percentage padding against *width* on all four sides. | `padding: 3%` inset the top and bottom by 5.3% of their own axis. Now `vh`/`vw`. |
| 12 | **Module-level `Intl.DateTimeFormat` with an explicit `timeZone` throws** where tz data is absent. | The throw happens at *import*, taking the bundle down — a white screen on a wall. Now falls back to device time with a warning. |
| 13 | Dead `!valid` fallback branch; watchdog logged "75s" against a 6-minute constant. | Cosmetic, both removed. |
| 14 | **`autoFocus` on `FullscreenButton` scrolled a container with no scrollbar.** The button is the last child of `.kiosk`, which is `100dvh` with `overflow: hidden`. Where the content did not fit, the browser scrolled the focused button into view — `overflow: hidden` prevents *user* scrolling, not programmatic. | The board silently lost its header and hero cards off the **top**. Measured at 1440×783: 916px of content in a 783px box, `scrollTop` 133, `.kiosk__head` at `-120px`. Nothing on screen explained it; it read as a broken board, and `?overscan=` — the parameter a reader would reach for — made it worse by adding padding to the same fixed box. Now a ref plus `focus({ preventScroll: true })`, which the JSX `autoFocus` prop cannot express. The one-press-OK behaviour on the remote is unchanged. |

Bug 14 also exposed a real layout fault behind it — the board genuinely did not
fit a laptop-height window, because a `vw` type scale does not shrink when only
the height does. `preventScroll` stops the damage; the `max-height` tiers in
§5's *Fitting the screen* are the fix. Both were verified against staging:
content 724px in a 727px box, `scrollTop` 0, header at `+9px`.

### Performance

| Fix | Effect |
|---|---|
| `SplitFlap` / `FlapCell` memoised | The minute tick walked **every character on screen** — hundreds of components — for output identical in all but a handful. |
| `flatten` + destination formatting split into their own memo | Re-walked and re-regexed every prediction once a minute for a result that could not have changed. |
| `Intl.DateTimeFormat` hoisted to module scope | One call site built a fresh formatter **every second**. |
| `LastUpdatedBadge` writes state only when the string changes | Was re-rendering an identical span 3,599 times an hour. |
| `useRowTransition` skips the settle timer when nothing entered | True on 59 of every 60 ticks. Also replaced an accumulating `timers` array with one scoped timeout. |
| `NetworkStatusPanel` indexes into a `Map` once | Was 19 linear scans over a 19-element array, twice per render. |
| **`drop-shadow` removed from `flap-in`** | A GPU blur **per character**; a board mid-refresh ran hundreds at once on a stick with no headroom for one. Brightness-only reads identically at six metres. |

### Maintainability

- **`time/london.ts`** is now the only place London time is derived. It had been
  re-implemented four times, each with its own formatter — four chances to
  disagree, and a board whose footer says 03:29 while its nightly reset thinks
  03:31 is a bug nobody will ever reproduce.
- **`config/assets.ts`** owns every image URL. Two kinds live here and confusing
  them is silent: the backend's artwork (absolute, **not** base-prefixed) and this
  app's own (`public/`, base-prefixed).
- **Dead code removed:** `useWallClock`, `config.pollMs` (its comment cited a
  hook that does not exist), `config.showUnassigned`, an unused function
  parameter, and a duplicated splash screen.
- **334 KB of duplicated icons deleted.** `web-temp/public/icons/` held
  byte-identical copies of the backend's, and the two components *disagreed about
  which to load* — a roundel change would have updated one and not the other.
  `dist/` went 618 KB → 284 KB.
- **`.gitignore` added** (`node_modules/`, `dist/`, `*.tsbuildinfo` were one
  `git add .` from being committed), plus `public/icons/lines/` at the repo root,
  which is a runtime cache the backend regenerates.
- **Five markdown files became this one.**

### For the remote

Zero `:focus` rules existed, so a D-pad moved focus invisibly and the only
control on screen could be reached solely by hunting with Silk's cursor. Added
`:focus-visible` rings, `autoFocus` on the fullscreen button (so "open the link,
press OK" is the whole setup), and `user-select: none` across the board — a stray
drag highlighting half a destination in blue is the sort of thing that sits on a
café wall for a week.

---

## 10. Open decisions

**`VenuePanel.tsx` is not rendered by anything.** 175 lines with `localStorage`
persistence and in-place editing; `NetworkStatusPanel` appears to have taken its
slot, and `config.venue` / `config.message` exist only for it. Either the next
feature to wire up or deletable — **left in place because deleting built work is
a product call.** Its one design note worth keeping: the edit control is hidden
until hover *on purpose*, because a permanently visible button on a public wall
display invites every customer to press the only interactive thing on screen.

**The kiosk socket carries no auth.** Sound *inside* the process; the extracted
service needs a real answer — a public unauthenticated station stream, or a
display token.

**`design/tokens.css` is the fourth copy of the TfL palette** (after
`TflLineColors.kt`, `Board.kt`, `lineIconService`). A line colour change touches
four files. Wants a shared contract or a generated palette.

**`api/types.ts` is mirrored by hand.** If the prediction shape changes upstream
nothing will tell you. Wants a client generated from `/openapi.json`.

**`/kiosk-api/snapshot` is unused** — the WebSocket replaced it. Kept as a
curl-able probe and labelled as such.

**`KioskGate`'s ask/denied screens were reconstructed** from `KioskGate.css`
after the file was truncated mid-edit. Logic is verified; the copy and layout of
those two cards are a reconstruction and worth an eyeball.

---

## 11. Extraction

```bash
git mv web-temp ../stationly-web     # becomes the new repo root as-is
rm ../src/tempWebHost.ts
# delete the two marked TEMP WEB HOST blocks in ../src/server.ts
# delete the three kiosk location blocks from server-config/nginx.*.conf
```

Then in the new repo:

1. `vite.config.ts`: `base: '/kiosk/'` → `'/'`
2. `src/main.tsx`: `basename="/kiosk"` → `"/"`
   *(these two and `MOUNT` in `tempWebHost.ts` were always the same string)*
3. `src/config/assets.ts`: point `ICON_BASE` at the backend's public origin —
   the reason that path is written down once instead of inline at each `<img>`
4. **The transport.** The kiosk talks to `/kiosk-stream` on a relative URL, so the
   extracted service needs its own proxy or a public station stream — and §10's
   socket-auth question must be answered for real.

Nothing else in `stationly-backend` knows this folder exists.
