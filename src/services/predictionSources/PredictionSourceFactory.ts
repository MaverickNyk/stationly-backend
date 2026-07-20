import { Station } from '../../models';
import { PredictionSource } from './PredictionSource';
import { TubeDlrBusTramMixPredictionSource } from './TubeDlrBusTramMixPredictionSource';
import { ElizabethOvergroundPredictionSource } from './ElizabethOvergroundPredictionSource';

/**
 * Resolves which PredictionSource builds the board for a station, from its
 * locally-stored mode set. One source per station: a pure elizabeth-line/
 * overground station gets the rail-style departures board; every other
 * station — tube/dlr/bus/tram, stations mixing those with rail modes, and
 * naptanIds missing from our local DB — keeps the countdown arrivals path
 * unchanged.
 *
 * Specialised sources are consulted in registration order; the countdown
 * source is the universal fallback. To add a mode backed by a different
 * API (e.g. national-rail via Darwin), implement PredictionSource and
 * prepend it to SOURCES — nothing else changes.
 */
export class PredictionSourceFactory {

    // The single countdown-source instance: universal fallback here AND the
    // per-line fallback inside the board source (injected below).
    private static readonly FALLBACK = new TubeDlrBusTramMixPredictionSource();

    private static readonly SOURCES: PredictionSource[] = [
        new ElizabethOvergroundPredictionSource(PredictionSourceFactory.FALLBACK),
        // new DarwinPredictionSource(),   // national-rail — future
    ];

    static forStation(station: Station | undefined): PredictionSource {
        return PredictionSourceFactory.SOURCES.find(s => s.supports(station))
            ?? PredictionSourceFactory.FALLBACK;
    }
}
