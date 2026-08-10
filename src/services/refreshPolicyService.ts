/**
 * How often clients should refresh their glanceable surfaces.
 *
 * ## Why the schedule lives here and not in the app
 * The iOS widget runs inside a hard quota — WidgetKit meters timeline reloads
 * at roughly 40–70 a day and throttles a widget that overspends, which on a
 * home screen is indistinguishable from a widget that is broken. The right
 * cadence therefore is not a constant anyone can compile in: it depends on the
 * hour, the day, and on whether something is happening in London tonight. All
 * three change faster than an App Store release.
 *
 * So the schedule is served. Editing the document below and redeploying changes
 * every client's behaviour; pairing it with a `policy.update` push (see
 * `devicePushService`) makes the change land on devices whose app is not even
 * running.
 *
 * ## Contract
 * This is the wire shape of `RefreshPolicy` in
 * `core/src/commonMain/kotlin/model/refresh/RefreshPolicy.kt`, and the client
 * decodes it with `ignoreUnknownKeys`. That gives one safe direction of change
 * and one unsafe one:
 *   - ADDING a field, a tier, or a window is safe. Old clients ignore what they
 *     do not know; a window naming an unknown tier is skipped, not fatal.
 *   - RENAMING or REMOVING a field is not. Clients fall back to their compiled
 *     default for anything they cannot read, which is a silent behaviour change
 *     rather than an error anyone will see.
 *
 * Keep `version` monotonic — the client stores the version it holds so a push
 * can say "you are stale" without carrying the document.
 *
 * The client ships an identical copy compiled in (`RefreshPolicyDefaults.kt`)
 * for first launch and for when this endpoint is unreachable. When the two
 * diverge this one wins; keeping them in step at rest just means a cold start
 * and a warm one behave the same.
 */

export interface RefreshTier {
    id: string;
    label: string;
    /** Target gap between scheduled reloads. Clients may STRETCH this to
     *  protect their budget, and clamp it to `budget.minIntervalMinutes`. */
    intervalMinutes: number;
    /** Minutes of per-minute timeline entries — the window a countdown is
     *  actually read in. */
    denseMinutes: number;
    /** Spacing of the cheap tail that keeps a timeline alive to its horizon. */
    sparseStepMinutes: number;
    horizonMinutes: number;
    /** Cadence for the platform's own background wake (iOS BGAppRefreshTask),
     *  which draws on a budget separate from the widget's. 0 disables it. */
    backgroundTaskMinutes: number;
}

export interface RefreshWindow {
    /** Three-letter days, "MON".."SUN". Empty/omitted = every day. */
    days?: string[];
    /** Inclusive "HH:mm" in `timezone`. */
    from: string;
    /** Exclusive "HH:mm". May be EARLIER than `from` to wrap midnight — that is
     *  how the overnight band is written, and clients handle the wrap. */
    to: string;
    tierId: string;
    /** Higher wins an overlap. Lets a one-off overlay (a festival, a strike) be
     *  laid over the ordinary bands without rewriting them. */
    priority: number;
}

export interface RefreshPolicy {
    id: string;
    version: number;
    timezone: string;
    tiers: RefreshTier[];
    windows: RefreshWindow[];
    defaultTierId: string;
    budget: {
        /** Deliberately under Apple's ~40–70: the real ceiling varies per device
         *  and per user habit, and being throttled costs far more than being a
         *  little conservative. */
        dailyReloadCeiling: number;
        /** Held back from routine scheduling so a boost or a disruption push
         *  late in the day still has quota. Only a boost may draw on it. */
        reserveForBoost: number;
        /** Hard floor on any computed interval. Guards a typo here from
         *  draining a device's quota before anyone notices. */
        minIntervalMinutes: number;
        /** Hard CEILING, however spent the budget looks. Overspending fails
         *  gracefully (Apple stops honouring reloads, and the client's tick
         *  layer keeps counting down); under-refreshing fails abruptly, with a
         *  board frozen for hours and nothing to say it is not live. Measured:
         *  without this, an over-counted ledger produced a 627-minute interval
         *  and a widget untouched through a Monday morning peak. */
        maxIntervalMinutes: number;
    };
    boost: {
        tierId: string;
        /** The client stamps an absolute deadline when a boost STARTS and
         *  expires against it, so a device that never receives `boost.stop`
         *  still falls back on its own. Raising this raises that ceiling. */
        maxDurationMinutes: number;
    };
    ttlMinutes: number;
}

const TIER_RUSH = 'P1';
const TIER_DAY = 'P2';
const TIER_NIGHT = 'P3';
const TIER_WEEKEND = 'P4';

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const WEEKEND = ['SAT', 'SUN'];

