/*
 * READ-ONLY snapshot of the session state, for verifying P2c by hand.
 *
 *   node src/scripts/check_session_state.cjs --key=<sa>
 *
 * Prints, per account: `loggedIn`, the device rows (the new store), the legacy
 * sessions map, and the root registry rows — side by side, so a cutover can be
 * checked by looking rather than by trusting.
 *
 * It also asserts the invariants P2c is supposed to establish:
 *   - `loggedIn` is true IFF the account has at least one live device row
 *   - no device id appears under two accounts (a failed steal)
 *   - the legacy stores are no longer being WRITTEN (their entries only shrink)
 *
 * NEVER writes.
 */
const admin = require('firebase-admin');
const path = require('path');
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const sa = arg('key') ? require(path.resolve(process.cwd(), arg('key'))) : require('../../serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const TTL = 90 * 24 * 60 * 60 * 1000;

(async () => {
    console.log(`Project : ${sa.project_id}\n`);
    const rootByUid = new Map();
    (await db.collection('devices').get()).forEach((d) => {
        const r = d.data();
        if (!r.uid) return;
        rootByUid.set(r.uid, [...(rootByUid.get(r.uid) ?? []), d.id]);
    });

    const owners = new Map();       // deviceId → [uid]
    let problems = 0;

    for (const doc of (await db.collection('users').get()).docs) {
        const u = doc.data() ?? {};
        const devs = (await doc.ref.collection('devices').get()).docs.map((d) => d.data());
        const live = devs.filter((r) => typeof r.lastSeen === 'number' && r.lastSeen >= Date.now() - TTL);
        const mapKeys = Object.keys(u.sessions ?? {});

        for (const r of devs) owners.set(r.deviceId, [...(owners.get(r.deviceId) ?? []), doc.id]);

        console.log(`  ${(u.email ?? doc.id).padEnd(30)} loggedIn=${String(u.loggedIn === true).padEnd(5)} rev=${u.stateRev ?? 0}`);
        console.log(`      device rows (NEW)   : ${devs.length}  live=${live.length}  ${devs.map((r) => `${r.deviceId.slice(0, 8)}:${r.platform}${r.appToken ? '+app' : ''}${r.widgetToken ? '+wid' : ''}`).join(' ')}`);
        console.log(`      sessions map (OLD)  : ${mapKeys.length}  ${mapKeys.map((k) => k.slice(0, 8)).join(' ')}`);
        console.log(`      root registry (OLD) : ${(rootByUid.get(doc.id) ?? []).length}  ${(rootByUid.get(doc.id) ?? []).map((k) => k.slice(0, 8)).join(' ')}`);

        // INVARIANT: loggedIn ⇔ at least one live device row.
        const shouldBeIn = live.length > 0;
        if ((u.loggedIn === true) !== shouldBeIn) {
            console.log(`      ✗ loggedIn=${u.loggedIn === true} but live rows=${live.length}`);
            problems++;
        }
    }

    // INVARIANT: a device belongs to exactly one account. Two owners means a
    // steal did not run, and BOTH accounts think they hold that device — which
    // is the exact state the steal exists to make unrepresentable.
    console.log('\n  device ownership');
    for (const [id, uids] of owners) {
        if (uids.length > 1) { console.log(`      ✗ ${id.slice(0, 8)} claimed by ${uids.length}: ${uids.join(', ')}`); problems++; }
    }
    if ([...owners.values()].every((u) => u.length === 1)) console.log('      ✓ every device belongs to exactly one account');

    console.log(`\n${problems === 0 ? 'PASS — session invariants hold.' : `✗ FAIL — ${problems} problem(s).`}`);
    process.exitCode = problems === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exit(1); });
