/**
 * Seeds National Rail station docs into Firestore.
 *
 *   npx ts-node src/scripts/seedNationalRailStations.ts            # DRY RUN
 *   npx ts-node src/scripts/seedNationalRailStations.ts --write    # commit
 *   ... --all                                                      # all stations, not the 10-station test set
 *
 * Safety rules, all enforced before any write:
 *   1. ABORT if any generated doc id already exists in `stations`. We own the
 *      `9100<TIPLOC>` namespace; `910G…` belongs to the TfL sync, whose
 *      replication `apply` is a full doc replace and would clobber us.
 *   2. SKIP any station with no derived directions. An empty `lines` map makes
 *      `getLinesByMode` fall through and return EVERY line for the mode, which
 *      the app then caches for 24h.
 *   3. `lines/national-rail` is written BEFORE the stations, or the line-id
 *      intersection in lineController is empty and trips the same fallback.
 *   4. `lastUpdatedTime` is copied in whatever shape live docs already use —
 *      the delta sync compares it with `>`, so a type mismatch would either
 *      re-download everything or skip our docs forever.
 *
 * Directions come from the Darwin timetable: bearing from the station to each
 * next public calling point, bucketed into compass quadrants. A terminus
 * collapses to one direction, which makes the app auto-skip the picker.
 */

import * as fs from 'fs';
import * as pathMod from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';
import { db } from '../config/firebase';
import { nowMs } from '../utils/timestamps';

const WRITE = process.argv.includes('--write');
const ALL = process.argv.includes('--all');

const DARWIN_DIR = pathMod.resolve(process.cwd(), 'data', 'darwin');
const NR_STATIONS = pathMod.resolve(process.cwd(), 'src', 'data', 'nationalRail', 'stations.json');

/** A spread of station types: London termini, a multi-naptan sibling pair, the
 *  busiest interchange, a regional hub, a rural 4-way junction, a station that
 *  name-matches an existing TfL doc, and the two Bicesters. */
const TEST_SET = [
    'KNGX', 'PADTON', 'STPX', 'STPADOM', 'CLPHMJC',
    'MNCRPIC', 'ELYY', 'BARKING', 'BCSTRTN', 'BCSTN',
];

const MODE = 'national-rail';
const LINE_ID = 'national-rail';
const PATH_TAGS = new Set(['OR', 'IP', 'PP', 'DT']);
const PUBLIC_TAGS = new Set(['OR', 'IP', 'DT']);
const EXCLUDED_TOCS = new Set(['XR']);          // Elizabeth line — already a TfL mode

interface NrStation {
    naptanId: string; tiploc: string; crs: string; name: string;
    lat?: number; lon?: number; coordsFrom?: string;
}

const GEOHASH_B32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** 9-char geohash. Verified against the stored value for 940GZZLUKSX. */
function geoHash(lat: number, lon: number, precision = 9): string {
    const la = [-90, 90], lo = [-180, 180];
    let hash = '', bit = 0, ch = 0, evenBit = true;
    while (hash.length < precision) {
        if (evenBit) {
            const mid = (lo[0] + lo[1]) / 2;
            if (lon > mid) { ch = ch * 2 + 1; lo[0] = mid; } else { ch *= 2; lo[1] = mid; }
        } else {
            const mid = (la[0] + la[1]) / 2;
            if (lat > mid) { ch = ch * 2 + 1; la[0] = mid; } else { ch *= 2; la[1] = mid; }
        }
        evenBit = !evenBit;
        if (++bit === 5) { hash += GEOHASH_B32[ch]; bit = 0; ch = 0; }
    }
    return hash;
}

