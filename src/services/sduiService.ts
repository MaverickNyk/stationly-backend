import { getWebUrl, isStaging } from '../utils/formatters';

export interface SduiValidation {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: string;       // regex string — client applies via platform engine
    errorMessage?: string;  // shown to user on failure
}

export interface SduiCondition {
    dependsOn: string;
    operator: "not_empty" | "equals" | "empty";
    value?: string;
}

export interface SduiComponent {
    type: string;
    id?: string;
    text?: string;
    label?: string;
    placeholder?: string;
    helpText?: string;
    style?: string;
    dataSourceUrl?: string;
    dependsOn?: string;
    action?: string;
    color?: string;
    imageUrl?: string;
    textAlign?: string;
    options?: any[];
    title?: string;
    subtitle?: string;
    body?: string;
    url?: string;
    icon?: string;
    components?: SduiComponent[];
    variant?: string;       // button: primary | secondary | ghost | danger  |  announcement: info | warning | tip
    dismissKey?: string;
    size?: number;
    validation?: SduiValidation;
    condition?: SduiCondition;
}

export interface SduiLayout {
    id: string;
    version?: string;
    title: string;
    theme: {
        primaryColor: string;
        backgroundColor: string;
    };
    loadingMessage?: string;
    successMessage?: string;
    components: SduiComponent[];
}

export class SduiService {
    /**
     * Layout for the Login Screen
     */
    /**
     * Layout for the Login Screen - Spotify Style
     */
    static getLoginLayout(): SduiLayout {
        return {
            id: "login_screen",
            title: "Sign In",
            theme: {
                primaryColor: "#FFB81C",
                backgroundColor: "#000000"
            },
            components: [
                {
                    type: "image",
                    id: "logo",
                    imageUrl: "stationly_logo", // Mapping to local resource
                    style: "logo",
                    textAlign: "center"
                },
                {
                    type: "text",
                    id: "login_header",
                    text: "Sign in to Stationly",
                    style: "title",
                    textAlign: "center"
                },
                {
                    type: "input",
                    id: "email",
                    label: "Email or username",
                    placeholder: "Email or username",
                    style: "email",
                    validation: { required: true, errorMessage: "Please enter your email." }
                },
                {
                    type: "input",
                    id: "password",
                    label: "Password",
                    placeholder: "Password",
                    style: "password",
                    validation: { required: true, minLength: 6, errorMessage: "Please enter your password." }
                },
                {
                    type: "button",
                    id: "login_btn",
                    label: "Log In",
                    action: "LOGIN_ACTION",
                    color: "#FFB81C",
                    variant: "primary"
                },
                {
                    type: "button",
                    id: "forgot_password_nav",
                    label: "Forgot your password?",
                    action: "NAVIGATE_TO_FORGOT_PASSWORD",
                    variant: "ghost"
                },
                {
                    type: "button",
                    id: "google_login_btn",
                    label: "Continue with Google",
                    action: "GOOGLE_LOGIN_ACTION",
                    color: "#FFFFFF",
                    variant: "secondary"
                },
                {
                    type: "button",
                    id: "register_nav",
                    label: "Don't have an account? Sign up",
                    action: "NAVIGATE_TO_REGISTER",
                    variant: "ghost"
                }
            ]
        };
    }

    /**
     * Layout for the Register Screen
     */
    static getRegisterLayout(): SduiLayout {
        return {
            id: "register_screen",
            title: "Sign Up",
            theme: {
                primaryColor: "#FFB81C",
                backgroundColor: "#000000"
            },
            components: [
                {
                    type: "image",
                    id: "logo",
                    imageUrl: "stationly_logo",
                    style: "logo",
                    textAlign: "center"
                },
                {
                    type: "text",
                    id: "register_header",
                    text: "Create a free account",
                    style: "title",
                    textAlign: "center"
                },
                {
                    type: "input",
                    id: "displayName",
                    label: "What's your name?",
                    placeholder: "Enter your name",
                    style: "text",
                    validation: { required: true, errorMessage: "Please enter your name." }
                },
                {
                    type: "input",
                    id: "email",
                    label: "What's your email?",
                    placeholder: "Enter your email",
                    style: "email",
                    validation: {
                        required: true,
                        pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
                        errorMessage: "Please enter a valid email address."
                    }
                },
                {
                    type: "input",
                    id: "password",
                    label: "Create a password",
                    placeholder: "Create a password",
                    style: "password",
                    helpText: "Must be at least 8 characters",
                    validation: { required: true, minLength: 8, errorMessage: "Password must be at least 8 characters." }
                },
                {
                    type: "button",
                    id: "register_btn",
                    label: "Sign Up",
                    action: "REGISTER_ACTION",
                    color: "#FFB81C",
                    variant: "primary"
                },
                {
                    type: "button",
                    id: "login_nav",
                    label: "Already have an account? Log in",
                    action: "NAVIGATE_TO_LOGIN",
                    variant: "ghost"
                }
            ]
        };
    }

