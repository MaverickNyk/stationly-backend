#!/usr/bin/env node
/**
 * Staging-vs-prod regression check for the prediction-source change.
 * Read-only: GETs /api/v1/stations/predictions/{naptanId} from both
 * environments simultaneously and classifies every row difference.
 *
 * Usage (prod and staging have disjoint client-key sets):
 *   PROD_API_KEY=<prod key> STAGING_API_KEY=<staging key> node .scripts/compare_predictions.mjs [naptanId ...]
 *   (STATIONLY_API_KEY works as a fallback for both when they ever match)
 *
 * With no args, runs the full station matrix from
 * docs/TEST_PLAN_PREDICTION_SOURCES.md. Exit code 1 if any station needs review.
 */
import https from 'https';

const PROD = process.env.PROD_URL || 'https://api.stationly.co.uk';
const STAGING = process.env.STAGING_URL || 'https://staging-api.stationly.co.uk';
const KEYS = {
    [process.env.PROD_URL || 'https://api.stationly.co.uk']: process.env.PROD_API_KEY || process.env.STATIONLY_API_KEY,
    [process.env.STAGING_URL || 'https://staging-api.stationly.co.uk']: process.env.STAGING_API_KEY || process.env.STATIONLY_API_KEY,
};
if (!KEYS[PROD] || !KEYS[STAGING]) { console.error('Set PROD_API_KEY and STAGING_API_KEY (or STATIONLY_API_KEY)'); process.exit(2); }

// kind=mix → staging must match prod modulo fetch-timing noise.
// kind=board → terminus/board improvements are expected; anything else flags.
const MATRIX = [
    ['940GZZLUOXC', 'mix',   'Oxford Circus (tube)'],
    ['940GZZLUSTD', 'mix',   'Stratford (tube naptan)'],
    ['490000036R',  'mix',   'Camden Town (bus)'],
    ['490000003R',  'mix',   'Aldgate (bus)'],
    ['940GZZDLBNK', 'mix',   'Bank (DLR)'],
    ['940GZZCRECR', 'mix',   'East Croydon (tram)'],
    ['940GZZLUKWG', 'mix',   'Kew Gardens (tube naptan + live OG)'],
    ['910GFRNDXR',  'board', 'Farringdon (XR through)'],
    ['910GABWDXR',  'board', 'Abbey Wood (XR terminus)'],
    ['910GWOLWXR',  'board', 'Woolwich (XR)'],
    ['910GHACKNYC', 'board', 'Hackney Central (OG)'],
    ['910GGNRSBRY', 'board', 'Gunnersbury (OG, shares tracks w/ District)'],
    ['910GENFLDTN', 'board', 'Enfield Town (OG terminus)'],
    ['910GHGHI',    'board', 'Highbury & Islington (OG 2 lines)'],
    ['910GCLPHMJ1', 'board', 'Clapham Junction (OG 2 lines, terminus)'],
    ['910GSTFD',    'board', 'Stratford rail (XR+OG)'],
    ['910GLIVST',   'board', 'Liverpool St rail (XR+OG)'],
    ['910GROMFORD', 'board', 'Romford (XR+OG)'],
];

const TIME_SHIFT_TOLERANCE_MS = 150_000; // two 60s caches + fetch skew

function get(base, naptanId) {
    const url = new URL(`${base}/api/v1/stations/predictions/${naptanId}`);
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'X-Stationly-Key': KEYS[base] } }, res => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`${base} → HTTP ${res.statusCode}: ${b.slice(0, 120)}`));
                try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

/** rows: [{key: line|dir|destId|platform|displayName, eta}] */
function rows(resp) {
    const out = [];
    for (const [lid, line] of Object.entries(resp.lines || {}))
        for (const [dir, d] of Object.entries(line.dirs || {}))
            for (const p of d.preds)
                out.push({ key: `${lid}|${dir}|${p.destId}|${p.platform}|${p.displayName}`, eta: Date.parse(p.eta), raw: `${lid}|${dir}|${p.platform}|${p.eta}|${p.displayName}` });
    return out;
}

function compare(prodRows, stagRows) {
    const p = [...prodRows], s = [...stagRows];
    const res = { match: 0, timeShift: 0, cftUpgrade: [], prodOnly: [], stagOnly: [] };
    // exact matches (key + eta)
    for (let i = p.length - 1; i >= 0; i--) {
        const j = s.findIndex(r => r.key === p[i].key && r.eta === p[i].eta);
        if (j >= 0) { res.match++; p.splice(i, 1); s.splice(j, 1); }
    }
    // same identity, small eta shift (cache/fetch skew or board precision)
    for (let i = p.length - 1; i >= 0; i--) {
        const j = s.findIndex(r => r.key === p[i].key && Math.abs(r.eta - p[i].eta) <= TIME_SHIFT_TOLERANCE_MS);
        if (j >= 0) { res.timeShift++; p.splice(i, 1); s.splice(j, 1); }
    }
    // terminus upgrade: prod "Check Front of Train" replaced by real destinations on the same line
    for (let i = p.length - 1; i >= 0; i--) {
        if (!p[i].key.includes('|Check Front of Train')) continue;
        const line = p[i].key.split('|')[0];
        if (stagRows.some(r => r.key.startsWith(`${line}|`) && !r.key.includes('|Check Front of Train'))) {
            res.cftUpgrade.push(p[i].raw); p.splice(i, 1);
        }
    }
    res.prodOnly = p.map(r => r.raw);
    res.stagOnly = s.map(r => r.raw);
    return res;
}

const args = process.argv.slice(2);
const targets = args.length ? MATRIX.filter(m => args.includes(m[0])).concat(args.filter(a => !MATRIX.some(m => m[0] === a)).map(a => [a, 'board', a])) : MATRIX;

let needsReview = 0;
for (const [id, kind, label] of targets) {
    let prod, stag;
    try { [prod, stag] = await Promise.all([get(PROD, id), get(STAGING, id)]); }
    catch (e) { console.log(`\n== ${label} [${id}] — FETCH ERROR: ${e.message}`); needsReview++; continue; }
    const r = compare(rows(prod), rows(stag));
    // mix stations must not lose or invent rows; board stations may differ in expected ways
    const unexplained = r.prodOnly.length + (kind === 'mix' ? r.stagOnly.length : 0);
    const verdict = unexplained === 0 ? 'OK' : 'REVIEW';
    if (verdict !== 'OK') needsReview++;
    console.log(`\n== ${label} [${id}] kind=${kind} → ${verdict}   (match=${r.match} timeShift=${r.timeShift} cftUpgrade=${r.cftUpgrade.length})`);
    for (const x of r.cftUpgrade) console.log(`   CFT-UPGRADED   ${x}`);
    for (const x of r.prodOnly) console.log(`   PROD-ONLY  ⚠️  ${x}`);
    for (const x of r.stagOnly) console.log(`   STAG-ONLY  ${kind === 'mix' ? '⚠️' : 'ℹ️  (board extra: true departure / delayed keep)'}  ${x}`);
}
console.log(`\n=== ${needsReview === 0 ? 'ALL CLEAR' : needsReview + ' station(s) need review'} ===`);
process.exit(needsReview ? 1 : 0);
