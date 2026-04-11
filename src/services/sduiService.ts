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
     * Layout for the station selection flow (Switchable based on track)
     */
    static getSelectionLayout(track: string = 'manual'): SduiLayout {
        const isDiscovery = track === 'discovery';

        const commonHeader = [
            // Screen 0 — Mode picker
            { type: "text", id: "screen_mode_title", text: "Pick your\nchariot.", style: "screen_title" },
            { type: "text", id: "screen_mode_subtitle", text: "Bus, tube, or DLR — we're not judging.", style: "screen_subtitle" },
            { type: "dropdown", id: "mode", label: "1. Select Mode", style: "grid_picker", dataSourceUrl: "/modes" },
            // Screen 1 — Flow picker
            { type: "text", id: "screen_flow_title", text: "Where's your usual haunt?", style: "screen_title" },
            { type: "text", id: "screen_flow_subtitle", text: "Pick how you'd like to find your stop.", style: "screen_subtitle" },
            {
                type: "flow_picker", id: "tracking_flow", label: "How should we locate it?", dependsOn: "mode",
                options: [
                    { id: "discovery", label: "Near Me", icon: "gps_fixed", description: "GPS'll sort it" },
                    { id: "manual", label: "Browse Network", icon: "search", description: "I'll find my own way, cheers" }
                ]
            }
        ];

        let specificComponents: SduiComponent[] = [];

        if (isDiscovery) {
            // Discovery: FLOW -> STATION -> LINE -> DIRECTION
            specificComponents = [
                // Screen 2 — Nearby stations
                { type: "text", id: "screen_station_title", text: "Nearby Stations", style: "screen_title" },
                { type: "text", id: "screen_station_subtitle", text: "Closest escape routes first.", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "station", label: "2. Select Station",
                    dependsOn: "tracking_flow",
                    dataSourceUrl: "/stations/search?mode={mode}&lat={lat}&lon={lon}"
                },
                // Screen 3 — Line
                { type: "text", id: "screen_line_title", text: "Select Line", style: "screen_title" },
                { type: "text", id: "screen_line_subtitle", text: "Lines stopping here.", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "line", label: "3. Select Line",
                    dependsOn: "station",
                    dataSourceUrl: "/lines/mode/{mode}?station={station}"
                },
                // Screen 4 — Direction
                { type: "text", id: "screen_direction_title", text: "Which direction?", style: "screen_title" },
                { type: "text", id: "screen_direction_subtitle", text: "Which way are you fleeing today?", style: "screen_subtitle" },
                { type: "text", id: "screen_direction_funfact_title", text: "Inbound vs Outbound — quick explainer", style: "info_card_title" },
                { type: "text", id: "screen_direction_funfact", text: "Inbound = heading towards central London (Zone 1). Outbound = escaping the centre. TfL invented the terminology so you'd have something to debate at the bus stop.", style: "info_card" },
                {
                    type: "dropdown", id: "direction", label: "4. Select Direction",
                    dependsOn: "line",
                    dataSourceUrl: "/lines/{line}/route"
                }
            ];
        } else {
            // Manual: FLOW -> LINE -> DIRECTION -> STATION
            specificComponents = [
                // Screen 2 — Line
                { type: "text", id: "screen_line_title", text: "Which line?", style: "screen_title" },
                { type: "text", id: "screen_line_subtitle", text: "Which line do you cling to daily?", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "line", label: "2. Select Line",
                    dependsOn: "tracking_flow",
                    dataSourceUrl: "/lines/mode/{mode}"
                },
                // Screen 3 — Direction
                { type: "text", id: "screen_direction_title", text: "Which direction?", style: "screen_title" },
                { type: "text", id: "screen_direction_subtitle", text: "Which way are you fleeing today?", style: "screen_subtitle" },
                { type: "text", id: "screen_direction_funfact_title", text: "Inbound vs Outbound — quick explainer", style: "info_card_title" },
                { type: "text", id: "screen_direction_funfact", text: "Inbound = heading towards central London (Zone 1). Outbound = escaping the centre. TfL invented the terminology so you'd have something to debate at the bus stop.", style: "info_card" },
                {
                    type: "dropdown", id: "direction", label: "3. Select Direction",
                    dependsOn: "line",
                    dataSourceUrl: "/lines/{line}/route"
                },
                // Screen 4 — Station
                { type: "text", id: "screen_station_title", text: "Pick your stop.", style: "screen_title" },
                { type: "text", id: "screen_station_subtitle", text: "Your daily departure point awaits.", style: "screen_subtitle" },
                {
                    type: "dropdown", id: "station", label: "4. Select Station",
                    dependsOn: "direction",
                    dataSourceUrl: "/stations/search?searchKey={line}_{direction}"
                }
            ];
        }

        return {
            id: "station_selection_screen",
            version: isDiscovery ? "discovery-1.5" : "manual-1.5",
            title: "Stationly Setup",
            theme: { primaryColor: "#FFB81C", backgroundColor: "#000000" },
            loadingMessage: "Configuring layout...",
            successMessage: "Your Board is now active!",
            components: [
                ...commonHeader,
                ...specificComponents,
                {
                    type: "button", id: "save_button", label: "Set Up My Board",
                    action: "SAVE_SELECTION_ACTION", color: "#FFB81C"
                }
            ]
        };
    }
}
