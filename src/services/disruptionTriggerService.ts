import { DevicePushService } from './devicePushService';

/**
 * Turns a line going wrong into an immediate widget refresh.
 *
 * ## Why this is automatic and not a button
 * The brief was "in case of closures or accidents it updates once". A person
 * clicking a button in an admin console at 08:10 when the Victoria line fails
 * is not that — it is somebody being paged. TfL already tells us; the only
 * missing step was acting on it.
 *
 * ## Edge-triggered, not level-triggered
 * This is the whole design, and getting it wrong is what would make the feature
 * unusable. `statusSeverityDescription` is re-broadcast constantly — the Syncer
 * pushes, our TfL fallback refreshes, and the text jitters ("Severe Delays" →
 * "Severe Delays" with a new `reason`). Pushing on every one of those would
 * wake every affected device every few seconds and burn exactly the quota the
 * whole refresh-policy design exists to protect.
 *
 * So a push fires only on a **transition of disruption state** for a line:
 *   good service → disrupted   (something broke — the case users care about)
 *   disrupted   → good service (it cleared — the board should stop saying so)
 *   disrupted   → differently disrupted, by SEVERITY only, not by reason text
 *
 * A change to the `reason` wording while severity holds is not a transition and
 * sends nothing.
 *
 * ## Two more brakes, because edge-detection alone is not enough
 * A line can genuinely flap across the good/disrupted boundary. So:
 *  - a per-line cooldown ([COOLDOWN_MS]) bounds how often one line may trigger;
 *  - the push carries an `apns-collapse-id` keyed on the line, so even if
 *    several slip through, APNs coalesces them into one wake per device.
 *
 * ## Failure is silent by design
 * Every path swallows its errors. This runs inside the line-status broadcast
 * path, which serves live boards to connected clients; a push failure must
 * never be able to interrupt that.
 */

/** Severity text TfL uses when nothing is wrong. Compared case-insensitively
 *  and by prefix, because it arrives as "Good Service" and occasionally with
 *  trailing detail. */
const HEALTHY_PREFIXES = ['good service', 'no issues', 'service closed', 'closed'];

/**
 * Minimum gap between triggers for ONE line.
 *
 * Ten minutes: long enough that a flapping line cannot spam, short enough that
 * a genuine sequence (delays → part suspension) still reaches people while it
 * matters. Per line, not global — a bad morning on the Central must not
 * silence the District.
 */
const COOLDOWN_MS = 10 * 60 * 1000;

interface LineState {
    /** Normalised severity at the last decision point. */
    severity: string;
    /** When we last actually pushed for this line. */
    lastPushAt: number;
}

export class DisruptionTriggerService {

    private static state = new Map<string, LineState>();
    private static triggered = 0;
    private static suppressed = 0;

    /** Whether a severity string means "nothing wrong". */
    private static isHealthy(severity: string): boolean {
        const s = severity.trim().toLowerCase();
        if (!s) return true;   // unknown = don't cry wolf
        return HEALTHY_PREFIXES.some(p => s.startsWith(p));
    }

    /**
     * Observe a line status. Call AFTER the cache has been updated, from the
     * same funnel that feeds the live stream, so every producer is covered by
     * one hook.
     *
     * Deliberately returns void and never throws — see the class note.
     */
    static observe(lineId: string, severityDescription?: string, mode?: string): void {
        try {
            const line = (lineId ?? '').trim().toLowerCase();
            if (!line) return;

            const severity = (severityDescription ?? '').trim();
            const previous = this.state.get(line);
            const now = Date.now();

            // First sighting establishes a baseline and pushes nothing. On a
            // process restart every line is "new", and without this the first
            // status sweep would fire a push for every disrupted line at once.
            if (!previous) {
                this.state.set(line, { severity, lastPushAt: 0 });
                return;
            }

            const wasHealthy = this.isHealthy(previous.severity);
            const isHealthy = this.isHealthy(severity);
            const severityChanged = previous.severity.toLowerCase() !== severity.toLowerCase();

            // The transition test. Note a `reason`-only change reaches here
            // with an unchanged severity and is correctly ignored.
            const isTransition = (wasHealthy !== isHealthy) || (!isHealthy && severityChanged);

            this.state.set(line, { severity, lastPushAt: previous.lastPushAt });
            if (!isTransition) return;

            if (now - previous.lastPushAt < COOLDOWN_MS) {
                this.suppressed++;
                return;
            }

            this.state.set(line, { severity, lastPushAt: now });
            this.triggered++;

            const direction = wasHealthy ? 'disrupted' : (isHealthy ? 'recovered' : 'changed');
            console.log(`DISRUPTION: ⚡ ${line} ${direction} — "${previous.severity}" → "${severity}"`);

            // Fire and forget. Awaiting would put an APNs round trip inside the
            // live-stream broadcast path.
            void DevicePushService.send({
                kind: 'widget.refresh',
                lines: [line],
                reason: `tfl:${direction}`,
            }).catch(() => { /* best-effort; the refresh schedule is the guarantee */ });
        } catch {
            // Never let observation break the path it observes.
        }
    }

    static stats() {
        return {
            trackedLines: this.state.size,
            triggered: this.triggered,
            suppressedByCooldown: this.suppressed,
            cooldownMs: COOLDOWN_MS,
        };
    }

    /** Test/ops helper. */
    static reset(): void {
        this.state.clear();
        this.triggered = 0;
        this.suppressed = 0;
    }
}
