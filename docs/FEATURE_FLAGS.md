# Feature flags

Every new feature gets a flag, **default off**, in `FEATURE_FLAGS`
(`src/services/featureFlagService.ts`). It is turned on and off from the admin
API, live, with no deploy or restart.

## Using it

```
GET /api/v1/admin/flags
PUT /api/v1/admin/flags
    { "set": { "stationStatus.show": { "android": true } }, "reason": "internal test", "by": "name", "push": true }
```

| Change | Meaning |
|---|---|
| `true` / `false` | every target of the flag |
| `{ "android": true }` | only that target |
| `null` | remove the override: back to the environment, then the default |

- An edit is all or nothing. `reason` is required; every edit is kept in
  `app_config/feature_flags/history`.
- `"push": true` also tells phones to refetch their config. Only app flags need it.
- Values: live (Firestore) beats environment (`FLAG_STATION_STATUS_SHOW=true`)
  beats default.
- It fails closed: unknown, unreadable or not exactly `true` is off. Losing
  Firestore keeps the last known values.

## How fast

| Target | On or off takes effect |
|---|---|
| `server` | Seconds, on every worker |
| `android`, `ios` | The app's next config fetch: a cold start (not every time it is opened), a background refetch (`notify.config.maxAgeMs`), or within minutes of a `push`. A phone that is off keeps its last value |

## Adding a feature

1. Add it to `FEATURE_FLAGS` with the targets that HAVE the feature. A target not
   listed cannot be turned on.
2. Server code: `FeatureFlagService.isOn('x.y')`.
   Apps: `flag.x.y` in home-config, "true" or "false" for the platform in
   `X-Stationly-Client` (or `?platform=`). Absent or anything else is off.
3. When it has proved itself, set `defaultOn`, and later delete the flag. Only
   delete an app flag when no supported app reads it.

## Flags

| Flag | Targets | What |
|---|---|---|
| `stationStatus.show` | android | The app shows station closures. It receives them either way: STATION_STATUS.md |

## Not here

Percentage rollouts (nothing needs one yet), and `notify.*`, which are settings
rather than features: see `notificationPolicyService.ts`.
