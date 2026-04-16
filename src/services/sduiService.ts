export interface SduiComponent {
    type: string;
    id?: string;
    text?: string;
    label?: string;
    placeholder?: string;
    style?: string; // e.g. title, subtitle, bold, error
    dataSourceUrl?: string; // For dropdowns
    dependsOn?: string; // For cascading dropdowns
    action?: string; // For buttons: e.g. SIGN_IN, REGISTER, SAVE_SELECTION
    color?: string; // hex code
    imageUrl?: string; // For image components
    textAlign?: string; // e.g. center
    options?: any[]; // For FlowPicker/GridPicker
    // New component fields (card, section, link_row, announcement)
    title?: string;
    subtitle?: string;
    body?: string;
    url?: string;
    icon?: string;
    components?: SduiComponent[];
    variant?: string;    // info | warning | tip
    dismissKey?: string;
    size?: number;
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
                    style: "email"
                },
                {
                    type: "input",
                    id: "password",
                    label: "Password",
                    placeholder: "Password",
                    style: "password"
                },
                {
                    type: "button",
                    id: "login_btn",
                    label: "Log In",
                    action: "LOGIN_ACTION",
                    color: "#FFB81C"
                },
                {
                    type: "button",
                    id: "forgot_password_nav",
                    label: "Forgot your password?",
                    action: "NAVIGATE_TO_FORGOT_PASSWORD",
                    color: "transparent"
                },
                {
                    type: "button",
                    id: "google_login_btn",
                    label: "Continue with Google",
                    action: "GOOGLE_LOGIN_ACTION",
                    color: "#FFFFFF"
                },
                {
                    type: "button",
                    id: "register_nav",
                    label: "Don't have an account? Sign up",
                    action: "NAVIGATE_TO_REGISTER",
                    color: "transparent"
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
                    style: "text"
                },
                {
                    type: "input",
                    id: "email",
                    label: "What's your email?",
                    placeholder: "Enter your email",
                    style: "email"
                },
                {
                    type: "input",
                    id: "password",
                    label: "Create a password",
                    placeholder: "Create a password",
                    style: "password"
                },
                {
                    type: "button",
                    id: "register_btn",
                    label: "Sign Up",
                    action: "REGISTER_ACTION",
                    color: "#FFB81C"
                },
                {
                    type: "button",
                    id: "login_nav",
                    label: "Already have an account? Log in",
                    action: "NAVIGATE_TO_LOGIN",
                    color: "transparent"
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
                    style: "email"
                },
                {
                    type: "button",
                    id: "reset_btn",
                    label: "Send Link",
                    action: "RESET_PASSWORD_ACTION",
                    color: "#FFB81C"
                },
                {
                    type: "button",
                    id: "login_nav",
                    label: "Remembered? Log in",
                    action: "NAVIGATE_TO_LOGIN",
                    color: "transparent"
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
                    imageUrl: user.photoURL || "https://img.icons8.com/bubbles/2x/user.png",
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
                        { type: "link_row", id: "website",  title: "Visit Website",    subtitle: "stationly.co.uk",            url: "https://stationly.co.uk",               icon: "public"      },
                        { type: "link_row", id: "privacy",  title: "Privacy Policy",   subtitle: "How we handle your data",     url: "https://stationly.co.uk/privacy",        icon: "privacy_tip" },
                        { type: "link_row", id: "terms",    title: "Terms of Service", subtitle: "Usage terms and conditions",  url: "https://stationly.co.uk/terms",          icon: "description" },
                        { type: "link_row", id: "contact",  title: "Contact Us",       subtitle: "Questions or feedback",       url: "mailto:hello@stationly.co.uk",           icon: "email"       },
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
                "explore.period.morning":     "Morning rush hour",
                "explore.period.morning_sub": "Expect busier trains",
                "explore.period.evening":     "Evening rush hour",
                "explore.period.evening_sub": "Expect busier trains",
                "explore.period.late_night":  "Late night service",
                "explore.period.late_night_sub": "Reduced frequency",
                "explore.period.night":       "Night service",
                "explore.period.night_sub":   "Reduced frequency",
                "explore.period.offpeak":     "Off-peak",
                "explore.period.offpeak_sub": "Normal frequency",
                // Top bar
                "topbar.live_label":          "Live Network",
                // Board card status placeholders
                "board.status_label":         "Status",
                "board.connecting_label":     "Connecting to TfL signals..."
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
                { type: "text", id: "screen_mode_title",    text: "Pick your\nchariot.",                style: "screen_title"    },
                { type: "text", id: "screen_mode_subtitle", text: "Bus, tube, or DLR — we're not judging.", style: "screen_subtitle" },
                { type: "dropdown", id: "mode", label: "1. Select Mode", style: "grid_picker", dataSourceUrl: "/modes" },

                // ── Screen 1 — Station picker (nearby shown by default, search bar always visible) ──
                { type: "text", id: "screen_station_title",    text: "Find Your Stop",                               style: "screen_title"    },
                { type: "text", id: "screen_station_subtitle", text: "Nearby stops shown first. Search to find others.", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "station", label: "2. Select Station",
                    dependsOn: "mode",
                    // lat / lon are resolved from ViewModel selections; falls back to text search
                    dataSourceUrl: "/stations/search?mode={mode}&lat={lat}&lon={lon}"
                },

                // ── Screen 2 — Line picker (filtered to lines at the selected station group) ──
                { type: "text", id: "screen_line_title",    text: "Select Line",       style: "screen_title"    },
                { type: "text", id: "screen_line_subtitle", text: "Lines stopping here.", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "line", label: "3. Select Line",
                    dependsOn: "station",
                    dataSourceUrl: "/lines/mode/{mode}?station={station}"
                },

                // ── Screen 3 — Direction picker ──
                { type: "text", id: "screen_direction_title",        text: "Which direction?",                  style: "screen_title"    },
                { type: "text", id: "screen_direction_subtitle",     text: "Which way are you fleeing today?",  style: "screen_subtitle" },
                { type: "text", id: "screen_direction_funfact_title", text: "Inbound vs Outbound — quick explainer", style: "info_card_title" },
                { type: "text", id: "screen_direction_funfact",
                  text: "Inbound = heading towards central London (Zone 1). Outbound = escaping the centre. TfL invented the terminology so you'd have something to debate at the bus stop.",
                  style: "info_card" },
                {
                    type: "dropdown", id: "direction", label: "4. Select Direction",
                    dependsOn: "line",
                    dataSourceUrl: "/lines/{line}/route"
                },

                // ── Save ──
                { type: "button", id: "save_button", label: "Set Up My Board", action: "SAVE_SELECTION_ACTION", color: "#FFB81C" }
            ]
        };
    }
}
