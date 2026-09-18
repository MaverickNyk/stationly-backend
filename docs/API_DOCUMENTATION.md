# API Reference (`/docs`) — Public Surface & Theming

> Audience: future agents / engineers working on `stationly-backend`. This is
> the canonical description of how the public OpenAPI reference at `/docs` is
> generated, what it exposes vs. hides, and how it is themed.
>
> Everything here is **documentation-only**. None of it changes routing,
> controllers, middleware, or auth — the live API is unaffected. Hidden
> endpoints still exist and still work; they are simply not advertised.

## TL;DR

- `swagger-jsdoc` scans `src/controllers/*` for `@swagger` JSDoc and builds the
  full spec (`swaggerSpec`).
- `buildPublicSpec()` produces a filtered **deep copy** (`publicSpec`) that
  strips internal / user-private operations.
- `publicSpec` is what we serve at **`GET /openapi.json`** and render at
  **`/docs`** via Scalar.
- Scalar is **pinned to dark mode** so `/docs` matches the stationly.co.uk site.

All of this lives in `src/server.ts` (search for `buildPublicSpec` / OpenAPI
Configuration).

## Pipeline

```
src/controllers/*.ts                 swagger-jsdoc            buildPublicSpec()
  @swagger JSDoc annotations  ──►  swaggerSpec (full)  ──►  publicSpec (filtered)
                                                                    │
                                          ┌─────────────────────────┤
                                          ▼                         ▼
                                  GET /openapi.json           /docs (Scalar, dark)
```

- **Source of truth:** `@swagger` blocks on controller methods. Annotations are
  intentionally **kept in code** even for hidden endpoints — they remain a
  contract for the in-house app team; they are just removed from what we
  *publish*.
- `swaggerOptions.apis` globs `./controllers/*.{ts,js}` only. Anything not in
  `src/controllers/` (e.g. `src/admin/*`) is never scanned, by design.
- ⚠️ **The scanner follows FILES, not routers.** "Admin routes live in
  `src/admin/`, so admin operations can't reach the spec" is **not** an
  invariant, and reading it as one is what caused the August 2026 leak: a
  handler in `src/controllers/` is scanned no matter which router mounts it.
  `DevicePushController.send`/`.status` are mounted on the admin router but live
  in `src/controllers/devicePushController.ts`, and their `@swagger` blocks
  published `/admin/device-push/*` straight onto `/docs`. Those two are plain
  JSDoc now.

## What is public vs. hidden

`buildPublicSpec()` **publishes** an operation only if **all three** hold:

1. it carries a public tag — `Stations`, `Modes`, or `Lines`; **and**
2. it carries no internal tag — `Users`, `User`, `SDUI`, `Auth`, `Theme`,
   `Waitlist`, `Widget Push`, `Admin`; **and**
3. its path does not start with `/user/`, `/auth/`, or
   `/stations/subscribed-ids`.

Rule 1 is an **allow-list**, and that direction matters more than its contents:
**anything new defaults to hidden.** Adding an endpoint can no longer leak it;
publishing one takes a deliberate act (tagging it as transport data).

Rule 2 is not redundant. An allow-list alone only asks *"is this transport
data?"*, never *"is this ALSO someone's private data?"* — so `[Stations, Users]`
would publish on the strength of `Stations`. That combination is not
hypothetical: `GET /stations/subscribed-ids` is a user-scoped, dev-tier endpoint
tagged `Stations`, held back today only by the hand-written path entry in rule
3. Tag it honestly as `[Stations, Users]` and rule 2 is what keeps it hidden.

Rule 3 then covers what tags cannot express. The three are deliberately
independent: leaking a private endpoint takes three simultaneous mistakes.

Result (verified): **32 paths / 33 operations → 8 paths / 8 operations.**

> **This used to be a deny-list** (`INTERNAL_TAGS` = `Users`/`SDUI`/`Auth`/
> `Theme`/`Waitlist`) and it failed open — it could only hide the categories it
> had been told about when it was written. In August 2026 the widget-push work
> added two tags it had never heard of, `Widget Push` and `Admin`, and four
> operations published themselves with nobody making a mistake:
> `POST /device/register`, `POST /device/unregister`,
> `POST /admin/device-push/send`, `GET /admin/device-push/status`. The last two
> advertised an **admin** endpoint to third-party developers. The allow-list is
> the fix for the class, not just those four.

### Public (kept in `/docs`)

