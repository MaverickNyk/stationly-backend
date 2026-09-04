import { useEffect, useRef, useState } from 'react';
import type { LineStatus, StationPredictionResponse } from '../../../api/types';

/**
 * One WebSocket, for one station, for the life of the screen.
 *
 * The socket is served by `../src/tempWebHost.ts` inside the backend process and
 * joins the SAME `StationStreamHub` the phones use - so the café wall is fed by
 * the identical path: TfL → Syncer → change detection → hub → this screen. When
 * a train moves, the board moves. No polling, no interval, nothing asking a
 * question every fifteen seconds that is usually answered "nothing changed".
 *
 * Frames (all JSON), matching the hubs' wire format verbatim:
 *   {"type":"snapshot"|"update","station":"910G…","payload":{…}}   departures
 *   {"type":"snapshot"|"update","line":"mildmay","payload":{…}}    line status
 *   {"type":"kiosk_meta","statuses":[…],"lineModes":{…},"serverNowMs":…}
 *
 * A station frame and a line frame are told apart by WHICH id field is present,
 * not by the type - both carry the same two type values.
 */

export interface KioskStreamState {
    station: StationPredictionResponse | null;
    statuses: LineStatus[];
    lineModes: Record<string, string>;
    /** Wall-clock millis of the last frame that carried departures; 0 = never.
     *  Feeds the fallback machine, which will not claim staleness without it. */
    lastUpdatedMs: number;
    isOnline: boolean;
    /** True until the first frame of any kind - drives 'connecting'. */
    isLoading: boolean;
    /** Server clock minus this TV's clock. */
    clockSkewMs: number;
}

const INITIAL: KioskStreamState = {
    station: null,
    statuses: [],
    lineModes: {},
    lastUpdatedMs: 0,
    isOnline: false,
    isLoading: true,
    clockSkewMs: 0,
};

/** Reconnect backoff. A café screen is unattended: it has to come back from a
 *  router reboot on its own, without hammering the box in the meantime. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/**
 * If no frame of any kind arrives for this long, assume the socket is dead and
 * reconnect. A TCP connection to a sleeping box stays OPEN from our side
 * indefinitely, so `readyState` alone will never tell us - only silence will.
 *
 * Six minutes is above the quietest real period: the hub pushes on CHANGE, and
 * a station with no departures at 04:00 legitimately says nothing for a while.
 */
const WATCHDOG_TIMEOUT_MS = 6 * 60 * 1_000;

