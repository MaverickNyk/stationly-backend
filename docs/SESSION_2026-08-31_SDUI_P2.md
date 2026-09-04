# SDUI Phase 2 & Operational Thresholds Handover (Backend)

**Date:** 2026-08-31  
**Status:** Code-complete, tested, staging-deployed, verified  
**Branches:** `stationly-backend` on `dev_13Jul`, `StationlyUI` on `ios-parity`

---

## 1. Executive Summary

This session completed **SDUI Phase 2 (TfL Line & Mode Palette Consolidation)** and added the **Six Tunable Operational Thresholds** to the `home-config` SDUI endpoint.

### What Was Consolidated
- **Single Source of Truth:** `LinePaletteService` (`src/services/linePaletteService.ts`) defines the authoritative TfL brand colours (21 lines), per-theme legibility overrides (9 dark, 3 light), transport mode roundel tints (8 modes), and default mode fallback.
- **Contract Tests:** `src/tests/run.ts` asserts that `LinePaletteService` and `LineIconService` match 100% on brand hex across all 21 lines, and that `homeConfigKeys()` generates 42 well-formed `#RRGGBB` keys.
- **Tunable Operational Thresholds:** Added 6 configuration keys to `getHomeConfig()` for client-side timing and caching parameters.

---

## 2. Served Keys Added to `getHomeConfig()`

### A. Palette Keys (42 keys via `LinePaletteService.homeConfigKeys()`)
- `line.color.<id>` (21 brand colours)
- `line.color.dark.<id>` (9 dark theme overrides)
- `line.color.light.<id>` (3 light theme overrides)
- `mode.color.<id>` (8 transport mode tints)
- `mode.color.default` (`#DC241F`)

### B. Operational Threshold Keys (6 keys)
| Key | Seeded Value | Description |
|---|---|---|
| `board.hero.urgency_min` | `"1"` | Minutes displayed <= this triggers hero urgent state |
| `selection.dropdown.cache_ttl_ms` | `"86400000"` | 24h dropdown options cache TTL |
| `station.route_text.max_age_ms` | `"1209600000"` | 14d route text cache freshness before re-resolve |
| `support.fetch.min_interval_ms` | `"60000"` | 60s min interval between supporter status fetches |
| `explore.fares.max_days_to_peak` | `"14"` | 14d max forward walk for next peak fare window |
| `weather.refresh_interval_ms` | `"1800000"` | 30 min weather station poll interval |

---

## 3. Production Android Non-Regression Audit

- **Additive Payload Guarantee:** All added keys are strictly additive under `strings`. Android parses `home-config` safely and ignores unknown keys.
- **No Schema Breaking Changes:** Endpoint route, HTTP methods, headers, and status codes are unchanged.

---

## 4. Verification Matrix

| Check | Result | Details |
|---|---|---|
| `npm test` | **182/182 PASSED** | Line palette equality & key generation verified |
| `npx tsc --noEmit` | **CLEAN** | 0 TypeScript compilation errors |
| Staging Deployment | **DEPLOYED** | Live at `https://staging-api.stationly.co.uk` (serving 287 string keys) |
