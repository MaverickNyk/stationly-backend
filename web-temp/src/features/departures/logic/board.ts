/**
 * Turning one station payload into the rows a board draws.
 *
 * Ported from `PredictionTicker.tickPredictions` / `bumpPlatformGroup` plus the
 * platform grouping the phone board and the widget share. The grouping key is
 * the PLATFORM, on every surface - see `BOARD_AND_DREAM_UI.md` §11 ("legs group
 * on the same key the board groups on, so a leg can never name a platform the
 * open board would not show").
 */

import type { StationPredictionResponse } from '../../../api/types';
import {
    DEPARTED_GRACE_MS,
    arrivalSortKey,
    formatDestination,
    formatEta,
    parseTargetMs,
} from './eta';

export interface DepartureRow {
    lineId: string;
    lineName: string;
    direction: string;
    /** Backend-owned, displayed verbatim. */
    platform: string;
    destination: string;
    targetMs: number | null;
    /** The label this row SHOWS - already bumped. Never parse it back. */
    eta: string;
    /**
     * The bumped ETA in whole minutes; 0 is "Due", null is "we could not
     * compute one". This is the NUMBER behind `eta`, carried alongside it so no
     * consumer ever has to read the label back to recover it - which is the
     * rule `eta.ts` states and which the hero card was quietly breaking.
     */
    etaMinutes: number | null;
    isDue: boolean;
}

export interface PlatformGroup {
    /** The platform string, verbatim from the backend - the group identity. */
    platform: string;
    /** "Mildmay: Platform 1" - `StationlyFormatters.platformHeaderText`. */
    header: string;
    rows: DepartureRow[];
}

/** The block header. An unassigned platform names itself rather than rendering
 *  a blank heading. (The line-prefix parameter this used to take was never
 *  read - a kiosk shows one station and the pills above already name the
 *  lines - so it is gone rather than left as a lie in the signature.) */
export function platformHeaderText(platform: string): string {
    const p = platform.trim();
    if (!p || isUnassigned(p)) return 'Platform not assigned';
    return p;
}

/** Flatten the nested line → direction → preds payload into rows. */
export function flatten(station: StationPredictionResponse): DepartureRow[] {
    const rows: DepartureRow[] = [];
    for (const line of Object.values(station.lines ?? {})) {
        for (const [direction, dir] of Object.entries(line.dirs ?? {})) {
            for (const p of dir.preds ?? []) {
                const rawPlat = (p.platform ?? '').trim();
                const platform = isUnassigned(rawPlat) ? 'Platform not assigned' : rawPlat;
                rows.push({
                    lineId: line.id,
                    lineName: line.name,
                    direction,
                    platform,
                    destination: formatDestination(p.displayName),
                    targetMs: parseTargetMs(p.eta),
                    // Placeholder; every surviving row is relabelled by tick().
                    eta: '',
                    etaMinutes: null,
                    isDue: false,
                });
            }
        }
    }
    return rows;
}

/**
 * Drop departed rows, then relabel the survivors against the current clock.
 *
 * Step 2 is the **per-platform monotonic bump**: two trains on one platform may
 * not show the same label, so a collision shifts the later one up by one, and
 * the bump propagates ("Due, Due, Due" → "Due, 1 min, 2 min"). Cross-platform
 * collisions are left alone - Platform 1 "1 min" and Platform 2 "1 min" are two
 * different trains and both are true.
 *
 * This lives here rather than in the formatter for the same reason it lives in
 * `tickPredictions` on Android: the rule is platform-aware and sibling-aware,
 * and the formatter only ever sees one row.
 */
export function tick(rows: DepartureRow[], nowMs: number): DepartureRow[] {
    if (rows.length === 0) return rows;
    const departedBefore = nowMs - DEPARTED_GRACE_MS;

    const survivors = rows.filter(r => r.targetMs === null || r.targetMs >= departedBefore);
    if (survivors.length === 0) return survivors;

    const byPlatform = new Map<string, DepartureRow[]>();
    for (const r of survivors) {
        const group = byPlatform.get(r.platform);
        if (group) group.push(r);
        else byPlatform.set(r.platform, [r]);
    }

    const out: DepartureRow[] = [];
    for (const group of byPlatform.values()) out.push(...bumpPlatformGroup(group, nowMs));
    return out;
}

function bumpPlatformGroup(group: DepartureRow[], nowMs: number): DepartureRow[] {
    const withTarget = group.filter(r => r.targetMs !== null);
    const withoutTarget = group.filter(r => r.targetMs === null);

    withTarget.sort((a, b) => arrivalSortKey(a.targetMs) - arrivalSortKey(b.targetMs));

    let prevMin = -1; // "Due" is 0; -1 means nothing taken yet
    const bumped = withTarget.map(r => {
        const secs = Math.floor((r.targetMs! - nowMs) / 1000);
        // Same floor rounding as formatEta - inlined only because the bump needs
        // the raw integer and the formatter returns a string. Keep them in
        // lockstep.
        const raw = secs < 60 ? 0 : Math.floor(secs / 60);
        const effective = Math.max(raw, prevMin + 1);
        prevMin = effective;
        return {
            ...r,
            eta: effective === 0 ? 'Due' : `${effective} min`,
            etaMinutes: effective,
            isDue: effective === 0,
        };
    });

    // Rows we cannot compute go last, and say so. They used to keep the empty
    // placeholder `flatten` gave them, which drew a blank cell where an ETA
    // belongs - indistinguishable from a board that has failed to render.
    const unknown = withoutTarget.map(r => ({ ...r, eta: r.eta || '--', etaMinutes: null, isDue: false }));

    return [...bumped, ...unknown];
}

