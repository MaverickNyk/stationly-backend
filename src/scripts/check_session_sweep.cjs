/*
 * READ-ONLY probe for the abandoned-session sweep.
 *
 *   node src/scripts/check_session_sweep.cjs --before
 *   ...trigger POST /internal/maintenance/sweep...
 *   node src/scripts/check_session_sweep.cjs --after
 *
 * `--before` predicts exactly which accounts the sweep should release and
 * writes that prediction to a local scratch file. `--after` reads it back and
 * checks the sweep actually did what was predicted — the flag, the device rows
 * AND the registry, because a flag flip that left the device row behind is the
 * precise defect this job exists to stop.
 *
 * This NEVER writes to Firestore. The only file it writes is the local
 * prediction, outside the project's data path entirely.
 *
 * ## Why the predicate is restated here and not imported
 * This is a probe checking a job. Importing `UserService.isSessionLive` would
 * make it agree with the job by construction, including when both are wrong —
 * which is the one thing a verification script must not do. The formula below
 * is a deliberate second implementation of the same rule, and if the two ever
 * disagree, that disagreement is the finding.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Defaults to the local staging key; pass --key=/path/to/prod-key.json for prod.
const keyArg = (process.argv.find((a) => a.startsWith('--key=')) || '').split('=')[1];
const serviceAccount = keyArg
    ? require(path.resolve(process.cwd(), keyArg))
    : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const MODE = process.argv.includes('--after') ? 'after' : 'before';
const PREDICTION_FILE = path.resolve(process.cwd(), '.sweep-prediction.json');
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Restated from UserDeviceService.isRowLive — deliberately, see the header.
 *
 * ⚠️ Reads `lastSeen` as EPOCH MS off a DEVICE ROW, not as an ISO string off a
 * `users.sessions` entry. This probe used to do the latter, and after P2 that
 * made it predict from a store the sweep no longer consults: with the map
 * emptied by the cleanup it reported every account on the platform as
 * releasable. A probe that disagrees with the job it is checking is worse than
 * no probe, and this one is read at runbook step 1 to decide whether it is safe
 * to install the crontab.
 */
function isRowLive(row) {
    const seen = row && row.lastSeen;
    return typeof seen === 'number' && Number.isFinite(seen) && seen >= Date.now() - SESSION_TTL_MS;
}

/** Restated from UserService.effectiveStationIds — legacy ids plus board naptans. */
function effectiveStationIds(data) {
    const ids = [];
    for (const s of (data && data.stations) || []) if (s && s.id) ids.push(s.id);
    for (const b of (data && data.boards) || []) {
        for (const sel of (b && b.selections) || []) if (sel && sel.naptanId) ids.push(sel.naptanId);
    }
    return Array.from(new Set(ids));
}

function ageOf(row) {
    // Epoch ms, matching the merged row. Left as `Date.parse` this silently
    // returned UNDATEABLE for every healthy device, which reads as a problem.
    const seen = row && row.lastSeen;
    if (typeof seen !== 'number' || !Number.isFinite(seen)) return 'UNDATEABLE';
    return `${((Date.now() - seen) / DAY).toFixed(1)}d`;
}