| Group | Endpoints |
|---|---|
| Modes | `GET /modes` |
| Lines | `GET /lines/mode/{mode}`, `GET /lines/status`, `GET /lines/{lineId}/route` |
| Stations | `GET /stations/line/{lineId}`, `/search`, `/resolve`, `/predictions/{naptanId}` |

That's it — **the public reference is the transport-data product only** (Modes,
Lines, Stations). Tags published: `Stations`, `Modes`, `Lines`.

> `/stations/nearby` shares the `searchStations` handler with `/stations/search`
> but has no `@swagger` block of its own, so it was never in the spec.

### Hidden (still live, not advertised)

Complete as of 2026-09-10 and generated from the spec rather than hand-listed.
After any change, re-derive it with the `curl` command under **How to verify**
instead of trusting this table — a stale table asserting a false invariant is
what let the leak below sit unnoticed for a month.

| Reason | Endpoints |
|---|---|
| Tagged `Users` (10) | `GET`+`POST /user/sync/profile`, `POST /user/sync/stations`, `POST /user/sync/boards`, `POST /user/activity/batch`, `POST /user/stations/add`, `POST /user/stations/delete`, `POST /user/logout`, `POST /user/fcm/register`, `POST /user/fcm/unregister` |
| Tagged `User` — singular, see edge cases (1) | `GET /user/state/rev` |
| Tagged `SDUI` (5) | `GET /sdui/app/{layout,widget-guide,refresh-policy,release-policy,support-money-config}` |
| Tagged `SDUI`+`Auth` (3) | `GET /sdui/app/{login,register,forgot-password}` |
| Tagged `SDUI`+`Theme` (1) | `GET /sdui/app/theme-tokens` |
| Tagged `SDUI`+`Users` (1) | `GET /sdui/app/profile/{uid}` |
| Tagged `Waitlist` (1) | `POST /waitlist/join` |
| Tagged `Widget Push` (2) | `POST /device/register`, `POST /device/unregister` |
| Dev-tier — tagged `Stations`, hidden by path (1) | `GET /stations/subscribed-ids` |
| Never annotated at all | `POST /auth/forgot-password`, `POST /user/send-verification-email`, `GET /sdui/app/{about,home-announcement,home-config}`, `GET /api/v1/support-money/return` |
| Admin key required; handlers deliberately carry no `@swagger` | all of `/api/v1/admin/*`, incl. `/admin/device-push/{send,status}` |

**Why hide everything except transport data?** A third-party developer holding
an `X-Stationly-Key` can only ever use the transport endpoints. Everything else
is app/website-internal plumbing they can't action:

- **`/user/*`** require a Firebase ID token tied to Stationly's own auth, and
  documenting them just leaks internal mechanics (sync/checkpoint semantics, FCM
  registry, account deletion, profile shape).
- **SDUI / Auth / Theme** endpoints return Server-Driven UI layouts and theme
  tokens shaped for the Stationly app's own renderer — useless externally and a
  leak of the internal UI schema.
- **Waitlist** is the marketing site's launch-signup form, not a developer API.
- **`/device/*`** (tag `Widget Push`) register APNs tokens against
  `users/{uid}/devices/{deviceId}`. They require a Firebase bearer and answer
  `401 no_session` without one, so a key-only third party can never call them;
  documenting them just publishes the device/session model.
- **`/admin/*`** require `X-Stationly-Admin-Key`, a different trust class
  entirely. These must never appear in the public reference — see the leak note
  above.

### Deliberate edge cases

- **`GET /stations/subscribed-ids` is hidden by path.** It is tagged `Stations`
  (dev-tier) and carries no internal tag, so rules 1 and 2 both pass it — only
  the `INTERNAL_PREFIXES` entry holds it back. It is the single endpoint relying
  on rule 3 alone. If you ever retag it `[Stations, Users]`, rule 2 catches it
  and the path entry becomes the belt to that braces.
- **Untagged operations are dropped.** An `@swagger` block with no `tags:` fails
  rule 1 and is hidden rather than published — fail closed.
- The `/auth/*` + `/user/*` **path** guards are redundant today (nothing there
  is publicly tagged) and are kept deliberately as an independent third guard.
