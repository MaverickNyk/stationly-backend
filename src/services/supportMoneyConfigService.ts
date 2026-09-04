import { getBaseUrl } from '../utils/formatters';

/**
 * Server-Driven UI for the "support Stationly" surfaces.
 *
 * ## What this owns
 * Every string, amount, and toggle the support card / contextual card / reward
 * screen render from. The clients are dumb renderers over this payload — the
 * same principle as `SduiService.getHomeConfig()` and `ThemeService`. Change a
 * value here, redeploy, and it is live on the next `home-config` fetch with no
 * app release. Swapping the `heart` metaphor for a `pint` is `icon` + `heading` + three tier
 * labels.
 *
 * ## Two shapes, one source
 *  - {getSupportMoneyConfig} — the structured object, served at
 *    `GET /sdui/app/support-money-config` and useful to Android / Web later.
 *  - {homeConfigKeys} — the same content flattened into the string map that
 *    `getHomeConfig()` already returns, so the iOS client can read it from the
 *    map it fetches on every launch WITHOUT a new `SduiAppComponent` type in
 *    `core/commonMain` (which is shared with the frozen Android app and
 *    off-limits). The card payload rides one key, `support_money.card.json`, as a
 *    JSON string; the contextual-card knobs are flat `home.promo.support_money.*`
 *    keys matching the existing promo-banner namespace.
 *
 * ## Dormant by default
 * {enabled} is `false` unless `SUPPORT_MONEY_ENABLED=true`. Shipping this switched
 * off means the backend can go out ahead of the client work and the Stripe
 * wiring, with nothing user-visible and nothing for App Review to weigh.
 *
 * ## Platform-neutral by construction
 * No field names a mechanism. `cta.method` is `native_pay` (which each platform
 * maps to Apple Pay / Google Pay / a web checkout), and `cta.url_oneoff` is the
 * universal fallback that works in any browser. `icon` is an abstract token
 * (`heart` | `pint` | ...) each renderer maps to its own asset.
 */

export interface SupportMoneyTier {
    id: string;
    /** Minor units (pence). The client renders `label: "Pay {amount}"` from this. */
    amount_minor: number;
    /** Short human name for the chip ("Flat white"). */
    label: string;
    /**
     * The sentence shown UNDER the ladder when this rung is selected.
     *
     * Not on the chip: the chip has room for two words and this is the part
     * that does the actual persuading, so it gets the width. It changes as the
     * user taps, which makes choosing an amount also the way they find out what
     * amounts do.
     */
    hint: string;
    /**
     * The thank-you for THIS amount, shown on the reward screen.
     *
     * `{amount}` is interpolated client-side. Per-tier because "thank you" lands
     * harder when it names the specific thing the specific amount paid for, and
     * a single generic note cannot do that. The card's `thanks.note` is the
     * fallback, and the one a custom amount always gets.
     */
    thanks: string;
    /**
     * The checkout URL for THIS amount. Stripe Payment Links price the link,
     * not the request — there is no amount query parameter — so a fixed-price
     * link per tier is what makes "pick £8, pay £8" one tap instead of two.
     * Served with `?client_reference_id={uid}` already on it: substitute the
     * signed-in uid for `{uid}` (URL-encoded) and open the result. Without that
     * substitution the payment reaches the webhook with nobody to credit.
     * Empty until the owner creates the link; combined with `enabled:false`
     * an empty URL is inert, not a broken button. The client falls back to
     * `cta.url_oneoff` (the customer-chooses-amount link) when this is "".
     */
    url: string;
}

export interface SupportMoneyBoardLine {
    l: string;
    r: string;
}

