import { LinePredictions, Station } from '../../models';

/**
 * Everything a source needs to build one station's full board.
 * The countdown arrivals for the whole station are always provided — they
 * are fetched once per request regardless of source, and richer sources
 * use them for direction inference and as the fallback board.
 */
export interface StationPredictionContext {
    naptanId: string;
    /** Locally-stored station details; undefined when the naptanId is not in our DB. */
    station?: Station;
    /** Raw /StopPoint/{id}/Arrivals entries for the station, all modes mixed.
     *  A promise so board sources can overlap their board calls with the
     *  fetch — await it where the entries are actually consumed. */
    arrivals: Promise<any[]>;
}

/**
 * Strategy for turning TfL data into one station's board predictions.
 *
 * The pipeline around it is source-agnostic (fetch arrivals → pick ONE
 * source per station → build → sort → cache); which source a station gets
 * is decided from its locally-stored mode set (PredictionSourceFactory):
 *
 *   - pure elizabeth-line / overground station: rail-style
 *     ArrivalDepartures board (true departures + destinations at termini)
 *   - everything else (tube / dlr / bus / tram, and stations mixing those
 *     with rail modes): countdown arrivals, the only live product there
 *   - national-rail (future): a different API entirely — add a source and
 *     register it in PredictionSourceFactory
 *
 * Implementations must return fully-formed LinePredictions keyed by
 * lowercase lineId; the caller sorts each direction by eta.
 */
export interface PredictionSource {
    /** Short name for logs, e.g. "tube-dlr-bus-tram-mix", "departure-board". */
    readonly name: string;

    /** Whether this source should build the board for the given station. */
    supports(station: Station | undefined): boolean;

    /** Build lineId → predictions for the whole station. */
    buildStationPredictions(ctx: StationPredictionContext): Promise<Record<string, LinePredictions>>;
}