    /**
     * Layout for Forgot Password Screen
     */
    static getForgotPasswordLayout(): SduiLayout {
        return {
            id: "forgot_password_screen",
            title: "Reset Password",
            theme: {
                primaryColor: "#FFB81C",
                backgroundColor: "#000000"
            },
            components: [
                {
                    type: "image",
                    id: "logo",
                    imageUrl: "stationly_logo",
                    style: "logo",
                    textAlign: "center"
                },
                {
                    type: "text",
                    id: "forgot_header",
                    text: "Recover Access",
                    style: "title",
                    textAlign: "center"
                },
                {
                    type: "text",
                    id: "forgot_subtitle",
                    text: "Enter your email address to receive a recovery link.",
                    style: "subtitle",
                    textAlign: "center"
                },
                {
                    type: "input",
                    id: "email",
                    label: "Email address",
                    placeholder: "Email address",
                    style: "email",
                    validation: {
                        required: true,
                        pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
                        errorMessage: "Please enter a valid email address."
                    }
                },
                {
                    type: "button",
                    id: "reset_btn",
                    label: "Send Link",
                    action: "RESET_PASSWORD_ACTION",
                    color: "#FFB81C",
                    variant: "primary"
                },
                {
                    type: "button",
                    id: "login_nav",
                    label: "Remembered? Log in",
                    action: "NAVIGATE_TO_LOGIN",
                    variant: "ghost"
                }
            ]
        };
    }

    /**
     * Layout for User Profile Screen
     */
    static getProfileLayout(user: any): SduiLayout {
        return {
            id: "profile_screen",
            title: "Your Account",
            theme: {
                primaryColor: "#FFB81C",
                backgroundColor: "#000000"
            },
            components: [
                {
                    type: "image",
                    id: "profile_pic",
                    imageUrl: user.photoURL || null,
                    style: "circle"
                },
                {
                    type: "text",
                    id: "user_name",
                    text: user.displayName || "Stationly User",
                    style: "bold"
                },
                {
                    type: "text",
                    id: "user_email",
                    text: user.email,
                    style: "subtitle"
                },
                {
                    type: "input",
                    id: "address",
                    label: "Current Address",
                    placeholder: "123 London Rd, NW1",
                    text: user.address || "",
                    style: "address"
                },
                {
                    type: "button",
                    id: "update_profile",
                    label: "Save Changes",
                    action: "UPDATE_PROFILE_ACTION",
                    color: "#FFB81C"
                },
                {
                    type: "button",
                    id: "logout_btn",
                    label: "Sign Out",
                    action: "LOGOUT_ACTION",
                    color: "#FF5252"
                }
            ]
        };
    }

