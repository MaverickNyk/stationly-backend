import { DataCacheService } from '../dataCacheService';
import { UNASSIGNED_PLATFORM_LABEL } from '../../utils/formatters';

/**
 * Filtering and direction-resolution rules shared by EVERY prediction
 * source. A train must be dropped (or bucketed) by the same rule no matter
 * which TfL product it was read from — otherwise switching a station
 * between sources would change what the user sees for reasons unrelated
 * to data quality. New sources (e.g. national-rail) must reuse these.
 */

// TfL's expectedArrival is computed from a prediction snapshot that can lag
// ~40-60s behind real time, so an approaching train routinely shows an
// expectedArrival slightly in the past while its timeToStation is still
// positive. 2 minutes is safely beyond that skew: anything older is a
// genuinely departed train TfL hasn't expired yet, not a live one.
// Must stay in lockstep with StationlySyncer's DataTransformationService.
export const DEPARTED_CUTOFF_MS = 2 * 60_000;

export function isLongDeparted(eta: string): boolean {
    if (!eta) return false;
    const etaMs = new Date(eta).getTime();
    return Number.isFinite(etaMs) && etaMs < Date.now() - DEPARTED_CUTOFF_MS;
}

// TfL only assigns platforms ~5–15 min before departure for these modes;
// far-future unplatformed predictions from them are noise, not real board data.
const LATE_PLATFORM_MODES = new Set(['overground', 'dlr', 'elizabeth-line']);

/** `platform` is the formatPlatform() output, not the raw TfL string.
 *  `modeName` is matched case-insensitively. */
export function isFarFutureUnassigned(modeName: string, platform: string, eta: string): boolean {
    if (!LATE_PLATFORM_MODES.has(modeName.toLowerCase())) return false;
    if (platform !== UNASSIGNED_PLATFORM_LABEL) return false;
    const etaMin = (new Date(eta).getTime() - Date.now()) / 60_000;
    return etaMin > 20;
}

/**
 * Strip TfL's station-name suffixes for board display ("Ealing Broadway
 * Underground Station" → "Ealing Broadway"). Shared by every prediction
 * source so the same destination never renders two different ways
 * depending on which TfL product it came from.
 */
export function cleanDestinationName(raw: string): string {
    return (raw || '')
        .replace(/ Underground Station/g, '')
        .replace(/ Station/g, '')
        .replace(/ DLR/g, '')
        .trim();
}

/**
 * At a terminus, the direction a train DEPARTS in is the one whose route
 * destinations do NOT include this station (trains leave towards the other
 * end of the line). Returns null when ambiguous (e.g. mid-line short
 * workings, loops, or no cached route) so callers can fall back.
 */
export function resolveDepartingDirection(naptanId: string, lineId: string): string | null {
    const route = DataCacheService.getRoute(lineId);
    const dirs: any[] = route?.directions || [];
    const away = dirs.filter(d =>
        !(d.destinations || []).some((dest: any) => dest.id === naptanId));
    return away.length === 1 ? (away[0].direction || null) : null;
}

/**
 * Resolve direction from the cached route definition: the direction whose
 * destination list contains this train's destination. Returns '' when
 * ambiguous (destination reachable both ways, mid-line short workings not
 * listed as a route terminus, or route not cached).
 */
export function resolveDirectionTowards(lineId: string, destinationNaptanId?: string): string {
    if (!destinationNaptanId) return '';
    const dirs: any[] = DataCacheService.getRoute(lineId)?.directions || [];
    const matching = dirs.filter(d =>
        (d.destinations || []).some((dest: any) => dest.id === destinationNaptanId));
    return matching.length === 1 ? (matching[0].direction || '') : '';
}
