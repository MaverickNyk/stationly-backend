# Admin — Agent context

Server-side admin tooling that's intentionally **off the public API**
surface. Everything in this folder is:

- Gated by a **separate auth key** (`X-Stationly-Admin-Key`), not the
  client `X-Stationly-Key` rotated calendrically across user devices
- **Excluded from the OpenAPI schema** — no `@swagger` JSDoc on any
  handler in this folder, so the generated `/docs` spec walker
  doesn't surface these endpoints to scanners
- **Mounted at `/api/v1/admin/*`** (not `/admin/*`) because the
  staging/production nginx only forwards `/api/v1/*` to Node

## File layout

```
src/admin/
├── adminAuthMiddleware.ts   Constant-time admin key check.
│                            Reads STATIONLY_ADMIN_KEY env var.
│                            Refuses 503 if env unset (fail-shut).
├── adminRoutes.ts           Mounted router. Installs the auth
│                            middleware once at the router level so
│                            every route under /api/v1/admin/* is
│                            gated.
├── notificationController.ts  POST /api/v1/admin/notifications/send
├── notificationService.ts     Audience fan-out (token / tokens /
│                              topic / uid / uids / all / line),
│                              payload validation, FCM dispatch.
└── CLAUDE.md                  This file.
```

External integration points:
- `src/server.ts` mounts `app.use('/api/v1/admin', adminRoutes)`
  **before** `app.use('/api/v1', apiRoutes)` so the admin path is
  reached before the client `X-Stationly-Key` middleware fires
- `src/services/userFcmTokenService.ts` is the per-uid token registry
  the `uid` / `uids` audiences resolve against
- `src/config/firebase.ts` provides the `messaging` instance for FCM

## The notification framework

All push notifications — status changes, marketing pushes, system
notices — flow through `NotificationService.send(audience, payload)`.
One shape, seven audience types, one FCM call.

### Payload shape (`NotificationPayload`)
Mirrors the Kotlin `NotificationPayload` data class at
`StationlyUI/core/src/.../model/notification/NotificationPayload.kt`.
The two sides MUST stay in lockstep — adding a field on one without
the other is the easiest way to silently drop UX.

Key fields:
- `type` — routing key (`line_status_change`, `announcement`,
  `system`, `promo`). Drives channel + default colour on the client.
- `title`, `body` — required text
- `severity` — `"danger"` / `"warning"` / `"success"` / `"info"` /
  `"neutral"`. Drives a coloured emoji glyph prefix in the title on
  the client. Auto-derived from `newStatus` for status-change pushes
  if the caller doesn't set it.
- `color`, `imageUrl`, `largeIconUrl` — visual overrides
- `deepLink`, `actions` — interaction
- `lineId`, `lineName`, `previousStatus`, `newStatus` — status-change
  extras

### Wire format
Posted to FCM as a `data` message with a single field:
```
notification_payload: <JSON string of the full payload>
```
The Android `FcmMessagingService.dispatchRemoteNotification` picks up
that field and hands it to `NotificationDispatcher`. Same dispatch
path the client-side status-change auto-notifications use — so
admin-driven pushes get the same theming / channel / deep-link
treatment for free.

**Why `data` and not FCM's `notification` field?** FCM `notification`
payloads are auto-handled by the system when the app is backgrounded,
bypassing our code path entirely — so we couldn't customise channel /
colour / actions / grouping. `data` payloads always hit
`onMessageReceived`, giving full control.

### Audience types

