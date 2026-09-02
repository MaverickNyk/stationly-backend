/*
 * READ-ONLY proof that P2's collection-group queries actually work.
 *
 *   node src/scripts/check_device_indexes.cjs --key=<service account>
 *
 * A missing collection-group index FAILS THE QUERY OUTRIGHT — FAILED_PRECONDITION,
 * with a console link in the message. It does not degrade and it does not get
 * slower, so "the code looks right" tells you nothing. This runs the real
 * queries and reports what Firestore actually did.
 *
 * ## Why it runs the queries instead of reading the index metadata
 * The metadata says an index was REQUESTED. Only a query says it is BUILT and
 * queryable — index builds are asynchronous, and the gap between the two states
 * is exactly where a deploy would fail. Same reason the P0 probes restate their
 * predicates instead of importing them: ask the system, not the description.
 *
 * Also checks the third case the design says to verify rather than assume: that
 * an UNFILTERED `collectionGroup('devices').get()` needs no index of its own.
 * This repo has never managed a Firestore index deliberately, so none of the
 * usual instincts about what is automatic have been tested here.
 *
 * NEVER writes.
 */
const admin = require('firebase-admin');
const path = require('path');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const keyArg = arg('key');
const sa = keyArg ? require(path.resolve(process.cwd(), keyArg)) : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const CASES = [
    {
        name: "collectionGroup('devices').where('deviceId','==',…)",
        why: 'the steal check on login — design 4.1',
        run: () => db.collectionGroup('devices').where('deviceId', '==', '__probe_no_such_device__').limit(1).get(),
        required: true,
    },
    {
        name: "collectionGroup('devices').where('lastSeen','<',…)",
        why: 'the abandoned-session sweep — design 9',
        run: () => db.collectionGroup('devices').where('lastSeen', '<', 1).limit(1).get(),
        required: true,
    },
    {
        name: "collectionGroup('devices') unfiltered",
        why: 'the broadcast audience — design says VERIFY this needs no index',
        run: () => db.collectionGroup('devices').limit(1).get(),
        required: true,
    },
    {
        // ⚠️ MIGRATION HAZARD, found by this probe on 2026-08-25.
        //
        // A collection GROUP matches every collection with that name at ANY
        // depth — which includes the ROOT `devices` collection P2 is retiring.
        // So until the root collection is gone, every collection-group query
        // returns the old rows alongside the new ones, and the steal check would
        // read a stale root row as a live session on another account.
        //
        // The count below is the thing to watch: it must reach 0 before the
        // cutover, or the queries must filter on `ref.parent.parent != null`.
        // `UserDeviceService` does exactly that, so the ordering is belt and
        // braces rather than the only protection.
        name: "root collection('devices') — must be EMPTY before P2c",
        why: 'a collection group also matches the root collection being retired',
        run: () => db.collection('devices').limit(1).get(),
        required: false,
        expectEmpty: true,
    },
    {
        name: "collection('users/__probe__/devices') per-account read",
        why: 'the query this design runs most — a known path, needs no index',
        // NOT `__probe__` — Firestore reserves any id matching __.*__ and
        // rejects it with INVALID_ARGUMENT before the query is even planned,
        // which reads as a failure of the thing being tested when it is not.
        run: () => db.collection('users').doc('probe-no-such-user').collection('devices').limit(1).get(),
        required: true,
    },
];

(async () => {
    console.log(`Project : ${sa.project_id}\n`);
    let failures = 0;

    for (const c of CASES) {
        try {
            const snap = await c.run();
            const bad = c.expectEmpty && snap.size > 0;
            console.log(`  ${bad ? '⚠' : '✓'} ${c.name}`);
            console.log(`      ${c.why}  —  returned ${snap.size} doc(s)`);
            if (bad) {
                console.log('      STILL POPULATED — see the comment on this case. Not a');
                console.log('      failure yet; it becomes one the moment P2c ships.');
            }
        } catch (e) {
            const missing = /FAILED_PRECONDITION|requires an index/i.test(e.message);
            console.log(`  ✗ ${c.name}`);
            console.log(`      ${c.why}`);
            console.log(`      ${missing ? 'INDEX MISSING' : 'ERROR'}: ${e.message.split('\n')[0]}`);
            const link = (e.message.match(/https:\/\/\S+/) || [])[0];
            if (link) console.log(`      create it: ${link}`);
            if (c.required) failures++;
        }
    }

    console.log();
    if (failures > 0) {
        console.log(`✗ FAIL — ${failures} required quer${failures === 1 ? 'y' : 'ies'} cannot run.`);
        console.log('  P2c MUST NOT ship until these pass: a missing collection-group index');
        console.log('  fails the login steal check outright, and the login path has no fallback.');
        process.exitCode = 1;
    } else {
        console.log('PASS — every query P2 depends on runs.');
        console.log('  Note an empty result is a real pass here: it proves Firestore ACCEPTED');
        console.log('  the query, which is the whole question. Data arrives with P2b.');
    }
})().catch((e) => { console.error(e.message); process.exit(1); });
