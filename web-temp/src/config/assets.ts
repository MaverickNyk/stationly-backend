/**
 * Every image URL the kiosk uses, in one file.
 *
 * There are exactly two kinds, and the difference is the whole reason this
 * module exists:
 *
 *  - **The backend's artwork** (`/icons/...`) - absolute, NOT prefixed by
 *    Vite's `base`, because the backend owns that path and it does not move
 *    when the kiosk's mount path does.
 *  - **This app's own assets** (`stationly-mark.png`, the QR) - served from
 *    `public/`, so they DO take `base`.
 *
 * Getting that backwards is silent: the image just 404s on a wall display
 * nobody is looking closely at. Written down once here so it can only be got
 * right.
 *
 * ## Where the mode artwork comes from
 *
 * **Not from `web-temp/public/`.** These are the BACKEND's files, served from
 * `/icons/<mode>.png` on this same origin — which is one of the things hosting
 * inside the backend buys us. They are the identical files the app's
 * notification large-icons use, so the café wall, the phone's notification
 * shade and the app all agree on what an Overground station looks like.
 *
 * They used to be copied into this folder's `public/` as well, which meant the
 * same 334 KB of PNGs existed twice in the repo and shipped twice in `dist/`,
 * with two components disagreeing about which copy to load — `ModeRoundel`
 * read the backend's, `NetworkStatusPanel` read the duplicate. A change to a
 * roundel would have updated one and not the other.
 *
 * ## The one thing to change on extraction
 * This path is absolute and unprefixed, so it does NOT follow Vite's `base` —
 * correct today (the backend owns `/icons`, and it does not move when the
 * kiosk's mount path does) and wrong the moment this leaves the process. That
 * is the whole reason the path is written down once, here, instead of inline at
 * each `<img>`: extraction points `ICON_BASE` at the backend's public origin and
 * nothing else changes. The dev proxy in `vite.config.ts` already forwards
 * `/icons` for the same reason.
 */
const ICON_BASE = '/icons';

/** Mode name (as the backend reports it) → the artwork that exists for it. */
const MODE_ICONS: Record<string, string> = {
    tube: 'tube',
    underground: 'tube',
    overground: 'overground',
    dlr: 'dlr',
    elizabeth: 'elizabeth',
    'elizabeth-line': 'elizabeth',
    bus: 'bus',
};

/** The roundel for a mode, or null when there is no artwork for it — tram and
 *  national-rail have none today, and callers draw a coloured ring instead of
 *  a broken image. */
export function modeIconUrl(mode: string | undefined): string | null {
    const icon = mode ? MODE_ICONS[mode.toLowerCase()] : undefined;
    return icon ? `${ICON_BASE}/${icon}.png` : null;
}

// ── This app's own assets ────────────────────────────────────────────────
//
// These take Vite's `base` (they live in `public/`), and on extraction they
// move with the app rather than staying behind with the backend.

/** The Stationly mark. Used by the header, the loader and the QR panel - it was
 *  written out inline at four call sites, each rebuilding the same string. */
export const BRAND_MARK_URL = `${import.meta.env.BASE_URL}stationly-mark.png`;

/** Not imported as a module: the QR alone is 48 KB of path data and inlining it
 *  into the JS bundle would delay first paint on exactly the slow TV browsers
 *  this has to work on. */
export const APP_QR_URL = `${import.meta.env.BASE_URL}qr/stationly-app.svg`;
