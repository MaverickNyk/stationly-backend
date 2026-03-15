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
 * Returns the fully qualified icon URL for a mode
 */
export function getIconUrl(modeName?: string): string | null {
    const path = getIconPath(modeName);
    if (!path) return null;
    
    // Use environment variable for base URL if available, else default to production domain
    const baseUrl = process.env.APP_BASE_URL || "https://api.stationly.co.uk";
    return `${baseUrl}${path}`;
}
