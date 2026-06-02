/**
 * One-time (re)seeder for the Firestore `routes` collection.
 *
 * Fetches the canonical route for every line across the supported modes
 * directly from TfL and writes a freshly-built document to `routes/{lineId}`,
 * fully OVERWRITING whatever is there (clearing stale data). The document
 * shape is identical to what `lineController.getLineRoute` builds on a cache
 * miss, so the app/controller logic is unchanged:
 *
 *   { id, name, modeName, directions, sequences, stationNames, lastUpdatedTime }
 *
 * Because each doc gets a fresh `lastUpdatedTime`, the running backend's
 * `routes` onSnapshot listener (filtered on lastUpdatedTime > bootTime) will
 * pick the changes up live into SQLite + the in-memory cache — no restart
 * needed. If your build doesn't watch routes, just restart the server after.
 *
 * Target project comes from FIREBASE_KEY_PATH (the service-account key), so
 * run it with your STAGING credentials to hit staging Firestore.
 *
 * Usage (from stationly-backend/):
 *   npx ts-node src/scripts/seedRoutes.ts                 # DRY RUN, all modes
 *   npx ts-node src/scripts/seedRoutes.ts --write         # write all modes
 *   npx ts-node src/scripts/seedRoutes.ts bus --write     # write a single mode
 *   FIREBASE_KEY_PATH=./staging-key.json npx ts-node src/scripts/seedRoutes.ts --write
 */
import * as path from 'path';
import { db } from '../config/firebase';
import { TflApiClient } from '../client/TflApiClient';
import { encodeRouteForFirestore } from '../utils/routeEncoding';

// The five modes the app supports (matches the mode picker).
const ALL_MODES = ['tube', 'dlr', 'overground', 'elizabeth-line', 'bus'];

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── TfL rate limiter ───────────────────────────────────────────────
// TfL allows 500 requests/min WITH an app key (≈50/min keyless). We stay
// safely under the keyed budget and take an automatic ~60s break whenever a
// rolling 60s window fills up. Cap drops to 40/min if no key is configured.
const HAS_KEY = !!(process.env.TFL_APP_KEY && process.env.TFL_APP_KEY.trim());
const MAX_PER_MIN = HAS_KEY ? 450 : 40;
let windowStart = Date.now();
let callsInWindow = 0;
async function rateGate() {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; callsInWindow = 0; }
    if (callsInWindow >= MAX_PER_MIN) {
        const wait = 60_000 - (now - windowStart) + 500;
        console.log(`   ⏸️  rate break ${Math.ceil(wait / 1000)}s (hit ${callsInWindow}/${MAX_PER_MIN} per min)`);
        await sleep(wait);
        windowStart = Date.now();
        callsInWindow = 0;
    }
    callsInWindow++;
}

/** Retry a TfL call a few times with backoff (handles 429 / transient 5xx). */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
        try {
            await rateGate();
            return await fn();
        } catch (e: any) {
            lastErr = e;
            const status = e?.response?.status;
            const wait = status === 429 ? 4000 * (i + 1) : 800 * (i + 1);
            console.warn(`    ↻ retry ${label} (attempt ${i + 1}/${attempts}, status ${status ?? '?'}) in ${wait}ms`);
            await sleep(wait);
        }
    }
    throw lastErr;
}

/** Ordered stop-ID sequences + id→name map per direction (mirrors lineController.fetchSequences). */
async function fetchSequences(lineId: string, directions: { direction: string }[]) {
    const sequences: Record<string, string[][]> = {};
    const stationNames: Record<string, string> = {};
    for (const dir of directions) {
        const d = dir.direction.toLowerCase();
        // TfL's /Route/Sequence only accepts inbound|outbound; map circular variants.
        const tflDir = (d === 'clockwise' || d === 'all') ? 'inbound' : (d === 'anticlockwise' ? 'outbound' : d);
        try {
            const data: any = await withRetry(`seq ${lineId}/${tflDir}`,
                () => TflApiClient.getLineRouteSequence(lineId, tflDir));
            sequences[dir.direction] = (data.orderedLineRoutes || []).map((r: any) => r.naptanIds || []);
            (data.stations || []).forEach((s: any) => {
                const id = s.stationId || s.id;
                if (id && s.name) stationNames[id] = s.name;
            });
            (data.stopPointSequences || []).forEach((seq: any) => {
                (seq.stopPoint || []).forEach((sp: any) => {
                    const id = sp.id || sp.naptanId;
                    if (id && sp.name && !stationNames[id]) stationNames[id] = sp.name;
                });
            });
        } catch {
            console.warn(`    ⚠️  no sequence for ${lineId}/${dir.direction}`);
        }
        await sleep(120);
    }
    return { sequences, stationNames };
}