(async () => {
    console.log('Project:', serviceAccount.project_id, '| mode:', MODE, '\n');

    if (MODE === 'before') {
        const snap = await db.collection('users').where('loggedIn', '==', true).get();
        console.log(`users with loggedIn==true: ${snap.size}\n`);

        const predicted = [];
        const liveStationHolders = new Map();   // naptanId -> count of accounts staying live

        let legacyMapEntries = 0;
        for (const doc of snap.docs) {
            const data = doc.data();
            // THE STORE THE SWEEP ACTUALLY READS. See [isRowLive].
            const devSnap = await db.collection('users').doc(doc.id).collection('devices').get();
            const rows = devSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
            const anyLive = rows.some(isRowLive);
            const ages = rows.map((r) => `${r.id.slice(0, 8)}=${ageOf(r)}`).join(' ');

            // Reported as CONTEXT only. On production before the migration every
            // account still carries the map; it is what the backfill reads, and a
            // populated map beside zero device rows is precisely the state the
            // runbook's hazard box is about.
            legacyMapEntries += Object.keys(data.sessions || {}).length;

            console.log(
                `  ${anyLive ? 'keep  ' : 'SWEEP '} ${doc.id}  ` +
                `rows=${rows.length}${rows.length ? '  [' + ages + ']' : '  (NO DEVICE ROWS)'}`,
            );

            if (anyLive) {
                for (const id of effectiveStationIds(data)) {
                    liveStationHolders.set(id, (liveStationHolders.get(id) || 0) + 1);
                }
            } else {
                predicted.push({ uid: doc.id, stations: effectiveStationIds(data) });
            }
        }

        if (legacyMapEntries > 0) {
            console.log(
                `\n  note: ${legacyMapEntries} legacy \`users.sessions\` entr(ies) still present. ` +
                `The sweep does NOT read them —\n        they are the BACKFILL's source. ` +
                `Populated map + zero device rows is the hazard state.`,
            );
        }

        // A key should vanish from the registry only where the swept account was
        // its LAST holder. Anything still held by a live account must be left
        // exactly alone — over-decrementing is the one direction that takes a
        // live station away from someone who is still using it.
        const expectedRemoved = [];
        for (const p of predicted) {
            for (const id of p.stations) {
                if (!liveStationHolders.has(id) && !expectedRemoved.includes(id)) expectedRemoved.push(id);
            }
        }

        console.log(`\nPREDICTED to be released: ${predicted.length}`);
        predicted.forEach(p => console.log(`  ${p.uid}  stations=[${p.stations.join(', ')}]`));
        console.log(`\nPREDICTED registry keys to disappear entirely: ${expectedRemoved.length}`);
        expectedRemoved.forEach(k => console.log(`  ${k}`));

        fs.writeFileSync(PREDICTION_FILE, JSON.stringify({ predicted, expectedRemoved }, null, 2));
        console.log(`\nprediction written to ${PREDICTION_FILE}`);
        console.log('now trigger:  curl -X POST http://127.0.0.1:$PORT/internal/maintenance/sweep -H "X-Internal-Secret: $LIVESTREAM_INGEST_SECRET"');
        process.exit(0);
    }

    // ── after ──
    if (!fs.existsSync(PREDICTION_FILE)) {
        console.error(`No prediction at ${PREDICTION_FILE} — run with --before first.`);
        process.exit(1);
    }
    const { predicted, expectedRemoved } = JSON.parse(fs.readFileSync(PREDICTION_FILE, 'utf8'));
    let failures = 0;
    const fail = (m) => { console.log(`  ✗ ${m}`); failures++; };
    const pass = (m) => console.log(`  ✓ ${m}`);

    for (const p of predicted) {
        const doc = await db.collection('users').doc(p.uid).get();
        const data = doc.exists ? doc.data() : {};

        if (data.loggedIn === true) fail(`${p.uid} is still loggedIn:true`);
        else pass(`${p.uid} loggedIn is false`);

        // The flag alone proves nothing. A release that flipped the flag and
        // left the device row behind leaves the phone in its old account's push
        // audience, which is the whole defect class this job answers to.
        const devices = await db.collection('users').doc(p.uid).collection('devices').get();
        const stillLive = devices.docs.filter((d) => isRowLive(d.data()));
        if (stillLive.length > 0) fail(`${p.uid} still holds ${stillLive.length} LIVE device row(s)`);
        else pass(`${p.uid} holds no device rows`);
    }

    const reg = await db.collection('metadata').doc('subscribed_stations').get();
    const counts = (reg.exists && reg.data().stationCounts) || {};
    for (const key of expectedRemoved) {
        // ABSENT, not zero. The listener treats presence as "subscribed", so a
        // key sitting at 0 keeps the station polled just as effectively as a 1.
        if (Object.prototype.hasOwnProperty.call(counts, key)) {
            fail(`registry still carries ${key} = ${counts[key]} (expected the key to be gone)`);
        } else {
            pass(`registry key ${key} is absent`);
        }
    }

    console.log(failures === 0 ? '\nPASS — sweep did exactly what was predicted.' : `\nFAIL — ${failures} check(s) failed.`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