export function useKioskStream(station: string): KioskStreamState {
    const [state, setState] = useState<KioskStreamState>(INITIAL);
    const socketRef = useRef<WebSocket | null>(null);
    const attemptRef = useRef(0);
    const closedByUs = useRef(false);

    useEffect(() => {
        // Start clean for a new station. Without this, repointing a screen -
        // React Router swaps the `:stationId` param without remounting - left
        // the PREVIOUS station's departures, statuses and last-updated stamp on
        // screen, relabelled with the new station's name, until the first frame
        // of the new subscription replaced them. A board showing one station's
        // trains under another station's heading is the worst thing this screen
        // can do, and it is worse than showing nothing.
        setState(INITIAL);

        if (!station) return;
        closedByUs.current = false;
        let retryTimer: number | undefined;
        let watchdogTimer: number | undefined;

        // Every connection attempt gets a generation number, and a socket's
        // handlers do nothing once they are not the current generation.
        //
        // Without it the screen quietly accumulates sockets. The path: the
        // watchdog (or a wake) closes a socket, `wake` sees readyState CLOSING
        // and opens a replacement immediately - and THEN the old socket's
        // `onclose` finally fires and schedules a retry of its own, on top of
        // the connection that already exists. Each round can double the count,
        // every one of them registered in StationStreamHub on the backend, and
        // nothing ever closes them. A screen left up for a day was the point at
        // which anyone would have noticed.
        let generation = 0;

        const kickWatchdog = () => {
            window.clearTimeout(watchdogTimer);
            watchdogTimer = window.setTimeout(() => {
                const ws = socketRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.warn(
                        `[KIOSK STREAM] No frame for ${WATCHDOG_TIMEOUT_MS / 60_000} min. Reconnecting...`,
                    );
                    try { ws.close(); } catch { /* ignore */ }
                }
            }, WATCHDOG_TIMEOUT_MS);
        };

        /** Detach handlers and close, so a socket we have moved on from can
         *  never call back into this effect. */
        const discard = (ws: WebSocket | null) => {
            if (!ws) return;
            ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
            try { ws.close(); } catch { /* already gone */ }
        };

        const connect = () => {
            // Anything still around from a previous attempt is now history.
            discard(socketRef.current);

            const mine = ++generation;
            const isCurrent = () => mine === generation && !closedByUs.current;

            const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const url = `${scheme}://${window.location.host}/kiosk-stream?station=${encodeURIComponent(station)}`;
            const ws = new WebSocket(url);
            socketRef.current = ws;

            ws.onopen = () => {
                if (!isCurrent()) return discard(ws);
                attemptRef.current = 0;
                kickWatchdog();
                setState(prev => (prev.isOnline ? prev : { ...prev, isOnline: true }));
            };

            ws.onmessage = event => {
                if (!isCurrent()) return discard(ws);
                kickWatchdog();
                let frame: any;
                try {
                    frame = JSON.parse(String(event.data));
                } catch {
                    return; // a frame we cannot read is not a reason to drop the board
                }

                if (frame.type === 'kiosk_meta') {
                    setState(prev => ({
                        ...prev,
                        statuses: frame.statuses ?? prev.statuses,
                        lineModes: frame.lineModes ?? prev.lineModes,
                        clockSkewMs: frame.serverNowMs ? frame.serverNowMs - Date.now() : prev.clockSkewMs,
                        lastUpdatedMs: prev.lastUpdatedMs === 0 ? Date.now() : prev.lastUpdatedMs,
                        isLoading: false,
                    }));
                    return;
                }

                if (frame.station && frame.payload) {
                    setState(prev => ({
                        ...prev,
                        station: frame.payload,
                        lastUpdatedMs: Date.now(),
                        isOnline: true,
                        isLoading: false,
                    }));
                    return;
                }

                if (frame.line && frame.payload) {
                    // Replace that one line in place. The rest of the board's
                    // statuses are still current - a status frame for the Weaver
                    // says nothing about the Mildmay.
                    setState(prev => {
                        const incoming = { ...frame.payload, id: frame.line } as LineStatus;
                        const next = prev.statuses.some(s => s.id === frame.line)
                            ? prev.statuses.map(s => (s.id === frame.line ? { ...s, ...incoming } : s))
                            : [...prev.statuses, incoming];
                        return { ...prev, statuses: next };
                    });
                }
            };

            const scheduleRetry = () => {
                if (!isCurrent()) return;
                window.clearTimeout(watchdogTimer);
                // Keep the last good board on screen while reconnecting. An empty
                // board is a CLAIM ("no trains here"); a slightly old one with an
                // honest offline mark is the truthful thing to show, and the
                // fallback machine takes over once it really is too old.
                setState(prev => ({ ...prev, isOnline: false, isLoading: false }));
                const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)];
                attemptRef.current += 1;
                retryTimer = window.setTimeout(connect, delay);
            };

            ws.onclose = scheduleRetry;
            ws.onerror = () => {
                // onclose always follows, and doing the work twice would double
                // the backoff step for a single failure.
                try { ws.close(); } catch { /* already gone */ }
            };
        };

        connect();

        // A TV that sleeps drops the socket without telling us. Retry the moment
        // it is looked at again rather than waiting out the backoff.
        const wake = () => {
            if (document.visibilityState !== 'visible') return;
            const ws = socketRef.current;
            if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                window.clearTimeout(retryTimer);
                window.clearTimeout(watchdogTimer);
                attemptRef.current = 0;
                // connect() bumps the generation, so the socket we are stepping
                // over here can no longer schedule a retry behind our back.
                connect();
            }
        };
        document.addEventListener('visibilitychange', wake);
        window.addEventListener('online', wake);

        return () => {
            closedByUs.current = true;
            window.clearTimeout(retryTimer);
            window.clearTimeout(watchdogTimer);
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('online', wake);
            discard(socketRef.current);
            socketRef.current = null;
        };
    }, [station]);

    return state;
}
