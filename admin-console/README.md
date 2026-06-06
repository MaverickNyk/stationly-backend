# Stationly Admin Console

Internal Next.js console for the backend admin API. Phase 1 ships the
**notification composer**: build a push, pick the audience, preview how it
lands on a device, and send — to **Local / Staging / Prod** from one switcher.

## Security model (three independent layers)

1. **Cloudflare Access** — the real perimeter. Host this app on
   `admin.stationly.co.uk` behind a Zero Trust self-hosted app restricted to
   your team. (Set up separately in the Cloudflare dashboard.)
2. **App login** — a shared-password session cookie (`ADMIN_PASSWORD` +
   signed `SESSION_SECRET`). Second factor on top of Access.
3. **Server-side key proxy** — the per-env admin keys + Cloudflare service
   tokens live in this server's env and are attached in
   `app/api/admin/notifications/route.ts` → `lib/backend.ts`. **They never
   reach the browser.** The browser only ever names a target env.

## Environments

The console targets **one** environment, fixed by the deployment via
`STATIONLY_ENV` (`local` | `staging` | `production`). There is **no env
switcher** — a staging deployment auto-routes to staging, prod to prod. URLs
mirror `StationlyUI/core/.../config/AppConfig.kt`:

| Env     | Default base URL                          | Banner |
|---------|-------------------------------------------|--------|
| Local   | `http://localhost:3000`                   | blue "LOCAL DEV" |
| Staging | `https://staging-api.stationly.co.uk`     | orange "⚠ STAGING ENVIRONMENT" |
| Prod    | `https://api.stationly.co.uk`             | none (clean) |

Each env has its **own** `*_ADMIN_KEY` (and optional CF service token); only the
one matching `STATIONLY_ENV` is used. The target env is resolved **server-side**
in every proxy (`activeEnv()`), never chosen by the browser. Production sends —
and any broadcast (`all`/`line`/`topic`) — still require a confirm dialog.

## Read/write budget (Firestore)

The data views are built to keep Firestore I/O minimal:
- **Dashboard, Subscribed stations** — 0 reads (in-memory + SQLite only).
- **Users, Waitlist** — 0 reads on normal load (served from the local SQLite
  snapshot); the **Refresh** button does exactly one collection read and
  re-caches.
- **Audience lookup, `uid` sends** — cache-first (5-min TTL per uid).
- **History** — local SQLite audit log, 0 Firestore ops.

## Run locally

```bash
cd admin-console
cp .env.local.example .env.local   # fill ADMIN_PASSWORD, SESSION_SECRET, *_ADMIN_KEY
npm install
npm run dev                        # http://localhost:4000
```

To exercise it end-to-end against the local backend, run the backend
(`npm run dev` in the repo root) with `STATIONLY_ADMIN_KEY` set, and put the
same value in `LOCAL_ADMIN_KEY` here.

## Deploy

Host on its own subdomain behind Cloudflare Access. Set the env vars
(`ADMIN_PASSWORD`, `SESSION_SECRET`, `STAGING_ADMIN_KEY`, `PROD_ADMIN_KEY`,
and the `*_CF_ACCESS_*` service tokens once the backend admin path is gated).

## Screens

- **Notifications** (`/notifications`) — composer + live device preview.
- **Audiences** (`/audiences`) — UID → registered-device count (count only,
  never raw tokens). Backend reads are cache-first (5-min in-memory TTL in
  `UserFcmTokenService`), so repeat lookups cost zero Firestore reads.
- **History** (`/history`) — recent sends per environment. Persisted to each
  backend's **local SQLite** audit log (`admin_notifications` table) — zero
  Firestore reads/writes. Raw tokens are never stored.

## Read/write budget (by design)

All admin features are built to keep Firestore I/O minimal:
- Audience lookups + `uid` sends share a TTL cache → ~1 read per uid per 5 min.
- Send history is local-only SQLite → 0 Firestore ops.
- `all` / `line` / `topic` audiences are 0-read broadcasts (FCM fans out).

## Roadmap (future)

- History is per-instance (local SQLite). If you later need a unified,
  cross-instance audit trail, mirror inserts to a Firestore `admin_notifications`
  collection (1 write/send) and read from there — at the cost of Firestore I/O.
