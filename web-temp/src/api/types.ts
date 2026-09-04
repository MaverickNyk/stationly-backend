/**
 * MIRRORS `stationly-backend/src/models/index.ts`. Hand-copied on purpose -
 * this folder must not import across the boundary (see TEMPORARY.md).
 *
 * If the prediction shape changes upstream, this file must follow. The real fix
 * is a client generated from `/openapi.json`; noted as a debt, not done.
 */

export interface PredictionItem {
    destId: string;
    /** Backend-owned display string. NEVER derive this client-side -
     *  see backend `docs/PLATFORM_FORMATTING.md`. Empty for an unassigned bus
     *  stop; "Platform not assigned" for unassigned rail. */
    platform: string;
    /** ISO-8601. The only honest ordering key - see logic/eta.ts. */
    eta: string;
    displayName: string;
    /** Absent means "no branch", and absent is the normal case. Fail open. */
    viaKey?: string;
}

export interface DirectionPredictions {
    preds: PredictionItem[];
}

export interface LinePredictions {
    id: string;
    name: string;
    dirs: Record<string, DirectionPredictions>;
}

export interface StationPredictionResponse {
    id: string;
    name: string;
    /** Last Updated Time (ISO-8601) - the payload's own clock, not ours. */
    lut: string;
    lines: Record<string, LinePredictions>;
}

export interface LineStatus {
    id: string;
    name: string;
    statusSeverityDescription: string;
    reason?: string;
    mode: string;
    lastUpdatedTime: string;
}

/** What the BFF returns - the two upstream calls, already joined. */
export interface KioskSnapshot {
    station: StationPredictionResponse;
    statuses: LineStatus[];
    /** lineId → mode ("overground", "tube", …), for the roundel. */
    lineModes: Record<string, string>;
    /** Server clock at response time, so a TV with a wrong clock still counts
     *  down correctly. See hooks/useServerClockOffset. */
    serverNowMs: number;
}