| `audience.type` | What it does | Firestore reads |
|---|---|---|
| `token` | Single FCM token (testing on your own device) | 0 |
| `tokens` | Up to 500 tokens (FCM multicast cap) | 0 |
| `topic` | Any FCM topic (e.g. `LineStatus_piccadilly`) | 0 |
| `uid` | Firebase user id → resolves to that user's registered tokens | 1 subcollection query |
| `uids` | Batch of UIDs — fans out reads per-UID then multicasts | N queries (small admin sets only) |
| `all` | Everyone via the `stationly_all` FCM topic the app auto-subscribes to | 0 |
| `line` | Everyone subscribed to `LineStatus_<id>` (the Syncer's existing topic) | 0 |

`all` and `line` are zero-read broadcasts — FCM handles fan-out at
delivery time. `uid` / `uids` cost reads proportional to the
audience size and are intended for targeted ops (e.g. "tell this user
their email is verified", "ping these 5 beta testers about the new
build").

### Server-side enrichment (`enrichPayload`)

The service applies defaults so the admin caller doesn't have to
spell out every field:
- If `newStatus` is set and `severity` isn't → derive `severity` via
  `severityFromStatus` (Good Service → success, Severe Delays →
  danger, etc.)
- If `lineId` is set and `color` isn't → look up the TfL line colour
  from the embedded palette

Caller-supplied values always win. We do NOT auto-fill `largeIconUrl`
from `lineId` anymore — the line-coloured roundel competed with the
Stationly small icon visually; the line is conveyed in the title
text + severity glyph.

## Auth model

`AdminAuthMiddleware.validate` checks `X-Stationly-Admin-Key` against
`STATIONLY_ADMIN_KEY` env. Three responses:

- **503 Service Unavailable** — env var unset or shorter than 16
  chars (misconfiguration; fail-shut not fail-open)
- **401 Unauthorized** — header missing
- **403 Forbidden** — header present but wrong key

The compare uses `crypto.timingSafeEqual` to avoid byte-by-byte
timing attacks. The length-mismatch branch still runs a sized compare
so timing stays flat across both short-key and full-length-but-wrong
attempts.

### Why a separate key from `X-Stationly-Key`?
- Client keys live in many production apps + are rotated on a
  calendar; they're not designed to gate destructive operations
- Admin keys are single-issuer, kept off OpenAPI docs, revoke-able
  without touching client traffic
- Layered defence: a leaked client key cannot fan-out push
  notifications

### Rotation
Set `STATIONLY_ADMIN_KEY` in the backend `.env`. Keep it long (32+
chars), random. Rotate periodically by deploying a new value;
existing client devices are unaffected (they don't use this key).

## How to send a test notification

```bash
KEY=$(grep STATIONLY_ADMIN_KEY .env | cut -d'"' -f2)

curl -X POST https://staging-api.stationly.co.uk/api/v1/admin/notifications/send \
  -H "Content-Type: application/json" \
  -H "X-Stationly-Admin-Key: $KEY" \
  -d '{
    "audience": { "type": "uid", "value": "FIREBASE_UID_HERE" },
    "payload": {
      "type": "line_status_change",
      "title": "Piccadilly · Severe Delays",
      "body": "Signal failure between Acton Town and Heathrow.",
      "severity": "danger",
      "lineId": "piccadilly",
      "deepLink": "stationly://home"
    }
  }'
```

For broadcasts to all users:
```json
{ "audience": { "type": "all" }, "payload": { ... } }
```

For all Piccadilly subscribers:
```json
{ "audience": { "type": "line", "value": "piccadilly" }, "payload": { ... } }
```

## Architectural invariants (do not break)

**1. No `@swagger` annotations on admin handlers.**
The spec scanner walks `apiRoutes.ts` today but a future scanner
change could pick this folder up too. Keep admin handlers free of
swagger comments as defence-in-depth.

**2. Mount order in `server.ts`: admin BEFORE apiRoutes.**
`apiRoutes.ts` installs `validateApiKey` as a router-level middleware.
If admin were mounted under `/api/v1/admin` AFTER `/api/v1`, the
request would hit the client key check and bounce with `Missing
'X-Stationly-Key'` before reaching admin auth.

**3. Audiences must be additive, never replacing.**
Adding a new audience type to the discriminated union is safe.
Repurposing an existing one (e.g. changing `uid` to mean something
else) breaks the wire format that admin tooling depends on.

**4. Payload validation runs BEFORE FCM call.**
`validatePayload` catches malformed colour hex, oversized action
lists, non-HTTPS image URLs etc. Don't push validation down into the
FCM error path — by the time FCM rejects, we've already paid for the
API call and the per-token failure reasons are less helpful.

**5. Sensitive identifiers stay out of `SendResult.failures`.**
Token strings are NEVER echoed back in failure details — only FCM
error codes. The admin endpoint is privileged but its response
content can flow into logs/dashboards; tokens should not.

## Future audiences worth considering

- **`segment`** — slice of users matching a Firestore query (e.g.
  "all users who selected the Piccadilly line"). Cheaper than
  enumerating UIDs if the segment is big.
- **`scheduled`** — payload + send-at timestamp; queue for delivery.
  Would need a scheduler component, currently out of scope.
- **`silent`** — `data`-only push with no rendering, used to trigger
  a client-side action (e.g. invalidate a cache). Already possible
  via the existing `data` channel; just hasn't been formalised.

## When you change something here

After modifying any file in this folder, run `graphify update .` from
the repo root to keep the project's knowledge graph in sync. The
graph at `graphify-out/` is what future agents read for architecture
context.
