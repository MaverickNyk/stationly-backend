/**
 * App theme tokens — the canonical Stationly palette served to the client.
 *
 * Architecture:
 *   - Android app boots with hardcoded defaults baked into the binary
 *     (see `StationlyUI/.../ui/theme/ThemeTokens.kt`). Those values are
 *     mirrored here in code; the two MUST stay in sync — if you change
 *     one, change the other in the same PR.
 *   - On launch the app fetches THIS endpoint and caches the response in
 *     SharedPrefs. The cached values overlay the app-side defaults on the
 *     NEXT cold launch — never mid-session (avoids jarring colour flips).
 *   - Offline / first-install: the app falls back to its hardcoded defaults,
 *     so this endpoint can be down without breaking the app.
 *
 * Why static defaults in code and not a JSON file or Firestore?
 *   - Matches the precedent set by `SduiService` (sduiService.ts) which
 *     hardcodes all layouts as TypeScript objects.
 *   - Tokens are small, change infrequently, deploy with the same cadence
 *     as the rest of the backend. A future move to Firestore would be
 *     trivial — same shape, different fetch.
 *
 * Token catalogue: see the `bucket` interface block below for the full
 * list (21 keys per theme + 2 constants). Each key is a hex string.
 */

/** A single bucket of overrides — one for `light`, one for `dark`. Every
 *  key is optional on the wire; the app fills in any missing key with its
 *  own hardcoded default. */
export interface ThemeBucket {
    canvas?: string;
    card?: string;
    cardElevated?: string;
    scrim?: string;

    textPrimary?: string;
    textMuted?: string;
    textSubtle?: string;

    borderSubtle?: string;
    borderStrong?: string;

    primary?: string;
    onPrimary?: string;
    primaryContainer?: string;
    onPrimaryContainer?: string;

    success?: string;
    warning?: string;
    error?: string;
    info?: string;
    due?: string;
    live?: string;
}

/** Theme-independent values — same in light and dark mode. */
export interface ThemeConstants {
    brandSignage?: string;   // TfL amber inside the dot-matrix board
    roundelRed?: string;     // Stationly logo / brand mark
}

export interface ThemeTokensPayload {
    id: string;              // always "app_theme_tokens"
    version: number;         // bump when tokens meaningfully change
    light: ThemeBucket;
    dark: ThemeBucket;
    constants: ThemeConstants;
}

export class ThemeService {
    /**
     * Returns the canonical app palette. Currently static; if you need
     * variant palettes (A/B test, by-country override, etc.) this is
     * the single place to fork the response.
     */
    static getAppThemeTokens(): ThemeTokensPayload {
        return {
            id: "app_theme_tokens",
            version: 1,
            dark: {
                canvas:             "#0A0A0A",
                card:               "#161616",
                cardElevated:       "#222222",
                scrim:              "#CC000000",

                textPrimary:        "#FFFFFF",
                textMuted:          "#B3FFFFFF",
                textSubtle:         "#73FFFFFF",

                borderSubtle:       "#1FFFFFFF",
                borderStrong:       "#59FFFFFF",

                primary:            "#FFC819",
                onPrimary:          "#000000",
                primaryContainer:   "#26FFC819",
                onPrimaryContainer: "#FFC819",

                success:            "#4ADE80",
                warning:             "#FFC819",
                error:              "#EF4444",
                info:               "#4A90D9",
                due:                "#FF5252",
                live:               "#4ADE80",
            },
            light: {
                canvas:             "#FAF7F0",
                card:               "#FFFFFF",
                cardElevated:       "#F0EAE0",
                scrim:              "#CC000000",

                textPrimary:        "#1A1A1A",
                textMuted:          "#5A5247",
                textSubtle:         "#995A5247",

                borderSubtle:       "#D8D0C0",
                borderStrong:       "#591A1A1A",

                primary:            "#8B5A0E",
                onPrimary:          "#FFFFFF",
                primaryContainer:   "#FAE6C2",
                onPrimaryContainer: "#5A3B00",

                success:            "#16A34A",
                warning:            "#B45309",
                error:              "#B42318",
                info:               "#1E40AF",
                due:                "#DC2626",
                live:               "#16A34A",
            },
            constants: {
                brandSignage:       "#FFC819",
                roundelRed:         "#DD2C33",
            },
        };
    }
}