    /**
     * About Stationly — static content for the profile About section
     */
    static getAboutLayout(): SduiLayout {
        const webUrl = getWebUrl();
        return {
            id: "about_screen",
            title: "About",
            theme: { primaryColor: "#FFB81C", backgroundColor: "#000000" },
            components: [
                {
                    type: "card",
                    id: "about_info",
                    title: "Stationly",
                    body: "Real-time London transport departures at your fingertips. Track buses, tubes, DLR, and Overground — all from one board.",
                    style: "brand"
                },
                {
                    type: "section",
                    id: "links_section",
                    components: [
                        { type: "link_row", id: "website",  title: "Visit Website",    subtitle: "stationly.co.uk",            url: webUrl,                                  icon: "public"      },
                        { type: "link_row", id: "privacy",  title: "Privacy Policy",   subtitle: "How we handle your data",     url: `${webUrl}/privacy`,                     icon: "privacy_tip" },
                        { type: "link_row", id: "terms",    title: "Terms of Service", subtitle: "Usage terms and conditions",  url: `${webUrl}/terms`,                       icon: "description" },
                        { type: "link_row", id: "contact",  title: "Contact Us",       subtitle: "Questions or feedback",       url: "mailto:info@stationly.co.uk",            icon: "email"       },
                        { type: "link_row", id: "rate",     title: "Rate Stationly",   subtitle: "Love the app? Let us know",   url: "market://details?id=com.stationly.mobile", icon: "star"     }
                    ]
                },
                {
                    type: "card",
                    id: "acknowledgements",
                    body: "Powered by TfL Open Data. Contains OS data \u00a9 Crown copyright and database rights 2025. Neither TfL nor the UK Government endorse this app.",
                    style: "subtle"
                }
            ]
        };
    }

    /**
     * Home announcement banner — leave components empty for no active announcement.
     * To push a banner, add an announcement component here and deploy.
     */
    static getHomeAnnouncement(): SduiLayout {
        return {
            id: "home_announcement",
            title: "Announcements",
            theme: { primaryColor: "#FFB81C", backgroundColor: "#000000" },
            components: [
                ...(isStaging() ? [{
                    type: "announcement",
                    id: "staging_env_banner",
                    title: "Staging Environment",
                    body: "You are connected to the staging server. Data and behaviour may differ from production.",
                    variant: "warning",
                    dismissKey: undefined
                }] : [])
                // Example (uncomment to activate):
                // {
                //     type: "announcement",
                //     id: "maintenance_notice",
                //     title: "Planned Maintenance",
                //     body: "TfL data feeds may be intermittent on Sunday 13 Apr between 02:00–06:00.",
                //     variant: "warning",
                //     dismissKey: "maintenance_2026_04_13"
                // }
            ]
        };
    }

