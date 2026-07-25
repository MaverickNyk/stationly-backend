/**
 * Pass 1 of the National Rail seed: derive the corridor ("line") taxonomy from
 * the Darwin timetable file. Emits `data/darwin/corridors.json` for REVIEW.
 * Writes nothing to Firestore — pass 2 (seedNationalRailStations) does that.
 *
 * Why a review gate: line ids and direction ids are persisted in users' saved
 * boards. Renaming one later silently blanks the board. The taxonomy has to be
 * inspected once and then held stable, not regenerated nightly.
 *
 * Method
 * ------
 * A "line" here is a stretch of physical track, not a TOC and not a stopping
 * pattern. Both of the obvious rules fail (measured at Paddington):
 *   - next public CALL  → 5 buckets, which are stopping patterns (Slough and
 *                         Reading are the same line)
 *   - next PATH point   → 1 bucket, because Heathrow and Reading trains leave
 *                         Paddington on the same track and split 6 points later
 * So instead we build the actual track graph from every journey's full physical
 * path (calls AND passing points, which is why fast trains still contribute the
 * stations they run through), then contract chains of degree-2 nodes. Each
 * maximal chain between two junctions/termini is a corridor.
 *
 * Usage:  npx ts-node src/scripts/deriveNationalRailCorridors.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';

const DARWIN_DIR = path.resolve(process.cwd(), 'data', 'darwin');
const OUT_FILE = path.join(DARWIN_DIR, 'corridors.json');
const NR_STATIONS = path.resolve(process.cwd(), 'src', 'data', 'nationalRail', 'stations.json');

/** Public calling points + passing points = the physical path. `OP*` variants
 *  are operational (non-public) moves and are deliberately excluded. */
const PATH_TAGS = new Set(['OR', 'IP', 'PP', 'DT']);
/** Elizabeth line — already served by the `elizabeth-line` mode from the TfL
 *  sync. Including it here would duplicate every Elizabeth station. */
const EXCLUDED_TOCS = new Set(['XR']);
/** Rail-replacement bus services (they appear with `*BUS` tiplocs). */
const EXCLUDED_TRAIN_CATS = new Set(['BS']);

interface LocationRef { tpl: string; crs?: string; locname: string; toc?: string }

interface Corridor {
    id: string;
    name: string;
    /** Full ordered track path, junctions included. */
    tplSequence: string[];
    /** Ordered public stations (those with a CRS) along the corridor. */
    stations: string[];
    endpointA: string;
    endpointB: string;
    /** How many journeys traversed any edge of this corridor. */
    journeyWeight: number;
}

function attr(line: string, name: string): string | undefined {
    const m = line.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : undefined;
}

