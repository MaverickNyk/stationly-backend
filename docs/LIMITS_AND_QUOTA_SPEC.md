# SDUI Quota & Limits Specification

**Owner:** `src/services/sduiService.ts` → `getHomeConfig().strings`
**Consumer:** `StationlyUI` → `core/config/BoardPolicy` + `BoardQuota`
**Last revised:** 2026-09-01

---

## 1. Two limits, and there is no third

| # | Limit | Value | Counted in |
|---|---|---|---|
| 1 | Stations per user | `4` | distinct station hubs (`UserSelection.groupingId`) |
| 2 | Lines per station | `4` | distinct line ids on one station card |

Limit 1 is counted per **hub**, not per saved row, because the home screen draws
one card per hub. Two lines at King's Cross plus both directions at Victoria is
two stations, not four.

**Directions are not limited.** A line runs inbound and outbound and nothing
else, so limit 2 already bounds a station card at 8 rows on its own. A ceiling
counted in rows could only ever fire *before* the line limit — refusing three
lines with both ways ticked, a board limit 2 calls legal.

---

## 2. Schema

```jsonc
"limits.boards.max":             "4",
"limits.boards.reached.title":   "Station Limit Reached",
"limits.boards.reached.message": "You have used your full quota of 4 stations. Please delete an existing station to add a new one.",
"limits.boards.reached.cta":     "Got it",          // shared by BOTH modals

"limits.lines_per_board.max":    "4",
"limits.lines.reached.title":    "Line Limit Reached",
"limits.lines.reached.message":  "Maximum of 4 lines reached for this station. Untick a line to select another."
```

| Key | Clamp on client read |
|---|---|
| `limits.boards.max` | `1..12` |
| `limits.lines_per_board.max` | `1..10` |
| `*.title` | ≤ 60 chars |
| `*.message` | ≤ 300 chars |
| `*.cta` | ≤ 40 chars |

A blank served value is treated as **absent**, not as an empty string, so the
client falls back to its compiled default rather than rendering a blank modal.
Every key has such a default: a cold or offline launch enforces the same two
limits with the same copy, having never reached the network.

> **Naming.** `limits.boards.*` predates the vocabulary settling on "station".
> The key says boards, the concept is stations, and they are the same thing —
> one board per station hub. Not renamed: the key is the contract.

---

## 3. Removed: `limits.rows_per_board.*`

`limits.rows_per_board.max` (`"8"`) and `limits.rows.reached.message`
(`"Board full. Untick a direction to add another."`) are **deleted**, not left
dormant.

They are **currently live on staging** — this file was deployed from a dirty
tree, so `git log -S` finds no commit introducing them even though the server
serves them. The additive-only rule still does not apply: it protects keys a
*shipped* client reads, and no shipped client reads these. Android is frozen at
versionCode 2 and predates them; iOS has never been released and no longer reads
them. Staging is not "shipped".

They leave staging on the next deploy. Until then, staging serves two keys no
client reads — harmless, since an unread key costs only bytes.

`src/tests/run.ts` asserts both keys are `undefined`, so a re-add fails loudly.

---

## 4. Where each limit is enforced on the client

| Limit | Enforcement point | Why there |
|---|---|---|
| Stations | `SummaryViewModel.onAddBoardClicked` | Refuses the `+` *before* it becomes `navigate("selection")`. Once navigation runs the screen that hosts the modal is gone. |
| Stations | `SelectionViewModel.onDropdownSelected("station", …)` | The last point where refusing is free, before lines are picked. Runs before any state is mutated. |
| Stations | `SelectionViewModel.saveSelection` (post `repoReady.join()`) | The same question once the repository has settled; the last gate before rows reach SQL. |
| Lines | `toggleLine`, `toggleAllLines` | `toggleAllLines` fills **up to** the cap rather than refusing outright — a "Select all" that did nothing at a six-line interchange reads as a broken button. |

A station hub the user **already holds** always passes, or a user at the cap
could never edit the boards they have.

Refusal is stated twice: an error haptic, and the modal built from the `title` /
`message` / `cta` above.

---

## 5. Verification

```bash
npm test    # 210/210, incl. "LIMITS CONFIG: all limits.* keys are served …"

curl -s "$HOST/api/v1/sdui/app/home-config" \
  | jq '.strings | with_entries(select(.key | startswith("limits.")))'
```

Expect exactly the seven keys in §2 — and no `limits.rows_per_board.max`.