    /**
     * Flat string map controlling all hardcoded labels in the home / empty-state / explore UI.
     * Update any value here and it takes effect on next app launch — no app update required.
     */
    static getHomeConfig(): object {
        return {
            id: "home_config",
            strings: {
                // Empty state screen
                "empty.title":    "Your board is empty",
                "empty.subtitle": "Pick a station and we\u2019ll show you live\ndepartures \u2014 just like the real board.",
                "empty.cta":      "Set Up My Board",
                "empty.chips":    "Tube,Bus,DLR,Overground",
                "empty.footer":   "Powered by TfL Open Data",
                // Summary header
                "greeting.morning":   "Good morning",
                "greeting.afternoon": "Good afternoon",
                "greeting.evening":   "Good evening",
                "greeting.night":     "Good night",
                "header.location":    "London",
                // Explore / Network section
                "explore.title":              "Network",
                "explore.good_service":       "Good Service",
                "explore.good_service_sub":   "All lines running normally",
                "explore.disruptions_sub":    "Delays on network",
                "explore.disruptions_label":  "Disruption",        // client appends count + pluralises
                // Fares card (Peak / Off-Peak). Times are fixed by TfL fare rules
                // (Mon–Fri 06:30–09:30 + 16:00–19:00) and live in the Android client;
                // these strings just control labels + copy.
                "explore.fares.peak.title":              "Peak Hours",
                "explore.fares.peak.subtitle_prefix":    "Pricier fares · until ",
                "explore.fares.offpeak.title":           "Off-Peak",
                "explore.fares.offpeak.subtitle_prefix": "Cheaper fares · until ",
                "explore.fares.dialog.title.peak":       "Rush hour for your wallet too.",
                "explore.fares.dialog.title.offpeak":    "You’re riding cheap.",
                "explore.fares.dialog.body.peak":        "Tap in right now and you’ll pay TfL’s peak fare. Prices drop at 09:30 (or at 19:00 in the evening) — and weekends are always off-peak.\n\nPeak windows are Mon–Fri, 06:30–09:30 and 16:00–19:00. Same trains either side, just a few quid lighter outside the window.",
                "explore.fares.dialog.body.offpeak":     "Right now London’s letting you off easy — every Tube tap is at the off-peak rate.\n\nPeak fares only apply Mon–Fri, 06:30–09:30 and 16:00–19:00. Weekends and bank holidays are off-peak all day. Same trains, less money. Stationly approves.",
                "explore.fares.dialog.link":             "See TfL fares",
                "explore.fares.dialog.dismiss":          "Got it",
                "explore.fares.tflUrl":                  "https://tfl.gov.uk/fares/find-fares/tube-and-rail-fares",
                // CSV of YYYY-MM-DD dates (UK bank holidays — England & Wales).
                // On these dates the Fares card stays Off-Peak all day. The Android
                // client carries the same list as a baked-in fallback so accuracy
                // doesn't depend on a fresh config fetch; the remote value wins when
                // populated. Top up roughly once a year from https://www.gov.uk/bank-holidays
                "explore.fares.bankHolidays":            [
                    "2026-01-01","2026-04-03","2026-04-06","2026-05-04","2026-05-25",
                    "2026-08-31","2026-12-25","2026-12-28",
                    "2027-01-01","2027-03-26","2027-03-29","2027-05-03","2027-05-31",
                    "2027-08-30","2027-12-27","2027-12-28",
                ].join(","),
                // Top bar
                "topbar.live_label":          "Live Network",
                // Board card status row — always visible to keep board size
                // stable; shows real line status when available, "Good Service"
                // as the default. The "we have no data right now" cases live
                // in the board.fallback.* family below and render inside the
                // dot-matrix rows themselves on home / dream / widget.
                "board.status_label":         "Status",
                "board.status_failed_label":  "Status unavailable — pull down to retry",
                "board.good_service_label":   "Good Service",      // default when no lineStatus has arrived yet
                // ── Board fallback panel (unified across home / dream / widget) ──
                // Title + detail surface in the empty-board slot when there's
                // nothing to render. Detection happens client-side; only the
                // copy + thresholds are server-driven.
                // Copy is kept tight (≤ ~30 chars per line) so it fits one
                // line on a ~260dp widget cell without truncation. Anything
                // longer would clip with "..." on widget row width.
                "board.fallback.offline.title":          "Offline",
                "board.fallback.offline.detail":         "Catching up when you’re back",
                "board.fallback.signal_lost.title":      "Live updates paused",
                "board.fallback.signal_lost.detail":     "Last refresh {age} ago",            // {age} placeholder
                "board.fallback.late_night.title":       "Service ended for tonight",
                "board.fallback.late_night.detail":      "Back in the morning",
                "board.fallback.early_morning.title":    "Service starting soon",
                "board.fallback.early_morning.detail":   "First departures incoming",
                "board.fallback.no_upcoming.title":      "Nothing departing right now",
                "board.fallback.no_upcoming.detail":     "Watching for the next one",
                "board.fallback.connecting.title":       "Connecting",
                "board.fallback.connecting.detail":      "Live data starting up",
                // DISRUPTED: title is normally the live TfL severity (e.g.
                // "Part Closure", "Severe Delays"); these defaults only kick
                // in if TfL sends back blank severity text. `\n` in detail
                // splits across two rows in the client.
                "board.fallback.disrupted.title":        "Service disrupted",
                "board.fallback.disrupted.detail":       "No departures expected here\nWe’ll update as things change",
                // Tunable thresholds (string-encoded for the homeConfig flat map)
                "board.fallback.signalLostMin":          "6",          // minutes since last FCM before "Live updates paused"
                "board.fallback.lateNightStart":        "00:00",       // start of "ended for tonight" window (Europe/London)
                "board.fallback.lateNightEnd":         "04:30",        // late night → early morning cutoff
                "board.fallback.earlyMorningEnd":      "06:00",        // early morning → "no upcoming" cutoff
                // ── Force-update gate ──────────────────────────────────────────
                // Bump app.minVersion to block older clients immediately — no release needed.
                "app.minVersion": "1.0",
                "app.storeUrl":   "https://play.google.com/store/apps/details?id=com.stationly.mobile",
                "app.update.title":   "New update available",
                "app.update.message": "Update Stationly for the latest features and improvements.",
                "app.update.cta":     "Update Now",
                "app.update.dismiss": "Maybe Later",
                // ── Station label templates (widget + fullscreen dream) ───────
                // Drives the line-prefix shown on platform-header rows
                // ("Piccadilly: Platform 1", "Bus 39: …", "DLR: …").
                // Client substitutes {line} with the formatted line name; bus
                // line ids get uppercased so "n30" → "N30". Mode-specific
                // templates win over `default`.
                "station.label.bus":             "Bus {line}",
                "station.label.dlr":             "DLR",
                "station.label.elizabeth":       "Elizabeth",
                "station.label.elizabeth-line":  "Elizabeth",
                "station.label.default":         "{line}",       // tube, overground, tram, national-rail, …
                // Mode display names — used in the line-status dialog and
                // anywhere we need a human-readable mode string. Add a key
                // for any new TfL mode we start supporting.
                "station.mode.tube":             "Tube",
                "station.mode.overground":       "Overground",
                "station.mode.dlr":              "DLR",
                "station.mode.elizabeth":        "Elizabeth line",
                "station.mode.elizabeth-line":   "Elizabeth line",
                "station.mode.tram":             "Tram",
                "station.mode.national-rail":    "National Rail",
                "station.mode.bus":              "Bus",
                "station.mode.river-bus":        "River Bus",
                "station.mode.cable-car":        "Cable Car",
                // ── Home promo banners (widget + screensaver) ─────────────────
                // Each has a `show` master switch so we can kill the banner
                // server-side if it ever feels noisy. Defaults still ship on
                // the client for offline first-launch safety.
                "home.promo.widget.show":        "true",
                "home.promo.widget.title":       "Add a home screen widget",
                "home.promo.widget.subtitle":    "Pin your live board for one-tap glances — no need to open the app",
                "home.promo.widget.cta":         "Add",
                "home.promo.dream.show":         "true",
                "home.promo.dream.title":        "Set as Screensaver",
                "home.promo.dream.subtitle":     "Live departures when docked or charging",
                "home.promo.dream.cta":          "Set up",
                // Notification-permission denied banner — surfaces when the
                // user has been asked for POST_NOTIFICATIONS and denied (or
                // toggled it off later in system Settings). Without this nudge
                // every line-status auto-alert silently no-ops inside
                // NotificationDispatcher. Same `show` kill-switch shape as the
                // promo banners above so it can be suppressed server-side.
                "home.notif_denied.show":        "true",
                "home.notif_denied.title":       "Turn on notifications",
                "home.notif_denied.subtitle":    "Stationly can alert you when your line has delays, closures, or recovers.",
                "home.notif_denied.cta":         "Enable",
                // ── Dream settings screen ─────────────────────────────────────
                // Labels for the Daydream configuration activity launched
                // from system Settings → Display → Screen saver.
                "dream.settings.title":                            "Screensaver",
                "dream.settings.section.layout":                   "Layout",
                "dream.settings.section.theme":                    "Theme",
                "dream.settings.section.clock":                    "Clock style",
                "dream.settings.section.station":                  "Station to display",
                "dream.settings.layout.clock_and_board.name":      "Clock + Board",
                "dream.settings.layout.clock_and_board.desc":      "Big clock with departure board alongside",
                "dream.settings.layout.fullscreen_board.name":     "Fullscreen Board",
                "dream.settings.layout.fullscreen_board.desc":     "Just the departure board, filling the screen",
                "dream.settings.theme.system":                     "System",
                "dream.settings.theme.light":                      "Light",
                "dream.settings.theme.dark":                       "Dark",
                "dream.settings.clock.digital":                    "Digital",
                "dream.settings.clock.analog":                     "Analog",
                "dream.settings.station.auto.title":               "Auto",
                "dream.settings.station.auto.subtitle":            "Match the top board on your home screen",
                // ── Profile screen ─────────────────────────────────────────────
                "profile.stations.title":            "My Stations",
                "profile.stations.empty_title":      "No stations yet",
                "profile.stations.empty_subtitle":   "Set up a board to start tracking departures",
                "profile.about.title":               "About Stationly",
                "profile.signout.label":             "Sign Out",
                // Delete station dialog
                "profile.delete_station.title":      "Delete This Board?",
                "profile.delete_station.body":       "You\u2019re about to remove your {name} board.",
                "profile.delete_station.bullets":    "Live departure tracking will stop,Departure notifications will be unsubscribed,Widget will be cleared",
                "profile.delete_station.footer":     "You can always set up a new board from the home screen.",
                "profile.delete_station.confirm":    "Delete Board",
                "profile.delete_station.cancel":     "Keep It",
                // Delete account dialog
                "profile.delete_account.title":      "Delete Your Account?",
                "profile.delete_account.intro":      "This action is permanent and cannot be undone. You will lose:",
                "profile.delete_account.bullets":    "All your saved stations and boards,Your notification preferences,Your profile and account data",
                "profile.delete_account.footer":     "You\u2019ll need to create a new account to use Stationly again.",
                "profile.delete_account.confirm":    "Delete Permanently",
                "profile.delete_account.cancel":     "Keep Account"
            }
        };
    }