- **`GET /user/state/rev` is tagged `User`, singular** — not `Users`. Under the
  old deny-list that typo was invisible only because the `/user/` path prefix
  caught it; a `User`-tagged route mounted anywhere else would have leaked. It
  is harmless now (rule 1 hides it, and `User` is listed in `INTERNAL_TAGS`
  precisely so the typo stays caught), but it is still a typo — fix it if you
  are in there, and drop `User` from `INTERNAL_TAGS` in the same commit.

## `buildPublicSpec()` — how it works

Operates on a deep copy of `swaggerSpec` (the original is never mutated). Three
passes:

1. **Keep only allow-listed operations.** For each path, delete any method that
   misses `PUBLIC_TAGS` (methods with no tags at all included), hits
   `INTERNAL_TAGS`, or whose route hits an `INTERNAL_PREFIXES` entry. If a path
   has no methods left, delete the path.
2. **Prune orphaned schemas.** Walk `$ref`s reachable from the surviving paths
   *transitively* (so schemas shared by a kept endpoint survive) and drop any
   `components.schemas` entry nothing references. This stops hidden-only models
   (e.g. `UserProfile`, `UserSyncRequest`, `Layout`) from lingering in Scalar's
   Models list.
3. **Prune tags.** Keep only `tags` still used by a visible operation — this
   drops the now-empty `Users`/`SDUI`/`Auth` entries declared in
   `swaggerOptions`, leaving `Stations`, `Modes`, `Lines`.

To change the policy, edit `PUBLIC_TAGS` / `INTERNAL_TAGS` / `INTERNAL_PREFIXES`
at the top of the function in `src/server.ts`. Adding a tag to `PUBLIC_TAGS` is a
**publishing decision**: it puts every operation carrying that tag in front of
third-party developers, including ones added later by someone who never read
this file. Check the whole tag, not just the endpoint that prompted it. Adding
one to `INTERNAL_TAGS` is always safe — it can only hide.

## Theming (forced dark)

The Scalar `/docs` handler is pinned to dark so it matches the
stationly.co.uk page theme:

```ts
apiReference({
  spec: { content: publicSpec },
  theme: 'default',
  darkMode: true,
  forceDarkModeState: 'dark', // overrides the visitor's OS/browser preference
  hideDarkModeToggle: true,   // remove the toggle so it can't be flipped to light
})
```

- `forceDarkModeState: 'dark'` pins the colour scheme regardless of the
  visitor's system setting.
- `hideDarkModeToggle: true` removes the light/dark switch entirely.
- (`darkMode: true` sets the initial state; the `force…` option is what makes it
  sticky.)

Config keys verified against `@scalar/express-api-reference@0.9.0` /
`@scalar/types`.

## How to verify

- `npx tsc --noEmit` — type-checks the filter + Scalar config.
- Boot the server (`npm run dev`) and open `http://localhost:<port>/docs` —
  should render dark, showing only the `Stations`, `Modes`, and `Lines` groups.
- `GET /openapi.json` — should contain only the 8 public transport paths above.
  Against a running server:

  ```sh
  curl -s localhost:<port>/openapi.json | jq -r '.paths | keys[]'   # expect 8, all transport
  curl -s localhost:<port>/openapi.json | grep -Ei 'admin|device|user|sdui|waitlist'   # expect no output
  ```

## Invariants — don't break these

- **Never** annotate an admin handler with `@swagger`/`@openapi` — wherever the
  file lives. Living outside the controller glob is a *convenience*, not the
  guarantee; a shared controller in `src/controllers/` mounted on the admin
  router is scanned like any other, which is precisely how
  `/admin/device-push/*` leaked. The allow-list now catches this too, so it
  takes two independent mistakes to publish an admin route — keep it that way.
- **Keep the allow-list as the PRIMARY gate.** `INTERNAL_TAGS` is an override
  layered on top, not the thing doing the work. The distinction matters: a
  deny-list asked to carry the load hides the categories you thought of and
  nothing you didn't, which is precisely how four operations published
  themselves in August. If you are tempted to hide something new by adding it to
  `INTERNAL_TAGS`, check first why rule 1 let it through — usually the honest
  answer is that it should not have been tagged `Stations`/`Modes`/`Lines`.
- `buildPublicSpec()` is publish-only — don't feed `publicSpec` back into
  routing or anything that affects request handling.
- If you expose a genuinely new **public** developer endpoint, tag it
  `Stations`/`Modes`/`Lines` and keep its path out of `INTERNAL_PREFIXES`.
  Anything else is hidden by default — that is intended, not a bug to work
  around.