/** Build the route doc for one line (mirrors lineController.getLineRoute's cold-fetch path). */
async function buildRoute(line: { id: string; name?: string; modeName?: string }, mode: string) {
    const lineId = line.id;
    const raw: any = await withRetry(`route ${lineId}`, () => TflApiClient.getLineRoute(lineId));
    const sectionsArray: any[] = Array.isArray(raw) ? raw : (raw?.routeSections || []);

    const dirMap: Record<string, { id: string; name: string }[]> = {};
    sectionsArray.forEach((section: any) => {
        const dir: string = (section.direction || 'outbound').toLowerCase();
        if (!dirMap[dir]) dirMap[dir] = [];
        if (section.destination && !dirMap[dir].find(x => x.id === section.destination)) {
            dirMap[dir].push({ id: section.destination, name: section.destinationName || section.destination });
        }
    });

    const directions = Object.entries(dirMap).map(([direction, destinations]) => ({ direction, destinations }));
    const { sequences, stationNames } = await fetchSequences(lineId, directions);

    return {
        id: lineId,
        name: line.name || (lineId.charAt(0).toUpperCase() + lineId.slice(1)),
        modeName: line.modeName || mode,
        directions,
        sequences,
        stationNames,
        lastUpdatedTime: Date.now(), // epoch millis (integer watermark)
    };
}

/** Delete every document in the `routes` collection (batched). */
async function clearRoutes(write: boolean): Promise<number> {
    const snap = await db.collection('routes').get();
    console.log(`\n🧹 Clearing routes collection: ${snap.size} existing doc(s)${write ? '' : ' (dry run — not deleting)'}`);
    if (!write) return snap.size;
    let batch = db.batch();
    let n = 0;
    for (const doc of snap.docs) {
        batch.delete(doc.ref);
        if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
    }
    if (n % 400 !== 0) await batch.commit();
    console.log(`🧹 Deleted ${n} doc(s).`);
    return n;
}

async function main() {
    const args = process.argv.slice(2);
    const write = args.includes('--write');
    const clear = args.includes('--clear');
    const modeArg = args.find(a => !a.startsWith('--'));
    const modes = modeArg ? [modeArg] : ALL_MODES;

    // Safety: surface exactly which Firestore project we're about to touch.
    const keyPath = process.env.FIREBASE_KEY_PATH || './serviceAccountKey.json';
    let projectId = 'unknown';
    try { projectId = require(path.resolve(keyPath)).project_id; } catch { /* default creds */ }

    console.log('────────────────────────────────────────────────────────');
    console.log(` Route reseed  ${write ? '(WRITE)' : '(DRY RUN — pass --write to commit)'}`);
    console.log(` Firestore project : ${projectId}`);
    console.log(` Service account   : ${keyPath}`);
    console.log(` Modes             : ${modes.join(', ')}`);
    console.log(` TfL app key       : ${HAS_KEY ? 'present' : 'MISSING (keyless)'} → cap ${MAX_PER_MIN} req/min`);
    console.log(` Clear first       : ${clear ? 'YES — wipe routes collection' : 'no (overwrite per line)'}`);
    console.log('────────────────────────────────────────────────────────');
    if (write) {
        console.log(' Writing in 5s — Ctrl-C to abort if the project above is wrong…');
        await sleep(5000);
    }

    if (clear) await clearRoutes(write);

    let ok = 0, fail = 0, skipped = 0;
    const failures: string[] = [];

    for (const mode of modes) {
        let lines: any[] = [];
        try {
            lines = await withRetry(`lines ${mode}`, () => TflApiClient.getLinesByMode(mode));
        } catch (e: any) {
            console.error(`\n❌ Could not list lines for mode '${mode}': ${e?.message || e}`);
            continue;
        }
        console.log(`\n=== ${mode}: ${lines.length} line(s) ===`);

        for (const line of lines) {
            const lineId = line.id;
            try {
                const route = await buildRoute(line, mode);
                const stops = Object.keys(route.stationNames).length;
                if (route.directions.length === 0 || stops === 0) {
                    skipped++;
                    console.warn(`  ⏭️  ${mode}/${lineId}: empty (dirs=${route.directions.length}, stops=${stops}) — skipped`);
                } else {
                    if (write) await db.collection('routes').doc(lineId).set(encodeRouteForFirestore(route)); // full overwrite clears stale fields
                    ok++;
                    console.log(`  ${write ? '✅' : '•'} ${mode}/${lineId}  (${route.directions.length} dirs, ${stops} stops)`);
                }
            } catch (e: any) {
                fail++;
                failures.push(`${mode}/${lineId}`);
                console.warn(`  ❌ ${mode}/${lineId}: ${e?.message || e}`);
            }
            await sleep(250); // be gentle on the TfL API
        }
    }

    console.log('\n────────────────────────────────────────────────────────');
    console.log(` Done. written/ok=${ok}  skipped=${skipped}  failed=${fail}${write ? '' : '   (DRY RUN — nothing written)'}`);
    if (failures.length) console.log(` Failures: ${failures.join(', ')}`);
    console.log('────────────────────────────────────────────────────────');
    process.exit(0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