function bearing(from: [number, number], to: [number, number]): number {
    const toRad = (d: number) => d * Math.PI / 180;
    const [la1, lo1] = from.map(toRad), [la2, lo2] = to.map(toRad);
    const y = Math.sin(lo2 - lo1) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function quadrant(b: number): string {
    if (b < 45 || b >= 315) return 'northbound';
    if (b < 135) return 'eastbound';
    if (b < 225) return 'southbound';
    return 'westbound';
}

function findFile(suffix: string): string {
    const hit = fs.readdirSync(DARWIN_DIR).find(f => f.endsWith(suffix));
    if (!hit) throw new Error(`No file ending in "${suffix}" in ${DARWIN_DIR}`);
    return pathMod.join(DARWIN_DIR, hit);
}

function attr(line: string, name: string): string | undefined {
    return line.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

/** tiploc -> ordered next-public-call counts, from the timetable. */
async function nextCalls(isStation: Set<string>): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    const rl = readline.createInterface({
        input: fs.createReadStream(findFile('_v8.xml.gz')).pipe(zlib.createGunzip()),
        crlfDelay: Infinity,
    });

    let publicSeq: string[] = [];
    let keep = false;
    let journeys = 0;

    const flush = () => {
        if (keep) {
            for (let i = 0; i + 1 < publicSeq.length; i++) {
                const here = publicSeq[i];
                if (!isStation.has(here)) continue;
                if (!out.has(here)) out.set(here, new Map());
                const m = out.get(here)!;
                const nxt = publicSeq[i + 1];
                m.set(nxt, (m.get(nxt) || 0) + 1);
            }
        }
        publicSeq = []; keep = false;
    };

    for await (const raw of rl) {
        const t = raw.trimStart();
        if (t.startsWith('<Journey')) {
            flush();
            journeys++;
            const toc = attr(t, 'toc');
            keep = attr(t, 'isPassengerSvc') !== 'false'
                && attr(t, 'trainCat') !== 'BS'
                && !(toc && EXCLUDED_TOCS.has(toc));
            continue;
        }
        const tag = t.match(/^<([A-Za-z]+)\b/)?.[1];
        if (!tag || !PATH_TAGS.has(tag)) continue;
        if (!PUBLIC_TAGS.has(tag)) continue;      // passing points don't create a call
        const tpl = attr(t, 'tpl');
        if (tpl) publicSeq.push(tpl);
    }
    flush();

    if (journeys < 40000) throw new Error(`Only ${journeys} journeys parsed — format changed?`);
    console.log(`TT:  ${journeys} journeys → next-call data for ${out.size} stations`);
    return out;
}

/**
 * Read one live station doc to learn the shape of `lastUpdatedTime`. The delta
 * sync does `where('lastUpdatedTime','>',checkpoint)`; if we write a string
 * where live docs hold a number (or vice versa) our docs never replicate.
 */
async function detectTimestampShape(): Promise<'number' | 'string'> {
    const snap = await db.collection('stations').limit(1).get();
    if (snap.empty) throw new Error('stations collection is empty — cannot detect timestamp shape');
    const v = snap.docs[0].data().lastUpdatedTime;
    const shape = typeof v === 'number' ? 'number' : 'string';
    console.log(`FS:  live lastUpdatedTime is a ${shape} (sample: ${JSON.stringify(v)})`);
    return shape;
}

async function main() {
    console.log(`\n=== National Rail station seed — ${WRITE ? 'WRITE' : 'DRY RUN'} ===`);
    console.log(`Project: ${process.env.FIRESTORE_PROJECT_ID}\n`);

    const raw = JSON.parse(fs.readFileSync(NR_STATIONS, 'utf8'));
    const all: NrStation[] = raw.stations || raw;
    const byTiploc = new Map(all.map(s => [s.tiploc, s]));
    const isStation = new Set(byTiploc.keys());
    const coords = new Map<string, [number, number]>(
        all.filter(s => s.lat != null && s.lon != null).map(s => [s.tiploc, [s.lat!, s.lon!]])
    );

    const targets = ALL ? all.map(s => s.tiploc) : TEST_SET;
    console.log(`Candidates: ${targets.length}${ALL ? ' (ALL)' : ' (test set)'}`);

    const calls = await nextCalls(isStation);
    const tsShape = await detectTimestampShape();
    const stamp: number | string = tsShape === 'number' ? nowMs() : new Date().toISOString();

    // ── build docs, skipping any with no derivable direction ───────────────
    const docs: Array<{ id: string; data: any }> = [];
    const skipped: Array<[string, string]> = [];

    for (const tpl of targets) {
        const s = byTiploc.get(tpl);
        if (!s) { skipped.push([tpl, 'not in NaPTAN list']); continue; }

        let lat = s.lat, lon = s.lon;
        if ((lat == null || lon == null) && s.coordsFrom) {
            const donor = await db.collection('stations').doc(s.coordsFrom).get();
            if (donor.exists) { lat = donor.data()!.lat; lon = donor.data()!.lon; }
        }
        if (lat == null || lon == null) { skipped.push([tpl, 'no coordinates']); continue; }

        const directions: string[] = [];
        for (const [nxt] of [...(calls.get(tpl) || new Map())].sort((a, b) => b[1] - a[1])) {
            const to = coords.get(nxt);
            if (!to) continue;
            const q = quadrant(bearing([lat, lon], to));
            if (!directions.includes(q)) directions.push(q);
        }
        if (directions.length === 0) { skipped.push([tpl, 'no passenger departures']); continue; }

        const searchKeys = [MODE, `${MODE}_${LINE_ID}`];
        for (const d of directions) {
            searchKeys.push(`${LINE_ID}_${d}`, `${MODE}_${LINE_ID}_${d}`);
        }

        const id = `9100${tpl}`;
        docs.push({
            id,
            data: {
                naptanId: id,
                id,
                commonName: s.name,
                lat, lon,
                geoHash: geoHash(lat, lon),
                stopType: 'NaptanRailStation',
                indicator: null,
                stopLetter: null,
                crs: s.crs,
                lastUpdatedTime: stamp,
                modes: {
                    [MODE]: {
                        modeName: MODE,
                        lines: { [LINE_ID]: { id: LINE_ID, name: LINE_ID, directions } },
                    },
                },
                searchKeys: [...new Set(searchKeys)],
            },
        });
    }

    // ── RULE 1: hard abort on any id collision ─────────────────────────────
    const collisions: string[] = [];
    for (const d of docs) {
        if ((await db.collection('stations').doc(d.id).get()).exists) collisions.push(d.id);
    }
    if (collisions.length) {
        console.error(`\n❌ ABORT — ${collisions.length} doc id(s) already exist in Firestore:`);
        collisions.forEach(c => console.error(`     ${c}`));
        console.error('   These belong to another writer. Nothing was written.');
        process.exit(1);
    }
    console.log(`\n✅ No id collisions (checked ${docs.length} ids against Firestore)`);

    console.log(`\nWill write ${docs.length} station docs:`);
    for (const d of docs) {
        const dirs = d.data.modes[MODE].lines[LINE_ID].directions;
        console.log(`   ${d.id.padEnd(16)} ${String(d.data.crs).padEnd(4)} ` +
            `${String(d.data.commonName).slice(0, 42).padEnd(44)} ` +
            `${dirs.length}d [${dirs.join(', ')}]  ${d.data.searchKeys.length} keys`);
    }
    if (skipped.length) {
        console.log(`\nSkipped ${skipped.length}:`);
        skipped.forEach(([t, why]) => console.log(`   ${t.padEnd(10)} ${why}`));
    }

    if (!WRITE) {
        console.log('\nDRY RUN — nothing written. Re-run with --write to commit.\n');
        return;
    }

    // ── RULE 3: the line doc first ─────────────────────────────────────────
    await db.collection('lines').doc(LINE_ID).set({
        id: LINE_ID, name: 'National Rail', modeName: MODE, lastUpdatedTime: stamp,
    }, { merge: true });
    console.log(`\n✍️  lines/${LINE_ID} written`);

    let batch = db.batch();
    let n = 0;
    for (const d of docs) {
        batch.set(db.collection('stations').doc(d.id), d.data);
        if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();
    console.log(`✍️  ${docs.length} station docs written to stations/\n`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