function slug(s: string): string {
    return s.toLowerCase()
        .replace(/\(.*?\)/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function openGz(file: string) {
    return readline.createInterface({
        input: fs.createReadStream(file).pipe(zlib.createGunzip()),
        crlfDelay: Infinity,
    });
}

function findFile(suffix: string): string {
    const hit = fs.readdirSync(DARWIN_DIR).find(f => f.endsWith(suffix));
    if (!hit) throw new Error(`No file ending in "${suffix}" in ${DARWIN_DIR}`);
    return path.join(DARWIN_DIR, hit);
}

// ── 1. Reference data: tpl → { crs, locname } ──────────────────────────────
// The presence of `crs` is what distinguishes a public station from a track
// feature: junctions like ROYAOJN / HTRWAJN carry no crs and no real locname.
async function loadReference(): Promise<Map<string, LocationRef>> {
    const file = findFile('_ref_v99.xml.gz');
    const refs = new Map<string, LocationRef>();
    let sawRoot = false;

    for await (const line of openGz(file)) {
        if (!sawRoot && line.includes('<PportTimetableRef')) sawRoot = true;
        if (!line.includes('<LocationRef')) continue;
        const tpl = attr(line, 'tpl');
        if (!tpl) continue;
        refs.set(tpl, {
            tpl,
            crs: attr(line, 'crs'),
            locname: attr(line, 'locname') || tpl,
            toc: attr(line, 'toc'),
        });
    }

    if (!sawRoot) throw new Error(`${file} is not a PportTimetableRef document`);
    if (refs.size < 10000) throw new Error(`Only ${refs.size} LocationRefs parsed — format changed?`);
    console.log(`REF: ${refs.size} locations, ${[...refs.values()].filter(r => r.crs).length} with a CRS`);
    return refs;
}

// ── 2. Timetable: build the track graph ───────────────────────────────────
interface GraphResult {
    /** Undirected adjacency over tiplocs. */
    adj: Map<string, Set<string>>;
    /** Journeys traversing each undirected edge, keyed `a|b` sorted. */
    edgeWeight: Map<string, number>;
    /** Stations at which at least one passenger service actually CALLS. */
    callingStations: Set<string>;
    /** Pairs observed with >=1 station BETWEEN them on some journey — i.e.
     *  demonstrably not track-adjacent. Keyed `a|b` sorted. */
    spanned: Set<string>;
    stats: Record<string, number>;
}

/**
 * The set of tiplocs that are genuinely public stations, taken from the
 * NaPTAN-derived list. "Has a CRS" is NOT a good enough test: 1,054 of the
 * ref file's 3,698 CRS entries are rail-replacement bus stops ("… (Bus)"),
 * platform-level splits ("Aberdare Platform 2") or plain junctions whose
 * locname is just the tiploc (ABTSWDJ, ACTONTC). Left in the graph they act
 * as nodes and chop corridors into stubs — Belle Isle (KNGXBEL) cut King's
 * Cross down to a 2-station line, and Shepreth Branch Junction did the same
 * to Cambridge.
 */
function loadStationSet(): Set<string> {
    if (!fs.existsSync(NR_STATIONS)) {
        throw new Error(`Missing ${NR_STATIONS} — needed to tell stations from junctions`);
    }
    const raw = JSON.parse(fs.readFileSync(NR_STATIONS, 'utf8'));
    const set = new Set<string>((raw.stations || raw).map((s: any) => s.tiploc));
    console.log(`NAP: ${set.size} public stations from the NaPTAN list`);
    return set;
}

async function buildGraph(refs: Map<string, LocationRef>, isStation: Set<string>): Promise<GraphResult> {
    const file = findFile('_v8.xml.gz');
    const adj = new Map<string, Set<string>>();
    const edgeWeight = new Map<string, number>();
    const callingStations = new Set<string>();
    const spanned = new Set<string>();
    const stats = { journeys: 0, kept: 0, nonPassenger: 0, bus: 0, excludedToc: 0, pathPoints: 0 };

    let path: string[] = [];
    let calls: string[] = [];
    let keep = false;
    let inJourney = false;

    const flush = () => {
        if (keep && path.length > 1) {
            stats.kept++;
            stats.pathPoints += path.length;
            for (const c of calls) callingStations.add(c);
            // Collapse the path down to PUBLIC stations before building edges.
            // Darwin's path granularity is junction-level (Slough sits among
            // STKYJN / DOLPHNJ / HTRWAJN…), so a raw graph gives almost every
            // station degree >2 and chain contraction degenerates to pairs.
            // Filtering to CRS-bearing tiplocs makes adjacency mean "next
            // station along the track", which is what a corridor is made of.
            const stationPath = path.filter(t => isStation.has(t));
            for (let i = 0; i + 1 < stationPath.length; i++) {
                const a = stationPath[i], b = stationPath[i + 1];
                if (a === b) continue;               // repeated tpl (reversal)
                if (!adj.has(a)) adj.set(a, new Set());
                if (!adj.has(b)) adj.set(b, new Set());
                adj.get(a)!.add(b);
                adj.get(b)!.add(a);
                const key = a < b ? `${a}|${b}` : `${b}|${a}`;
                edgeWeight.set(key, (edgeWeight.get(key) || 0) + 1);
            }
            // Record every non-adjacent pair in this journey's station order.
            // Seeing X between A and B on ANY service is proof that a direct
            // A–B edge from some express is a skip, not real track adjacency.
            for (let i = 0; i < stationPath.length; i++) {
                for (let j = i + 2; j < stationPath.length; j++) {
                    const a = stationPath[i], b = stationPath[j];
                    if (a === b) continue;
                    spanned.add(a < b ? `${a}|${b}` : `${b}|${a}`);
                }
            }
        }
        path = []; calls = []; keep = false; inJourney = false;
    };

    for await (const line of openGz(file)) {
        const t = line.trimStart();

        if (t.startsWith('<Journey')) {
            if (inJourney) flush();                  // defensive: unterminated
            stats.journeys++;
            inJourney = true;
            path = []; calls = [];
            const toc = attr(t, 'toc');
            const cat = attr(t, 'trainCat');
            if (attr(t, 'isPassengerSvc') === 'false') { stats.nonPassenger++; keep = false; }
            else if (cat && EXCLUDED_TRAIN_CATS.has(cat)) { stats.bus++; keep = false; }
            else if (toc && EXCLUDED_TOCS.has(toc)) { stats.excludedToc++; keep = false; }
            else keep = true;
            // A single-line self-closed <Journey ... /> has no children.
            if (t.endsWith('/>')) flush();
            continue;
        }

        if (!inJourney) continue;

        if (t.startsWith('</Journey')) { flush(); continue; }

        const tag = t.match(/^<([A-Za-z]+)\b/)?.[1];
        if (!tag || !PATH_TAGS.has(tag)) continue;   // skips OPOR/OPIP/OPDT etc.
        const tpl = attr(t, 'tpl');
        if (!tpl) continue;
        path.push(tpl);
        if (tag !== 'PP') calls.push(tpl);           // PP = passes without stopping
    }
    flush();

    if (stats.journeys < 40000) throw new Error(`Only ${stats.journeys} journeys parsed — format changed?`);
    console.log(`TT:  ${stats.journeys} journeys → ${stats.kept} kept ` +
        `(dropped ${stats.nonPassenger} non-passenger, ${stats.bus} bus, ${stats.excludedToc} excluded-TOC)`);
    console.log(`TT:  track graph: ${adj.size} nodes, ${edgeWeight.size} edges, ${callingStations.size} calling stations`);
    return { adj, edgeWeight, callingStations, spanned, stats };
}

/**
 * Express services skip stations, producing "shortcut" edges (a nonstop
 * Paddington→Reading with no intermediate passing points yields PADTON–RDNGSTN
 * directly). Those inflate degree and fragment the corridors. Drop any edge
 * a–b that is spanned by a two-hop a–x–b, since then a and b are demonstrably
 * not adjacent on the track. Weight thresholding can't do this job: express
 * services are frequent, so shortcut edges are often heavier than the local
 * ones they bypass.
 */
function dropSkipEdges(g: GraphResult): number {
    const { adj, edgeWeight, spanned } = g;
    const doomed: Array<[string, string]> = [];

    // An edge survives only if NO journey ever put a station between its ends.
    // Using journey evidence rather than "shares a graph neighbour" matters:
    // the latter also fires on junction triangles and branch stations, which
    // deleted ~52% of edges and orphaned 764 stations.
    for (const [k] of edgeWeight) {
        if (spanned.has(k)) doomed.push(k.split('|') as [string, string]);
    }

    for (const [a, b] of doomed) {
        adj.get(a)!.delete(b);
        adj.get(b)!.delete(a);
        edgeWeight.delete(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
    for (const [n, s] of [...adj]) if (s.size === 0) adj.delete(n);

    console.log(`RED: dropped ${doomed.length} skip edges → ${adj.size} nodes, ${edgeWeight.size} edges`);
    return doomed.length;
}

// ── 3. Contract degree-2 chains into corridors ────────────────────────────
function deriveCorridors(g: GraphResult, refs: Map<string, LocationRef>, isStation: Set<string>): Corridor[] {
    const { adj, edgeWeight } = g;
    const degree = (n: string) => adj.get(n)?.size ?? 0;
    // Anchors bound a corridor: termini (deg 1) and junctions (deg >= 3).
    const isAnchor = (n: string) => degree(n) !== 2;

    const visitedEdge = new Set<string>();
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const corridors: Corridor[] = [];

    const nameOf = (tpl: string) => refs.get(tpl)?.locname || tpl;
    const crsOf = (tpl: string) => (isStation.has(tpl) ? refs.get(tpl)?.crs : undefined);

    const walk = (start: string, first: string) => {
        const seq = [start, first];
        let weight = edgeWeight.get(edgeKey(start, first)) || 0;
        visitedEdge.add(edgeKey(start, first));
        let prev = start, cur = first;

        // Follow the chain while interior nodes have exactly two neighbours.
        while (!isAnchor(cur)) {
            const next = [...(adj.get(cur) || [])].find(n => n !== prev);
            if (next === undefined) break;
            const k = edgeKey(cur, next);
            if (visitedEdge.has(k)) break;           // closed loop
            visitedEdge.add(k);
            weight = Math.min(weight, edgeWeight.get(k) || 0);
            seq.push(next);
            prev = cur; cur = next;
        }

        // A corridor is only useful if passengers can board somewhere on it.
        const stations = seq.filter(t => crsOf(t));
        if (stations.length < 2) return;

        const a = stations[0], b = stations[stations.length - 1];
        corridors.push({
            id: `${slug(nameOf(a))}-to-${slug(nameOf(b))}`,
            name: `${nameOf(a)} – ${nameOf(b)}`,
            tplSequence: seq,
            stations,
            endpointA: a,
            endpointB: b,
            journeyWeight: weight,
        });
    };

    // Start from every anchor so each chain is walked from a definite end.
    for (const n of adj.keys()) {
        if (!isAnchor(n)) continue;
        for (const nb of adj.get(n) || []) {
            if (!visitedEdge.has(edgeKey(n, nb))) walk(n, nb);
        }
    }
    // Anything left is a pure cycle with no anchor — break it arbitrarily.
    for (const n of adj.keys()) {
        for (const nb of adj.get(n) || []) {
            if (!visitedEdge.has(edgeKey(n, nb))) walk(n, nb);
        }
    }

    // Disambiguate colliding ids (two corridors between the same endpoints).
    const seen = new Map<string, number>();
    for (const c of corridors) {
        const n = (seen.get(c.id) || 0) + 1;
        seen.set(c.id, n);
        if (n > 1) { c.id = `${c.id}-${n}`; c.name = `${c.name} (${n})`; }
    }

    console.log(`SEG: ${corridors.length} corridors with >=2 public stations`);
    return corridors;
}

// ── 4. Per-station assignment: lines + directions ─────────────────────────
function assignStations(corridors: Corridor[], g: GraphResult, refs: Map<string, LocationRef>) {
    const nameOf = (tpl: string) => refs.get(tpl)?.locname || tpl;
    const stations = new Map<string, any>();

    for (const c of corridors) {
        c.stations.forEach((tpl, i) => {
            if (!g.callingStations.has(tpl)) return;  // passed through, never stops
            const ref = refs.get(tpl)!;
            if (!stations.has(tpl)) {
                stations.set(tpl, {
                    naptanId: `9100${tpl}`,
                    tiploc: tpl,
                    crs: ref.crs,
                    name: ref.locname,
                    lines: {} as Record<string, { directions: string[] }>,
                });
            }
            // Direction = which end of the corridor you're heading for. At a
            // corridor endpoint there is only one way to go, which is what
            // makes the app's single-option auto-skip fire.
            const dirs: string[] = [];
            if (i < c.stations.length - 1) dirs.push(`towards-${slug(nameOf(c.endpointB))}`);
            if (i > 0) dirs.push(`towards-${slug(nameOf(c.endpointA))}`);
            if (dirs.length) stations.get(tpl)!.lines[c.id] = { directions: dirs };
        });
    }
    return stations;
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
    const refs = await loadReference();
    const isStation = loadStationSet();
    const graph = await buildGraph(refs, isStation);
    const skipEdgesDropped = dropSkipEdges(graph);
    const corridors = deriveCorridors(graph, refs, isStation);
    const stations = assignStations(corridors, graph, refs);

    // Reconcile against the NaPTAN-derived station list we already have.
    let known = new Set<string>();
    if (fs.existsSync(NR_STATIONS)) {
        const raw = JSON.parse(fs.readFileSync(NR_STATIONS, 'utf8'));
        known = new Set((raw.stations || raw).map((s: any) => s.tiploc));
    }
    const derived = [...stations.keys()];
    const notInNaptan = derived.filter(t => !known.has(t));
    const naptanWithoutCorridor = [...known].filter(t => !stations.has(t));

    const lineCounts = derived.map(t => Object.keys(stations.get(t).lines).length);
    const histogram: Record<string, number> = {};
    for (const n of lineCounts) {
        const b = n >= 6 ? '6+' : String(n);
        histogram[b] = (histogram[b] || 0) + 1;
    }

    const out = {
        meta: {
            generated: new Date().toISOString(),
            timetableFile: path.basename(findFile('_v8.xml.gz')),
            referenceFile: path.basename(findFile('_ref_v99.xml.gz')),
            method: 'station-level track graph (calls + passing points, CRS-filtered) '
                + '→ 2-hop transitive reduction to drop express skip edges '
                + '→ degree-2 chain contraction',
            skipEdgesDropped,
            excludedTocs: [...EXCLUDED_TOCS],
            warning: 'line ids and direction ids are user-persisted keys — review before seeding, then hold stable',
        },
        stats: {
            ...graph.stats,
            corridors: corridors.length,
            stationsAssigned: stations.size,
            naptanStationsKnown: known.size,
            derivedNotInNaptan: notInNaptan.length,
            naptanWithoutCorridor: naptanWithoutCorridor.length,
            linesPerStation: histogram,
        },
        samples: {
            PADTON: stations.get('PADTON') ?? null,
            KNGX: stations.get('KNGX') ?? null,
            CAMBDGE: stations.get('CAMBDGE') ?? null,
            ELYY: stations.get('ELYY') ?? null,
        },
        unreconciled: { derivedNotInNaptan: notInNaptan, naptanWithoutCorridor },
        lines: corridors.map(c => ({
            id: c.id, name: c.name,
            endpointA: c.endpointA, endpointB: c.endpointB,
            stationCount: c.stations.length,
            journeyWeight: c.journeyWeight,
            stations: c.stations,
        })),
        stations: Object.fromEntries(stations),
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`\nOUT: ${OUT_FILE}`);
    console.log(`     corridors=${corridors.length} stations=${stations.size}`);
    console.log(`     lines-per-station: ${JSON.stringify(histogram)}`);
    console.log(`     unreconciled: ${notInNaptan.length} derived-not-in-naptan, ${naptanWithoutCorridor.length} naptan-without-corridor`);
}

main().catch(err => { console.error(err); process.exit(1); });
