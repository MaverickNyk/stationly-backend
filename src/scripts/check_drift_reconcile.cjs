/*
 * READ-ONLY probe for drift reconciliation.
 *
 *   node src/scripts/check_drift_reconcile.cjs --email=someone@example.com   # narrow first
 *   node src/scripts/check_drift_reconcile.cjs --before
 *   ...trigger POST /internal/maintenance/reconcile...
 *   node src/scripts/check_drift_reconcile.cjs --after
 *
 * Reconcile is the dangerous one of the two jobs. Sweep acts through an
 * existing tested transaction over a narrow query and can at worst be slow.
 * This one compares a snapshot taken across a whole collection scan against a
 * document every login, logout and board edit also writes, so a wrong version
 * of it does not merely fail to fix drift — it can DELETE a live user's
 * registry entry and stop their boards updating, silently. Hence: predict
 * first, confirm the narrow already-understood case, then trust it broadly.
 *
 * NEVER writes to Firestore. `--before` writes one local scratch file.
 *
 * ## Why the formulas are restated rather than imported
 * A probe that imports the job's own predicate agrees with the job by
 * construction, including when both are wrong. These are a deliberate second
 * implementation; a disagreement between them is the finding, not a bug in
 * the script.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const keyArg = (process.argv.find((a) => a.startsWith('--key=')) || '').split('=')[1];
const serviceAccount = keyArg
    ? require(path.resolve(process.cwd(), keyArg))
    : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const emailArg = (process.argv.find((a) => a.startsWith('--email=')) || '').split('=')[1];
const uidArg = (process.argv.find((a) => a.startsWith('--uid=')) || '').split('=')[1];
const MODE = process.argv.includes('--after') ? 'after' : 'before';
const PREDICTION_FILE = path.resolve(process.cwd(), '.reconcile-prediction.json');
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Restated from UserDeviceService.isRowLive.
 *
 * ⚠️ EPOCH MS off a DEVICE ROW, not an ISO string off a `users.sessions` entry.
 * This predicted from the retired map until P2's cleanup emptied it, at which
 * point every account read as having no live session — so the predicted target
 * registry was EMPTY and the probe forecast draining every station on the
 * platform. The job itself would have refused that (`reconcileCounts` rejects an
 * empty target against a non-empty registry), but the probe is what an operator
 * reads BEFORE running it, and a forecast of total destruction is not a useful
 * thing to be wrong about.
 */
function isRowLive(row) {
    const seen = row && row.lastSeen;
    return typeof seen === 'number' && Number.isFinite(seen) && seen >= Date.now() - SESSION_TTL_MS;
}

/** Restated from UserService.effectiveStationIds. */
function effectiveStationIds(data) {
    const ids = [];
    for (const s of (data && data.stations) || []) if (s && s.id) ids.push(s.id);
    for (const b of (data && data.boards) || []) {
        for (const sel of (b && b.selections) || []) if (sel && sel.naptanId) ids.push(sel.naptanId);
    }
    return Array.from(new Set(ids));
}

async function readRegistry() {
    const doc = await db.collection('metadata').doc('subscribed_stations').get();
    return (doc.exists && doc.data().stationCounts) || {};
}

/** The Σ the job will compute: one per LIVE account, per effective station id. */
async function recompute() {
    const snap = await db.collection('users').select('loggedIn', 'stations', 'boards').get();
    const target = {};
    const healed = [];
    for (const doc of snap.docs) {
        const data = doc.data();
        // The subcollection, which is what the job reads. See [isRowLive].
        const devSnap = await db.collection('users').doc(doc.id).collection('devices').get();
        const hasLive = devSnap.docs.some((d) => isRowLive(d.data()));
        if (data.loggedIn === true !== hasLive) {
            healed.push({ uid: doc.id, stored: data.loggedIn === true, actual: hasLive });
        }
        // The tally uses the HEALED value, never the stored flag — counting off
        // the stored one would contradict the correction made in the same pass.
        if (hasLive) for (const id of effectiveStationIds(data)) target[id] = (target[id] || 0) + 1;
    }
    return { target, healed, scanned: snap.size };
}

function diff(current, target) {
    const out = [];
    for (const key of new Set([...Object.keys(current), ...Object.keys(target)])) {
        const have = current[key] || 0;
        const want = target[key] || 0;
        if (have !== want) out.push({ key, have, want });
    }
    return out;
}

