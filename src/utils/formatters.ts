/**
 * Tfl Data Formatter Utilities
 * Handles icons, labeling, and data transformation for SDUI.
 */

const MODE_ICONS: Record<string, string> = {
    'tube': '/icons/tube.png',
    'underground': '/icons/tube.png',
    'bus': '/icons/bus.png',
    'dlr': '/icons/dlr.png',
    'elizabeth-line': '/icons/elizabeth.png',
    'elizabeth': '/icons/elizabeth.png',
    'overground': '/icons/overground.png'
};

/**
 * Maps a TfL mode to its local icon path.
 */
export function getIconPath(modeName?: string): string | null {
    if (!modeName) return null;
    const m = modeName.toLowerCase();
    return MODE_ICONS[m] || null;
}

/**
 * Human-readable mode labels (e.g., 'elizabeth-line' -> 'Elizabeth Line')
 */
export function formatModeLabel(modeName?: string): string {
    if (!modeName) return "";
    return modeName
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Clean up destination names for better mobile UI fit
 */
export function formatDestination(name?: string): string {
    if (!name) return "";
    return name
        .replace(" Underground Station", "")
        .replace(" DLR Station", "")
        .replace(" Rail Station", "")
        .trim();
}

/** TfL placeholder strings meaning "no platform assigned yet". */
export function isUnassignedPlatform(platform: string | undefined): boolean {
    const rp = (platform ?? '').trim().toLowerCase();
    return !rp || rp === 'null' || rp === 'unknown' || rp === 'platform unknown' || rp === 'no platform';
}

/** The label formatPlatform emits for unassigned rail platforms — shared so
 *  filters matching on it can never drift from the display copy. */
export const UNASSIGNED_PLATFORM_LABEL = 'Platform not assigned';

/**
 * Format TfL platform string to a clean, displayable UI text.
 * Handles all TfL modes: tube, Elizabeth line (A/B), DLR, Overground, bus.
 */
export function formatPlatform(mode: string | undefined, platform: string | undefined): string {
    const isBus = mode?.toLowerCase() === 'bus';

    if (isUnassignedPlatform(platform)) {
        // Unassigned bus stop → empty (the client renders just the line, no
        // confusing "Stop not assigned"). Rail keeps a presentable label.
        return isBus ? '' : UNASSIGNED_PLATFORM_LABEL;
    }

    let p = platform!.trim();

    if (isBus) {
        const stripped = p.toLowerCase().startsWith('stop ') ? p.substring(5).trim() : p;
        return `Stop ${stripped.toUpperCase()}`;
    }

    if (p.includes(' - ')) {
        const parts = p.split(' - ');
        if (parts.length >= 2) {
            const desc = parts[0].trim();
            let plat = parts[1].trim();
            if (!plat.toLowerCase().startsWith('platform')) {
                plat = `Platform ${plat}`;
            }
            return `${plat} (${desc})`;
        }
    }

    if (/^\d+$/.test(p)) return `Platform ${p}`;
    if (/^plat \d+$/i.test(p)) return p.replace(/^plat /i, 'Platform ');

    // Short platform code: single letter (Elizabeth "A"/"B", Overground "D")
    // or digit+letter suffix (DLR "4a") — TfL returns these raw without "Platform" prefix
    if (/^[A-Za-z]$/.test(p) || /^\d+[A-Za-z]+$/.test(p)) return `Platform ${p.toUpperCase()}`;

    return p;
}

export function getEnv(): 'staging' | 'production' {
    return process.env.APP_ENV === 'staging' ? 'staging' : 'production';
}

export function isStaging(): boolean {
    return getEnv() === 'staging';
}

export function getBaseUrl(): string {
    return process.env.APP_BASE_URL || "https://api.stationly.co.uk";
}

export function getWebUrl(): string {
    return process.env.APP_WEB_URL || "https://stationly.co.uk";
}

/**
 * The custom URL scheme THIS environment's app answers to.
 *
 * Per-environment by construction, the same rule the iOS client follows
 * (`STATIONLY_URL_SCHEME` in its Info.plist): staging builds register
 * `stationly-staging://`, production `stationly://`. A hardcoded `"stationly"`
 * in a redirect silently drops every staging deep link — the bug the client
 * fixed once already. `STATIONLY_URL_SCHEME` overrides for a one-off (a rename
 * in flight, a TestFlight-only scheme).
 */
export function getUrlScheme(): string {
    const override = process.env.STATIONLY_URL_SCHEME;
    if (override && override.trim() !== '') return override.trim();
    return isStaging() ? 'stationly-staging' : 'stationly';
}

/**
 * Returns the fully qualified icon URL for a mode
 */
export function getIconUrl(modeName?: string): string | null {
    const path = getIconPath(modeName);
    if (!path) return null;
    return `${getBaseUrl()}${path}`;
}
