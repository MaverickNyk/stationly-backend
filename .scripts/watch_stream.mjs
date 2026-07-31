#!/usr/bin/env node
/**
 * Live WebSocket departure board — a dev client for /api/v1/stream.
 *
 * Connects, authenticates, subscribes to one or more stations, and renders
 * every frame as it arrives. Use it to watch the stream end-to-end without
 * building an app client.
 *
 *   node .scripts/watch_stream.mjs                    # Hatch End (default)
 *   node .scripts/watch_stream.mjs 940GZZDLTWG        # Tower Gateway
 *   node .scripts/watch_stream.mjs 910GHTCHEND 940GZZDLTWG
 *   STREAM_URL=ws://localhost:3000/api/v1/stream node .scripts/watch_stream.mjs
 *
 * Auth: the endpoint requires a real Firebase ID token, so this mints one with
 * the local service account (custom token → Identity Toolkit exchange). That
 * exercises the SAME verifyIdToken path a real client hits — deliberately, so
 * a broken auth config fails here rather than silently in the app.
 *
 * Requires stationly-backend/serviceAccountKey.json (gitignored, already local).
 */
import admin from 'firebase-admin';
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const STREAM_URL = process.env.STREAM_URL || 'wss://staging-api.stationly.co.uk/api/v1/stream';
const STATIONS = process.argv.slice(2).length ? process.argv.slice(2) : ['910GHTCHEND'];

/** Public client identifier (ships in every app build) — not a secret. */
function webApiKey() {
    if (process.env.FIREBASE_WEB_API_KEY) return process.env.FIREBASE_WEB_API_KEY;
    try {
        const plist = resolve(ROOT, '../StationlyUI/iosApp/iosApp/GoogleService-Info.plist');
        return execSync(`plutil -extract API_KEY raw -o - "${plist}"`, { encoding: 'utf8' }).trim();
    } catch {
        console.error('Set FIREBASE_WEB_API_KEY (could not read it from GoogleService-Info.plist).');
        process.exit(2);
    }
}

async function mintIdToken() {
    const saPath = resolve(ROOT, 'serviceAccountKey.json');
    const sa = JSON.parse(readFileSync(saPath, 'utf8'));
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(sa) });

    const custom = await admin.auth().createCustomToken('stream-watch-dev');
    const res = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webApiKey()}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    );
    const json = await res.json();
    if (!json.idToken) throw new Error(`Token exchange failed: ${JSON.stringify(json).slice(0, 200)}`);
    return json.idToken;
}

const clock = () => new Date().toLocaleTimeString('en-GB');
const eta = (iso) => {
    const secs = (new Date(iso).getTime() - Date.now()) / 1000;
    if (Number.isNaN(secs)) return '  ?  ';
    if (secs < 30) return '  Due';
    return `${String(Math.round(secs / 60)).padStart(3)} min`;
};

function render(kind, station, payload) {
    const rows = [];
    for (const line of Object.values(payload.lines || {})) {
        for (const [dir, d] of Object.entries(line.dirs || {})) {
            for (const p of d.preds || []) {
                rows.push({ line: line.name || line.id, dir, dest: p.displayName || p.destId,
                            plat: p.platform || '—', eta: p.eta });
            }
        }
    }
    rows.sort((a, b) => new Date(a.eta) - new Date(b.eta));

    const tag = kind === 'snapshot' ? 'SNAPSHOT (from cache)' : 'UPDATE (live)';
    console.log(`\n┌─ ${clock()}  ${station}  ${tag}  —  ${rows.length} departures`);
    if (!rows.length) {
        console.log('│  (no departures — outside service hours, or nothing running)');
    } else {
        for (const r of rows.slice(0, 12)) {
            console.log(`│  ${eta(r.eta)}  ${(r.dest || '').padEnd(28).slice(0, 28)}  ${String(r.plat).padEnd(22).slice(0, 22)}  ${r.line} · ${r.dir}`);
        }
        if (rows.length > 12) console.log(`│  … ${rows.length - 12} more`);
    }
    console.log('└─');
}

const token = await mintIdToken();
console.log(`Connecting to ${STREAM_URL}`);
console.log(`Watching: ${STATIONS.join(', ')}   (Ctrl-C to stop)\n`);

const ws = new WebSocket(STREAM_URL);
let frames = 0;

ws.on('open', () => {
    console.log(`${clock()}  ✓ connected — authenticating…`);
    ws.send(JSON.stringify({ action: 'auth', token }));
});

ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.type === 'ready') {
        console.log(`${clock()}  ✓ authenticated — subscribing…`);
        ws.send(JSON.stringify({ action: 'subscribe', stations: STATIONS }));
        // No snapshot arrives if the cache has nothing for this station yet —
        // that just means the Syncer hasn't pushed it (it only polls stations
        // someone has SUBSCRIBED to in the app). Updates still flow once it does.
        setTimeout(() => {
            if (frames === 0) {
                console.log(`${clock()}  … no data yet. If this station has no saved-board subscriber,`);
                console.log('       the Syncer never polls it and nothing will arrive.');
            }
        }, 8000);
        return;
    }
    if (m.type === 'snapshot' || m.type === 'update') { frames++; render(m.type, m.station, m.payload); return; }
    if (m.type === 'error') { console.log(`${clock()}  ✗ ${m.code || 'error'}: ${m.message}`); return; }
    console.log(`${clock()}  frame:`, JSON.stringify(m).slice(0, 160));
});

ws.on('error', (e) => console.log(`${clock()}  ✗ socket error: ${e.message}`));
ws.on('close', (code) => { console.log(`\n${clock()}  closed (${code}) after ${frames} data frame(s)`); process.exit(0); });

process.on('SIGINT', () => { console.log('\nclosing…'); ws.close(); });