    /**
     * Unified station selection layout.
     * Flow: Mode → Station (nearby + search) → Line → Direction
     * The old track / flow_picker logic has been removed; discovery and manual are now one flow.
     * `track` param is accepted but ignored so old clients with the query-string don't break.
     */
    static getSelectionLayout(_track?: string): SduiLayout {
        return {
            id: "station_selection_screen",
            version: "unified-2.0",
            title: "Stationly Setup",
            theme: { primaryColor: "#FFB81C", backgroundColor: "#000000" },
            loadingMessage: "Configuring layout...",
            successMessage: "Your Board is now active!",
            components: [
                // ── Screen 0 — Mode picker ──
                // Copy is interpolated on the client: {mode} → mode label,
                // {station}/{line} → the chosen names, and the mode-correct
                // nouns {stop} (station|stop), {lines} (Lines|Routes),
                // {line_noun} (line|route), {vehicle} (Trains|Buses). Change
                // any wording here — no app release needed.
                { type: "text", id: "screen_mode_title",    text: "How are you travelling?",        style: "screen_title"    },
                { type: "text", id: "screen_mode_subtitle", text: "Pick a transport mode to track.", style: "screen_subtitle" },
                { type: "dropdown", id: "mode", label: "1. Select Mode", style: "grid_picker", dataSourceUrl: "/modes" },

                // ── Screen 1 — Station picker (nearby shown by default, search bar always visible) ──
                { type: "text", id: "screen_station_title",    text: "Find a {mode} {stop}",                 style: "screen_title"    },
                { type: "text", id: "screen_station_subtitle", text: "Nearby {stop}s first, or search for another.", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "station", label: "2. Select Station",
                    dependsOn: "mode",
                    // lat / lon are resolved from ViewModel selections; falls back to text search
                    dataSourceUrl: "/stations/search?mode={mode}&lat={lat}&lon={lon}"
                },

                // ── Screen 2 — Line picker (filtered to lines at the selected station group) ──
                { type: "text", id: "screen_line_title",    text: "{lines} from {station}",         style: "screen_title"    },
                { type: "text", id: "screen_line_subtitle", text: "Which {line_noun} are you taking?", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "line", label: "3. Select Line",
                    dependsOn: "station",
                    dataSourceUrl: "/lines/mode/{mode}?station={station}"
                },

                // ── Screen 3 — Direction picker ──
                { type: "text", id: "screen_direction_title",        text: "Which direction?",       style: "screen_title"    },
                { type: "text", id: "screen_direction_subtitle",     text: "{vehicle} from {station}", style: "screen_subtitle" },
                // Direction-card chrome labels (client renders the route response;
                // these let the wording be tuned from the backend). {dest} is
                // interpolated with the tapped destination's name.
                { type: "text", id: "dir_towards_label",     text: "towards",            style: "label" },
                { type: "text", id: "dir_stations_label",    text: "STATIONS THIS WAY",  style: "label" },
                { type: "text", id: "dir_stations_to_label", text: "STATIONS TO {dest}", style: "label" },
                { type: "text", id: "dir_split_hint",        text: "This direction splits — tap a destination above to see its full line of stops.", style: "label" },
                {
                    type: "dropdown", id: "direction", label: "4. Select Direction",
                    dependsOn: "line",
                    dataSourceUrl: "/lines/{line}/route?station={station}&mode={mode}"
                },

                // ── Save ──
                { type: "button", id: "save_button", label: "Set Up My Board", action: "SAVE_SELECTION_ACTION", color: "#FFB81C" }
            ]
        };
    }
}
