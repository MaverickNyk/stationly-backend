import { LinePredictions, Station } from '../../models';
import { formatPlatform } from '../../utils/formatters';
import { PredictionSource, StationPredictionContext } from './PredictionSource';
import {
    cleanDestinationName,
    isFarFutureUnassigned,
    isLongDeparted,
    resolveDepartingDirection,
} from './predictionUtils';

/**
 * Source for every station that is NOT purely elizabeth-line/overground:
 * tube, DLR, bus and tram stops, and mixed stations where those modes
 * share a naptanId with rail services (the factory also uses it as the
 * universal fallback for naptanIds missing from our local station DB).
 *
 * Reads TfL's Countdown arrivals feed (/StopPoint/{id}/Arrivals):
 * signalling-based arrival predictions, the same data the physical
 * platform signs show, and the only live product for these modes. The
 * arrivals carry their own modeName, so one pass handles a mixed
 * station's tube + overground + bus rows exactly like the pre-factory
 * controller did.
 *
 * Limitation this source cannot escape (and why the departure-board
 * source exists): at a terminus the feed only sees the inbound working —
 * arrival times and "destination = this station" — so terminating trains
 * surface as "Check Front of Train" at their ARRIVAL time, not their
 * departure.
 */
export class TubeDlrBusTramMixPredictionSource implements PredictionSource {
    readonly name = 'tube-dlr-bus-tram-mix';

    supports(_station: Station | undefined): boolean {
        return true; // universal fallback — factory consults it last
    }

    private formatDisplayName(arrival: any): string {
        // iBus sends the literal string "null" in `towards` for buses while the
        // real destination sits in destinationName — treat it as absent.
        const towards = (arrival.towards || '').trim();
        const raw = (towards && towards.toLowerCase() !== 'null')
            ? towards
            : (arrival.destinationName || '');
        return cleanDestinationName(raw);
    }

    async buildStationPredictions(ctx: StationPredictionContext): Promise<Record<string, LinePredictions>> {
        const { naptanId } = ctx;
        const arrivals = await ctx.arrivals;
        const lines: Record<string, LinePredictions> = {};

        // Departing direction is identical for every self-terminating arrival
        // on the same line — resolve once per line, not per arrival.
        const departingDirByLine = new Map<string, string | null>();

        arrivals.forEach(arrival => {
            const lineId = arrival.lineId.toLowerCase();
            const modeName = (arrival.modeName || '').toLowerCase();
            const rawPlatform = arrival.platformName || '';
            const platform = formatPlatform(modeName, rawPlatform);
            const eta = arrival.expectedArrival || '';

            // Overground/DLR/Elizabeth line: TfL doesn't assign platforms until ~5–15 min before
            // departure — skip far-future unplatformed arrivals before they enter the response.
            if (isFarFutureUnassigned(modeName, platform, eta)) return;

            // Drop trains TfL should have expired: >2 min past expectedArrival.
            if (isLongDeparted(eta)) return;

            // Terminus rule (mirrors tfl.gov.uk): a train whose destination is
            // this very station is arriving to turn around. It IS a future
            // departure, but its outbound destination is unknown until TfL
            // assigns the return working at the platform — so show it as
            // "Check Front of Train" (never drop it; keyed on the naptanId, not
            // the name). Its direction is re-bucketed to the line's single
            // departing direction here, since the raw entry carries none.
            const isSelfTerminating = !!arrival.destinationNaptanId && arrival.destinationNaptanId === naptanId;

            let direction = arrival.direction
                || (rawPlatform.toLowerCase().includes('inbound') ? 'inbound' : 'outbound');
            if (isSelfTerminating && !arrival.direction) {
                if (!departingDirByLine.has(lineId)) {
                    departingDirByLine.set(lineId, resolveDepartingDirection(naptanId, lineId));
                }
                direction = departingDirByLine.get(lineId) || direction;
            }

            if (!lines[lineId]) {
                lines[lineId] = {
                    id: arrival.lineId,
                    name: arrival.lineName,
                    dirs: {}
                };
            }

            if (!lines[lineId].dirs[direction]) {
                lines[lineId].dirs[direction] = { preds: [] };
            }

            lines[lineId].dirs[direction].preds.push({
                destId: isSelfTerminating ? 'unknown' : (arrival.destinationNaptanId || 'unknown'),
                platform,
                eta,
                displayName: isSelfTerminating ? 'Check Front of Train' : this.formatDisplayName(arrival)
            });
        });

        return lines;
    }
}