export interface SupportMoneyCardConfig {
    /** Component discriminator — lets a future proper SDUI renderer switch on it. */
    type: 'support_money_card';
    id: string;
    /** Master switch. `false` → clients render nothing for support. */
    enabled: boolean;
    /** Abstract glyph token: heart | coffee | pint | ticket | slice. */
    icon: string;
    heading: string;
    body: string;
    impact_line: string;
    /** The dot-matrix hero lines, left/right. */
    board_hero: SupportMoneyBoardLine[];
    tiers: SupportMoneyTier[];
    currency: string;
    default_tier_id: string;
    custom_amount: {
        enabled: boolean;
        min_minor: number;
        max_minor: number;
        /** `{amount}` and `{days}` are interpolated client-side. */
        hint: string;
    };
    recurring: {
        enabled: boolean;
        amount_minor: number;
        cadence: 'month';
        /** `{amount}` interpolated client-side. */
        link_label: string;
    };
    cta: {
        /** native_pay → Apple Pay / Google Pay; falls back to url_* in a browser. */
        method: 'native_pay' | 'web';
        /** `{amount}` interpolated client-side. */
        label: string;
        note: string;
        /**
         * The CUSTOM-amount checkout link — the "other amount" path, and the
         * fallback for any tier whose own `url` is empty. Fixed amounts live on
         * `tiers[].url`, because a Stripe Payment Link carries its price in the
         * link rather than in a query parameter. `{uid}` is interpolated
         * client-side; `{amount_minor}` is accepted for a future provider that
         * does take an amount, but Stripe Payment Links ignore it.
         * Empty until the owner creates the link — combined with
         * `enabled:false` an empty URL is inert, not a broken button.
         */
        url_oneoff: string;
        url_monthly: string;
    };
    social_proof: {
        enabled: boolean;
        /** `{count}` interpolated client-side. */
        template: string;
        /** Static count for now; a real figure can be wired later. */
        count: number;
    };
    /** The reward screen shown the instant a contribution returns. */
    thanks: {
        title_lines: string[];
        board_lines: SupportMoneyBoardLine[];
        note: string;
        perk_toasts: string[];
        confetti: boolean;
    };
    /**
     * The Supporter mark.
     *
     * **No `duration_days`, deliberately.** The client does not decide whether
     * anyone is a supporter and therefore has no use for the window: the profile
     * response carries `supportMoney.isActiveSupporter`, computed server-side
     * against `SUPPORT_MONEY_BADGE_DURATION_DAYS`, and the client renders that
     * boolean. Serving the number as well would be handing out a second copy of
     * a decision only one side makes, and the two would disagree the moment an
     * operator changed it. It also took the day count out of the copy, which is
     * the right outcome twice over: "Supporter for 30 days" was a countdown on a
     * gift, and it read like a subscription about to lapse.
     */
    badge: {
        label: string;
        /** Show a subtle mark on the home surface too, not just Profile. */
        show_on_home: boolean;
    };
}

