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

## What is public vs. hidden

`buildPublicSpec()` hides an operation if **either**:

1. it is tagged with an internal tag — `Users`, `SDUI`, `Auth`, `Theme`, or
   `Waitlist`, **or**
2. its path starts with `/user/`, `/auth/`, or `/stations/subscribed-ids`.

Result (verified): **23 → 8 public paths.**

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

| Reason | Endpoints |
|---|---|
| Tagged `Users` / under `/user/*` | `GET`+`POST /user/sync/profile`, `POST /user/sync/stations`, `/user/stations/add`, `/user/stations/delete`, `/user/logout`, `/user/fcm/register`, `/user/fcm/unregister`, `GET /sdui/app/profile/{uid}` |
| Tagged `SDUI` / `Auth` (app layouts) | `GET /sdui/app/{login,register,forgot-password,layout}` |
| Tagged `Theme` | `GET /sdui/app/theme-tokens` |
| Tagged `Waitlist` | `POST /waitlist/join` |
| Dev-tier, under `/stations/subscribed-ids` prefix | `GET /stations/subscribed-ids` |
| Never annotated (also covered by `/auth/*`, `/user/*` guards) | `POST /auth/forgot-password`, `POST /user/send-verification-email`, `GET /sdui/app/{about,home-announcement,home-config}` |
| Separate `src/admin/` module, never scanned | `/api/v1/admin/*` |

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

### Deliberate edge cases

- **`GET /stations/subscribed-ids` is hidden by path.** It is tagged `Stations`
  (dev-tier), not by an internal tag, so it's listed explicitly in
  `INTERNAL_PREFIXES` rather than caught by `INTERNAL_TAGS`.
- The `/auth/*` + `/user/*` **path** guards mean future endpoints added there
  stay hidden even if someone later decorates them with `@swagger`. Likewise any
  new endpoint tagged `SDUI`/`Auth`/`Theme`/`Waitlist` is hidden automatically.

## `buildPublicSpec()` — how it works

Operates on a deep copy of `swaggerSpec` (the original is never mutated). Three
passes:

1. **Drop internal operations.** For each path, delete any method whose tags hit
   `INTERNAL_TAGS` or whose route hits an `INTERNAL_PREFIXES` entry. If a path
   has no methods left, delete the path.
2. **Prune orphaned schemas.** Walk `$ref`s reachable from the surviving paths
   *transitively* (so schemas shared by a kept endpoint survive) and drop any
   `components.schemas` entry nothing references. This stops hidden-only models
   (e.g. `UserProfile`, `UserSyncRequest`, `Layout`) from lingering in Scalar's
   Models list.
3. **Prune tags.** Keep only `tags` still used by a visible operation — this
   drops the now-empty `Users`/`SDUI`/`Auth`/`Theme`/`Waitlist` tags, leaving
   `Stations`, `Modes`, `Lines`.

To change the policy, edit `INTERNAL_TAGS` / `INTERNAL_PREFIXES` at the top of
the function in `src/server.ts`.

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

## Invariants — don't break these

- **Never** add `@swagger`/`@openapi` JSDoc to `src/admin/*`. Admin stays out of
  the spec by living outside the controller glob.
- `buildPublicSpec()` is publish-only — don't feed `publicSpec` back into
  routing or anything that affects request handling.
- If you expose a genuinely new **public** developer endpoint, make sure its
  path isn't under an `INTERNAL_PREFIXES` entry and it isn't tagged with an
  `INTERNAL_TAGS` entry (`Users`/`SDUI`/`Auth`/`Theme`/`Waitlist`), or it won't
  show up in `/docs`. Tag it `Stations`/`Modes`/`Lines` (or add a new public
  tag).
