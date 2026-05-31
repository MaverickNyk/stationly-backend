# Platform formatting — backend contract (read before editing `formatPlatform`)

The **platform label is backend-owned** and the client displays it verbatim (no
client-side derivation). Two producers must stay in **lockstep**:

| Producer | File | Function |
|---|---|---|
| REST (initial/fallback) | `src/utils/formatters.ts` | `formatPlatform(mode, platform)` |
| FCM live (the **Syncer**, separate repo) | `StationlySyncer/.../service/DataTransformationService.java` | `getPresentablePlatform(mode, rawPlatform)` |

Output contract (identical in both):
- Bus, stop assigned → `"Stop C"`
- **Bus, no stop → `""` (empty)** — the client renders just the line name, not a
  confusing "Stop not assigned".
- Rail/tube, platform present → `"Platform 8"` / `"Platform 1 (Eastbound)"`
- Rail/tube, no platform → `"Platform not assigned"`
- Normalise TfL noise: `""`, `"null"`, `"unknown"`, `"platform unknown"`, `"no platform"`.
- Far-future unassigned rail (overground/dlr/elizabeth) is filtered out before it enters
  the response (`isFarFutureUnassigned`) — see the platform-noise fix.

**Rule:** any change here MUST be mirrored in the Syncer's `getPresentablePlatform`, or
live (FCM) and initial (REST) boards will disagree. To change a label's wording/format,
edit both + redeploy — the client needs no release (pure passthrough).

Full end-to-end picture (incl. client render helper `platformHeaderText` and the
"Line: platform" → "Line" empty rule): `StationlyUI/docs/PLATFORM_DISPLAY.md`.