const DAY = 86_400_000;

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envStr(name: string, fallback = ''): string {
    const raw = process.env[name];
    return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

/** The query parameter Stripe echoes back on the webhook as the payer's account. */
const UID_PARAM = 'client_reference_id';

/**
 * Stamp `?client_reference_id={uid}` onto a checkout URL.
 *
 * Attribution is the one thing that cannot be recovered after the fact: a
 * checkout opened without it takes the money and reaches the webhook with
 * nobody to credit, and the only fix is a human reading the Stripe dashboard.
 * Leaving each client to remember the parameter name meant iOS, Android and Web
 * each had to get an undocumented convention right. Serving the placeholder
 * inside the URL turns it into the same `{uid}` token substitution every other
 * field in this payload already uses, so a renderer that handles tokens at all
 * cannot forget it.
 *
 * Empty in, empty out — an unset link stays inert rather than becoming a
 * bare query string. An operator who already put the parameter in the env value
 * is left alone.
 */
function withUidPlaceholder(url: string): string {
    if (!url || url.includes(`${UID_PARAM}=`)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${UID_PARAM}={uid}`;
}

function envCheckoutUrl(name: string): string {
    return withUidPlaceholder(envStr(name));
}

export class SupportMoneyConfigService {
    /** The master switch. `false` unless `SUPPORT_MONEY_ENABLED=true` (case-insensitive). */
    static enabled(): boolean {
        return (process.env.SUPPORT_MONEY_ENABLED ?? '').trim().toLowerCase() === 'true';
    }

    /** Days a one-off tip keeps the Supporter badge. Kept in sync with {SupportMoneyService}. */
    static badgeDurationDays(): number {
        return envInt('SUPPORT_MONEY_BADGE_DURATION_DAYS', 30);
    }

    /** Milliseconds a one-off tip keeps the badge — the value {SupportMoneyService} adds to `now`. */
    static badgeDurationMs(): number {
        return this.badgeDurationDays() * DAY;
    }

    /**
     * The browser-return URL to hand Stripe as the Payment Link's success URL.
     * Documented for the owner; the backend does not enforce that Stripe was
     * configured with exactly this.
     */
    static returnUrl(): string {
        return `${getBaseUrl()}/api/v1/support-money/return`;
    }

    static getSupportMoneyConfig(): SupportMoneyCardConfig {
        return {
            type: 'support_money_card',
            id: 'support_main',
            enabled: this.enabled(),
            icon: envStr('SUPPORT_MONEY_ICON', 'heart'),
            heading: 'Keep Stationly free',
            // The single most important paragraph in the feature. Everything
            // else is chrome around the moment somebody decides to help or
            // decides not to, and that decision is made here.
            //
            // Three things it must do and one it must not. It has to say what
            // Stationly is (free, no ads, nothing locked), what it costs to hold
            // that up (servers, live data, monthly), and what the reader's part
            // in it is. What it must not do is talk about who builds it. An
            // appeal that leans on "one person, in London" is asking for
            // sympathy for the maker; this asks for the thing the reader
            // actually values to keep existing.
            body:
                'Stationly is free, with no adverts and nothing locked away. ' +
                'The servers and live data behind every board cost real money ' +
                'every month. This is how you help keep it here.',
            // Says the same thing the old line said and says it forwards.
            // "Nothing gets unlocked, because nothing is locked" was accurate
            // and read as a warning: the last word a reader takes from the one
            // highlighted sentence on the screen should not be "locked", and
            // telling someone what they will NOT get is a strange note to end an
            // appeal on. This promises instead.
            impact_line: 'Everything you see stays free, and so does everything we build next.',
            board_hero: [
                { l: 'Free forever', r: 'no ads' },
                { l: 'Every penny', r: 'running costs' },
            ],
            tiers: [
                // ## The chip says the SIZE, the line below says the STORY
                //
                // Chip labels are one short phrase on one line, and they ladder
                // on the same unit: 1 day, 3 days, 1 week. A reader compares
                // three amounts against three durations without decoding
                // anything, which is the only job a 10sp label can actually do.
                // "A day of departures" and "A stop with no board" tried to
                // carry the story up there and could not: they wrapped to
                // different heights, which made the three chips different sizes,
                // and they read as riddles at a glance.
                //
                // The story lives in `hint`, under the ladder, where there is
                // room for a sentence and where it changes as the user taps.
                {
                    id: 't4',
                    amount_minor: 400,
                    label: '1 day live',
                    hint: 'A full day of live data. Every Victoria line departure, for everyone watching one.',
                    thanks: '{amount} keeps the live data running for a full day, for everyone watching a board.',
                    url: envCheckoutUrl('SUPPORT_MONEY_PAYMENT_URL_T4'),
                },
                {
                    id: 't8',
                    amount_minor: 800,
                    // The default rung, and the one carrying the best sentence
                    // in the feature: someone standing on a pavement at Manor
                    // House where there is no screen to look at, holding a phone
                    // that tells them anyway.
                    label: '3 days live',
                    hint: 'Three days running. Enough for stops like Manor House, where the street has no board at all.',
                    thanks: '{amount} helps people waiting at stops like Manor House, where the street has no departure board at all.',
                    url: envCheckoutUrl('SUPPORT_MONEY_PAYMENT_URL_T8'),
                },
                {
                    id: 't12',
                    amount_minor: 1200,
                    label: '1 week live',
                    hint: 'A full week of the servers and live data behind every board in the app.',
                    thanks: '{amount} covers a full week of the servers and live data behind every board in the app.',
                    url: envCheckoutUrl('SUPPORT_MONEY_PAYMENT_URL_T12'),
                },
            ],
            currency: 'GBP',
            // The middle rung. A pre-selected default anchors hard, and the
            // fixed ~20p per-transaction fee makes the smallest tier the
            // worst-yielding one — £4 keeps ~93%, £8 keeps ~96%.
            default_tier_id: 't8',
            custom_amount: {
                enabled: true,
                min_minor: 100,
                max_minor: 50_000,
                // Rendered by the client from `support_money.sheet.custom_hint`
                // instead: the figure is typed on Stripe's own page, so there is
                // no amount here to interpolate and a hint that guesses one is a
                // sentence about a number the user has not chosen yet.
                hint: '',
            },
            recurring: {
                // Phase 1 — off for the first ship (one-off only, owner's call).
                enabled: false,
                // Matches the smallest one-off rung, so a monthly offer never
                // undercuts the ladder it sits under.
                amount_minor: 400,
                cadence: 'month',
                link_label: 'Rather give {amount} a month?',
            },
            cta: {
                method: 'native_pay',
                label: 'Pay {amount}',
                // Empty on purpose. It read "One tap, then straight back to the
                // app", which is a description of the plumbing on the one screen
                // where the reader is deciding whether to give money. It also
                // sat directly under the button, so it was the last thing read
                // before the tap. The failure line still renders in its place
                // when a checkout cannot be opened, which is what that slot is
                // actually worth keeping for.
                note: '',
                url_oneoff: envCheckoutUrl('SUPPORT_MONEY_PAYMENT_URL_ONEOFF'),
                url_monthly: envCheckoutUrl('SUPPORT_MONEY_PAYMENT_URL_MONTHLY'),
            },
            social_proof: {
                enabled: false,
                template: '{count} riders keep the lights on',
                count: envInt('SUPPORT_MONEY_PROOF_COUNT', 0),
            },
            thanks: {
                title_lines: ['Thank you'],
                // Empty on purpose, and this is a correction rather than an
                // omission. It used to read "The board stays lit / +1 day" and
                // "Supporter / 30 days", which is a receipt for something
                // nobody bought: the badge is not a product and "+1 day" is a
                // number with no meaning behind it. What belongs in that space
                // is a sentence about what the money actually does, which is
                // {thanks.note}. The field stays so an operator can put a real
                // figure here later without an app release.
                board_lines: [],
                // The FALLBACK note. A tier's own `thanks` wins when the amount
                // matches one, which is every path except a custom amount.
                //
                // Unsigned, deliberately. It used to end with a name and a city,
                // which turned a thank-you from the app into a note from a
                // person the reader has never met, and made the whole feature
                // read as a favour to somebody rather than as keeping a thing
                // they use alive.
                note:
                    'This goes straight into our server costs, keeps the team going, ' +
                    'and pays for the new things we are building. Stationly stays free, ' +
                    'ad free and with no paywalls, and that is because of people like you.',
                perk_toasts: [],
                confetti: true,
            },
            badge: {
                // The word the user sees on their own profile. "Supporter"
                // alone could be a supporter of anything; naming the app makes
                // it the specific thing they did, and the handshake is the
                // thank-you the label cannot fit.
                label: '🤝 Stationly Supporter',
                // On the home surface too. It is one small mark on the avatar
                // the user already looks at, not a second banner, and it is the
                // only place the thank-you is visible without opening Profile.
                show_on_home: true,
            },
        };
    }

    /**
     * The support content flattened into the `home-config` string map.
     *
     * `support_money.card.json` is the whole {SupportMoneyCardConfig} as a JSON string —
     * one key, so the flat `Record<string,string>` contract that Android and
     * iOS both consume is unchanged. The `home.promo.support_money.*` keys drive the
     * "after you add a board" contextual card and match the existing
     * `home.promo.widget.*` / `home.promo.dream.*` shape, `show` switch and all.
     */
    static homeConfigKeys(): Record<string, string> {
        const cfg = this.getSupportMoneyConfig();
        return {
            'support_money.card.json': JSON.stringify(cfg),

            // ── "After you add a board" contextual card ──
            // Fires ONCE, when boards-ever-added >= min_boards AND the app has
            // been opened on >= min_days distinct days. Counted client-side.
            // Independently switchable from the card's own `enabled`. The
            // permanent profile card and the unprompted banner are different
            // asks, and being able to turn the interruption off without
            // removing the way to contribute is the whole point of having two
            // surfaces. Defaults to the master switch when unset.
            'home.promo.support_money.show': String(
                (process.env.SUPPORT_MONEY_PROMO_ENABLED ?? '').trim().toLowerCase() === 'false'
                    ? false
                    : this.enabled(),
            ),
            // Env-driven because these are the two numbers most likely to be
            // wrong on the first guess, and the only way to learn the right
            // ones is to move them against real retention. Hardcoding them made
            // every adjustment a redeploy of code rather than a config change —
            // and made the feature untestable on a fresh install, which needs
            // 1/1 to reach the banner at all.
            'home.promo.support_money.min_boards': String(envInt('SUPPORT_MONEY_MIN_BOARDS', 2)),
            'home.promo.support_money.min_days': String(envInt('SUPPORT_MONEY_MIN_DAYS', 3)),
            'home.promo.support_money.title': 'Keep Stationly free',
            'home.promo.support_money.text':
                'We work hard to keep it fast, free and completely ad free. ' +
                'A little support covers the servers and live data behind your boards.',
            'home.promo.support_money.cta': 'Support Stationly',
            'home.promo.support_money.dismiss': 'Maybe later',

            // ── Labels the card payload has no field for ──────────────────
            // The structured payload covers the pitch, the ladder and the
            // reward script. These are the chrome around them — a section
            // header, the two states of the profile row, the custom-amount
            // row, the failure line. They are flat keys rather than new payload
            // fields because they belong to how a client lays the feature out,
            // not to what the feature offers; a renderer that arranges things
            // differently needs different ones. Every client ships a fallback,
            // so an absent key is a wording choice, never a blank.
            //
            // NOTE ON VOICE: no "buy me a coffee", anywhere. The metaphor made
            // the ask sound like a novelty purchase and put a drink between the
            // reader and what the money is for. The whole surface now says the
            // same plain thing the app's promise says: it is free and ad free,
            // that costs money to hold up, and this is how you help hold it up.
            'support_money.profile.section': 'Support Stationly',
            'support_money.profile.title': 'Support Stationly',
            'support_money.profile.body':
                'Stationly is completely free. A little support is what keeps it that way.',
            'support_money.profile.cta': 'Support Stationly',
            'support_money.profile.title.supporter': "You're a supporter",
            'support_money.profile.body.supporter':
                'Your support is paying for the servers and live data behind every board right now.',
            'support_money.profile.meta.supporter': 'Thank you for keeping Stationly free',
            'support_money.profile.cta.supporter': 'Support again',
            'support_money.sheet.custom': 'Choose your own amount',
            'support_money.sheet.custom_cta': 'Choose an amount',
            'support_money.sheet.custom_hint': 'Pick whatever amount feels right on the next screen.',
            'support_money.sheet.repeat': "You've supported us {n} times already. Genuinely, thank you.",
            'support_money.sheet.error':
                "Couldn't open checkout. Make sure you're signed in and try again.",
            // No `thanks.supporter` key any more. The reward screen used to
            // carry a SUPPORTER pill and a status line, which is a label where a
            // thank-you belongs: someone who has just given money does not need
            // to be told what they now count as.
            //
            // No dismiss LABEL either. The way out is a close icon, because a
            // worded button at the bottom of a celebration is one more thing to
            // read before you are allowed to leave.
            'support_money.thanks.close': 'Close',
            // Optional per-platform overrides (unset → the base keys above win).
            // 'home.promo.support_money.ios' / '.android' / '.web'
        };
    }
}