export class RefreshPolicyService {
    static getRefreshPolicy(): RefreshPolicy {
        return {
            id: 'widget_refresh_policy',
            version: 3,
            timezone: 'Europe/London',

            tiers: [
                {
                    // Fifteen minutes is the tightest cadence worth asking for:
                    // TfL's own predictions move on roughly that scale. The
                    // background-task layer is what actually delivers it — the
                    // widget timeline alone could not, at any setting.
                    id: TIER_RUSH,
                    label: 'Rush hour',
                    intervalMinutes: 15,
                    denseMinutes: 20,
                    sparseStepMinutes: 5,
                    horizonMinutes: 60,
                    backgroundTaskMinutes: 15,
                },
                {
                    // 45 rather than the hour it might obviously be: the budget
                    // affords it, and an off-peak board is then never a full
                    // hour stale when someone glances at it. Clients stretch
                    // this themselves if a day turns out busy, so the
                    // optimistic setting costs nothing.
                    id: TIER_DAY,
                    label: 'Off-peak',
                    intervalMinutes: 45,
                    denseMinutes: 15,
                    sparseStepMinutes: 5,
                    horizonMinutes: 60,
                    backgroundTaskMinutes: 60,
                },
                {
                    // ── Saturday and Sunday daytime ──
                    //
                    // The weekend used to be folded into P2 at 45 minutes,
                    // which left it costing ~24 scheduled reloads against an
                    // allowance of 43 — nearly half the quota unspent every
                    // weekend while boards sat staler than they needed to.
                    //
                    // A weekend is not a weekday off-peak: there is no commuter
                    // peak to reserve budget for, so the whole day can be
                    // denser than a weekday midday. But weekend travel is less
                    // time-critical than an 08:15 platform decision, so it does
                    // not warrant P1's fifteen. Thirty brings a weekend to ~35
                    // reloads — real use of the allowance, with headroom left
                    // for a disruption push or a match-day boost.
                    //
                    // Added as a FOURTH tier deliberately: the client keys
                    // tiers by opaque string, so this shipped without a client
                    // release. That is the property this whole document exists
                    // to provide.
                    id: TIER_WEEKEND,
                    label: 'Weekend',
                    intervalMinutes: 30,
                    denseMinutes: 15,
                    sparseStepMinutes: 5,
                    horizonMinutes: 60,
                    backgroundTaskMinutes: 30,
                },
                {
                    // backgroundTaskMinutes: 0 switches the background wake OFF
                    // rather than merely slowing it — waking a phone at 03:00
                    // to fetch a board nobody will look at spends battery to
                    // change nothing.
                    id: TIER_NIGHT,
                    label: 'Night',
                    intervalMinutes: 180,
                    denseMinutes: 10,
                    sparseStepMinutes: 15,
                    horizonMinutes: 45,
                    backgroundTaskMinutes: 0,
                },
            ],

            // Priority ascending so the peaks win any overlap with the bands
            // laid under them. Nothing here overlaps today; the ordering is
            // what keeps a hand-edited policy predictable.
            windows: [
                { from: '23:00', to: '06:30', tierId: TIER_NIGHT, priority: 0 },
                { days: WEEKDAYS, from: '09:30', to: '16:00', tierId: TIER_DAY, priority: 1 },
                { days: WEEKDAYS, from: '19:30', to: '23:00', tierId: TIER_DAY, priority: 1 },
                // Butts directly against the night band rather than starting
                // at 07:00. The half-hour gap that used to sit here fell
                // through to the default tier, so a weekend morning briefly ran
                // at a different cadence than the hour either side of it.
                { days: WEEKEND, from: '06:30', to: '23:00', tierId: TIER_WEEKEND, priority: 1 },
                { days: WEEKDAYS, from: '06:30', to: '09:30', tierId: TIER_RUSH, priority: 2 },
                { days: WEEKDAYS, from: '16:00', to: '19:30', tierId: TIER_RUSH, priority: 2 },
            ],

            // Weekend early mornings (06:30–07:00) match no window by design and
            // land here — the right answer for the few minutes involved, and it
            // keeps the window list short.
            defaultTierId: TIER_DAY,

            budget: {
                dailyReloadCeiling: 55,
                reserveForBoost: 12,
                minIntervalMinutes: 10,
                maxIntervalMinutes: 120,
            },

            boost: {
                tierId: TIER_RUSH,
                maxDurationMinutes: 90,
            },

            ttlMinutes: 720,
        };
    }
}
