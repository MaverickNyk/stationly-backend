import { useEffect } from 'react';

import { londonMinutesOf } from '../../../time/london';

/**
 * Unattended Kiosk Auto-Update & Memory Maintenance Hook.
 *
 * Café displays and wall screens run 24/7 without user interaction.
 *
 * Three self-healing mechanisms:
 *  1. Deployment Detection: Every 30 minutes, checks if `index.html` references a new
 *     Vite bundle hash. If a new deployment is found, it reloads to update the UI.
 *  2. 6-Hour Rolling Refresh: Flushes TV browser memory and DOM every 6 hours.
 *  3. Nightly 03:30 AM Reset: Ensures the screen is fresh before the morning rush.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1_000;
const VERSION_CHECK_INTERVAL_MS = 30 * 60 * 1_000;
/** 03:30 London, in minutes past midnight. */
const NIGHTLY_RESET_MINUTE = 3 * 60 + 30;

export function useKioskAutoUpdate(): void {
    useEffect(() => {
        // 1. Fixed 6-hour rolling refresh
        const sixHourTimer = window.setTimeout(() => {
            window.location.reload();
        }, SIX_HOURS_MS);

        // 2. Nightly 03:30 London reset - inside the window the board already
        //    reports as "service ended", so nobody is reading it.
        const scheduleNightlyReset = () => {
            let minutesUntil = NIGHTLY_RESET_MINUTE - londonMinutesOf(Date.now());
            if (minutesUntil <= 0) minutesUntil += 24 * 60; // tomorrow

            return window.setTimeout(() => window.location.reload(), minutesUntil * 60_000);
        };

        const nightlyTimer = scheduleNightlyReset();

        // 3. Periodic deployment check (every 30m).
        //
        // In dev there is no hashed bundle tag to find, so this resolves to null
        // and the check disables itself rather than comparing against nothing.
        const initialScriptSrc =
            document.querySelector('script[src*="assets/index-"]')?.getAttribute('src') ?? null;

        const versionCheckTimer = window.setInterval(async () => {
            if (!initialScriptSrc) return;
            try {
                const res = await fetch(`${import.meta.env.BASE_URL}?t=${Date.now()}`, {
                    method: 'GET',
                    cache: 'no-store',
                });
                if (!res.ok) return;
                const html = await res.text();
                const match = html.match(/src="([^"]*assets\/index-[^"]+\.js)"/);
                const latestScriptSrc = match ? match[1] : null;

                if (initialScriptSrc && latestScriptSrc && latestScriptSrc !== initialScriptSrc) {
                    console.log('[KIOSK] New deployment detected. Reloading to apply latest UI...');
                    window.location.reload();
                }
            } catch {
                /* Network blip; retry on next cycle */
            }
        }, VERSION_CHECK_INTERVAL_MS);

        return () => {
            window.clearTimeout(sixHourTimer);
            window.clearTimeout(nightlyTimer);
            window.clearInterval(versionCheckTimer);
        };
    }, []);
}
