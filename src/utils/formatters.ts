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

/**
 * Format TfL platform string to a clean, displayable UI text.
 * Handles all TfL modes: tube, Elizabeth line (A/B), DLR, Overground, bus.
 */
export function formatPlatform(mode: string | undefined, platform: string | undefined): string {
    const isBus = mode?.toLowerCase() === 'bus';
    const rp = (platform ?? '').trim().toLowerCase();

    if (!rp || rp === 'null' || rp === 'unknown' || rp === 'platform unknown' || rp === 'no platform') {
        return isBus ? 'Stop not assigned' : 'Platform not assigned';
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

/**
 * Returns the fully qualified icon URL for a mode
 */
export function getIconUrl(modeName?: string): string | null {
    const path = getIconPath(modeName);
    if (!path) return null;
    
    // Use environment variable for base URL if available, else default to production domain
    const baseUrl = process.env.APP_BASE_URL || "https://api.stationly.co.uk";
    return `${baseUrl}${path}`;
}