(async () => {
    console.log('Project:', serviceAccount.project_id, '| mode:', MODE, '\n');

    // ── narrow mode: one known account, fully predictable, before anything broad ──
    if (emailArg || uidArg) {
        let doc;
        if (uidArg) {
            doc = await db.collection('users').doc(uidArg).get();
        } else {
            const q = await db.collection('users').where('email', '==', emailArg).limit(1).get();
            doc = q.docs[0];
        }
        if (!doc || !doc.exists) { console.error('No such user.'); process.exit(1); }

        const data = doc.data();
        // The device subcollection decides, exactly as the job does. The legacy
        // map is printed beside it as context, never used to answer.
        const devSnap = await db.collection('users').doc(doc.id).collection('devices').get();
        const rows = devSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const hasLive = rows.some(isRowLive);
        const legacy = Object.keys(data.sessions || {}).length;
        const stations = effectiveStationIds(data);

        console.log(`uid:            ${doc.id}`);
        console.log(`email:          ${data.email}`);
        console.log(`loggedIn:       ${data.loggedIn}`);
        console.log(`device rows:    ${rows.length}  live=${rows.filter(isRowLive).length}` +
                    `${rows.length ? '  [' + rows.map((r) => r.id.slice(0, 8)).join(' ') + ']' : ''}`);
        if (legacy) console.log(`legacy sessions:${String(legacy).padStart(2)}  (context only — the job does not read these)`);
        console.log(`any live:       ${hasLive}`);
        console.log(`stations:       [${stations.join(', ')}]`);
        console.log('');
        if (data.loggedIn === true !== hasLive) {
            console.log(`PREDICT: loggedIn heals ${data.loggedIn === true} → ${hasLive}`);
        } else {
            console.log('PREDICT: no loggedIn change');
        }
        console.log(`PREDICT: registry keys touched by THIS account: ${hasLive ? stations.length : 0}`);
        if (!hasLive && stations.length === 0) {
            console.log('         (contributes nothing before or after — the registry must not move at all)');
        }
        process.exit(0);
    }

    if (MODE === 'before') {
        const current = await readRegistry();
        const { target, healed, scanned } = await recompute();
        const d = diff(current, target);

        console.log(`users scanned:        ${scanned}`);
        console.log(`registry keys now:    ${Object.keys(current).length}`);
        console.log(`recomputed keys:      ${Object.keys(target).length}\n`);

        console.log(`PREDICTED loggedIn heals: ${healed.length}`);
        healed.forEach(h => console.log(`  ${h.uid}: stored=${h.stored} actual=${h.actual}`));

        console.log(`\nPREDICTED registry changes: ${d.length}`);
        d.forEach(x => console.log(`  ${x.key}: ${x.have} → ${x.want <= 0 ? 'REMOVED' : x.want}`));
        if (d.length === 0) console.log('  (none — registry already exact)');

        fs.writeFileSync(PREDICTION_FILE, JSON.stringify({ target, healed, diff: d }, null, 2));
        console.log(`\nprediction written to ${PREDICTION_FILE}`);
        console.log('now trigger:  curl -X POST http://127.0.0.1:$PORT/internal/maintenance/reconcile -H "X-Internal-Secret: $LIVESTREAM_INGEST_SECRET"');
        console.log('the response must report registrySkippedDueToRace=false on a quiet window;');
        console.log('true with no known concurrent activity is a bug signal, not something to shrug off.');
        process.exit(0);
    }

    // ── after ──
    if (!fs.existsSync(PREDICTION_FILE)) {
        console.error(`No prediction at ${PREDICTION_FILE} — run with --before first.`);
        process.exit(1);
    }
    const predicted = JSON.parse(fs.readFileSync(PREDICTION_FILE, 'utf8'));
    const current = await readRegistry();
    let failures = 0;

    const remaining = diff(current, predicted.target);
    if (remaining.length === 0) {
        console.log(`  ✓ registry matches the independent recompute exactly (${Object.keys(current).length} keys)`);
    } else {
        remaining.forEach(x => console.log(`  ✗ ${x.key}: registry has ${x.have}, recompute says ${x.want}`));
        failures += remaining.length;
    }

    // Deleted keys must be genuinely absent, never parked at zero.
    for (const x of predicted.diff.filter(y => y.want <= 0)) {
        if (Object.prototype.hasOwnProperty.call(current, x.key)) {
            console.log(`  ✗ ${x.key} should have been removed, but the key is still present (= ${current[x.key]})`);
            failures++;
        } else {
            console.log(`  ✓ ${x.key} removed, key absent`);
        }
    }

    for (const h of predicted.healed) {
        const doc = await db.collection('users').doc(h.uid).get();
        const now = doc.exists ? doc.data().loggedIn === true : false;
        if (now === h.actual) console.log(`  ✓ ${h.uid} loggedIn healed to ${now}`);
        else { console.log(`  ✗ ${h.uid} loggedIn is ${now}, expected ${h.actual}`); failures++; }
    }

    console.log(failures === 0 ? '\nPASS — registry is exact and every heal landed.' : `\nFAIL — ${failures} check(s) failed.`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