/**
 * Platforms worth putting on a café wall.
 *
 * TfL stops assigning a platform beyond roughly half an hour out, so the tail of
 * every board arrives as "Platform not assigned". On a phone that is fine - it
 * is below the fold and the rider is scrolling for it. On a TV it took a third
 * of the screen and a hero card reading "39 min", which is not a thing anybody
 * in a café is waiting for.
 *
 * So: when any platform IS assigned, the unassigned block is dropped. Note what
 * this is not - it is a filter, never a relabel. The platform string stays
 * backend-owned and displayed verbatim (see backend `docs/PLATFORM_FORMATTING.md`);
/**
 * For the hero cards:
 * - If 2+ assigned platforms exist (e.g. Platform 1 & Platform 2), show only assigned.
 * - If only 1 assigned platform exists and an unassigned group is present (e.g. other direction),
 *   keep the unassigned group so both directions are represented on the hero cards.
 * - If no assigned platforms exist, show the unassigned group(s).
 */
export function dropUnassignedWhenPossible(
    groups: PlatformGroup[],
    targetCount = 2,
): PlatformGroup[] {
    const assigned = groups.filter(g => !isUnassigned(g.platform));
    const unassigned = groups.filter(g => isUnassigned(g.platform));

    if (assigned.length >= targetCount || (assigned.length > 0 && unassigned.length === 0)) {
        return assigned;
    }

    if (assigned.length > 0 && unassigned.length > 0) {
        return [...assigned, ...unassigned].slice(0, targetCount);
    }

    return unassigned.slice(0, targetCount);
}

export function isUnassigned(platform: string): boolean {
    const p = (platform || '').trim().toLowerCase();
    return (
        p === 'platform not assigned' ||
        p === 'unassigned' ||
        p === '' ||
        p === 'null' ||
        p === 'unknown' ||
        p === 'platform unknown' ||
        p === 'no platform'
    );
}

/**
 * Group into the platform blocks the board draws, ordered by PLATFORM: 1, then
 * 2, then anything lettered, then unassigned last.
 *
 * Deliberately not "soonest first", which is what the phone does. A phone board
 * is read once, by someone deciding what to do in the next few minutes, so
 * putting the most imminent train at the top is right. A café board is read a
 * hundred times by the same people, and a block that moves position whenever
 * the other platform gets busier makes them re-read the whole thing every time.
 * Fixed positions mean a regular learns "left is Richmond" and never has to
 * look again.
 *
 * Unassigned sorts last on the board rather than being dropped from it: those
 * are real departures, just ones TfL has not allocated a platform for yet.
 *
 * The line prefix is the line's own name here. The phone uses
 * `formatLinePrefix(mode, line)`, which reads SDUI-supplied templates; a kiosk
 * shows one station on one mode, so the line name is the whole of it.
 */
export function groupByPlatform(rows: DepartureRow[], maxPerPlatform: number): PlatformGroup[] {
    const groups = new Map<string, DepartureRow[]>();
    for (const r of rows) {
        const platKey = isUnassigned(r.platform) ? 'Platform not assigned' : r.platform.trim();
        const g = groups.get(platKey);
        if (g) g.push(r);
        else groups.set(platKey, [r]);
    }

    return [...groups.entries()]
        .map(([platform, groupRows]) => {
            const sorted = [...groupRows].sort(
                (a, b) => arrivalSortKey(a.targetMs) - arrivalSortKey(b.targetMs),
            );
            return {
                platform,
                header: platformHeaderText(platform),
                rows: sorted.slice(0, maxPerPlatform),
            };
        })
        .sort((a, b) => comparePlatforms(a.platform, b.platform));
}

/**
 * Platform order: numbered first and numerically ("Platform 2" before
 * "Platform 10", which a plain string sort gets backwards), then lettered ones
 * alphabetically, then unassigned.
 *
 * The string is only READ here, never rewritten - it stays backend-owned and is
 * still displayed verbatim.
 */
function comparePlatforms(a: string, b: string): number {
    const [rankA, numA] = platformKey(a);
    const [rankB, numB] = platformKey(b);
    if (rankA !== rankB) return rankA - rankB;
    if (rankA === 0) return numA - numB;
    return a.localeCompare(b);
}

/** [rank, number] - rank 0 numbered, 1 lettered, 2 unassigned. */
function platformKey(platform: string): [number, number] {
    if (isUnassigned(platform) || !platform.trim()) return [2, 0];
    const digits = platform.match(/\d+/);
    return digits ? [0, Number(digits[0])] : [1, 0];
}

export { formatEta };
