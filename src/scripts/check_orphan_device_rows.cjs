/*
 * READ-ONLY. Device rows whose ACCOUNT DOCUMENT no longer exists.
 *
 *   node src/scripts/check_orphan_device_rows.cjs --key=<sa>
 *
 * ## What it catches, and why nothing else can
 * `/device/register` writes `users/{uid}/devices/{deviceId}`. Firestore is happy
 * to create a subcollection under a document that does not exist — the parent
 * becomes a "phantom": `get()` says it is absent while the path still resolves
 * and the console lists it greyed.
 *
 * A row written that way is UNREACHABLE BY EVERY OTHER CHECK. The sweep queries
 * `users where loggedIn == true`; the reconcile scans `users` documents; both
 * iterate accounts, and a deleted account is in neither. Meanwhile the row is
 * still matched by the unfiltered `collectionGroup('devices')` the broadcast
 * audience uses, and `ref.parent.parent` is non-null so the retired-root-row
 * filter does not exclude it either. It sits in the audience forever.
 *
 * The window that produces one: `deleteAccount` revokes REFRESH tokens, but an
 * ID token already in a client's hand stays signature-valid for about an hour.
 * If `/device/register` verifies it without `checkRevoked`, a foreground inside
 * that hour re-creates the row under the account that was just deleted.
 *
 * So this is the probe for that fix. Zero orphans after an account deletion plus
 * a few foregrounds is the pass.
 *
 * NEVER writes.
 */
const admin = require('firebase-admin');
const path = require('path');
const keyArg = (process.argv.find((a) => a.startsWith('--key=')) || '').split('=')[1];
const sa = keyArg ? require(path.resolve(process.cwd(), keyArg)) : require('../../serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

(async () => {
    console.log(`Project : ${sa.project_id}\n`);
    const snap = await db.collectionGroup('devices').get();

    const byParent = new Map();
    let rootRows = 0;
    for (const d of snap.docs) {
        const account = d.ref.parent.parent;
        if (!account) { rootRows++; continue; }   // retired root collection
        if (!byParent.has(account.id)) byParent.set(account.id, []);
        byParent.get(account.id).push(d);
    }

    let orphans = 0, live = 0;
    for (const [uid, rows] of byParent) {
        const parent = await db.collection('users').doc(uid).get();
        if (parent.exists) { live += rows.length; continue; }
        orphans += rows.length;
        console.log(`  ✗ ORPHAN account ${uid} — no user document, ${rows.length} device row(s)`);
        for (const r of rows) {
            const v = r.data();
            const reachable = !!(v.appToken || v.widgetToken) && !!v.environment;
            console.log(`        ${r.id.slice(0, 8)}  reachable=${reachable}  lastSeen=${v.lastSeen ?? '—'}`);
        }
    }

    console.log(`\nsummary`);
    console.log(`  accounts with device rows : ${byParent.size}`);
    console.log(`  rows under a LIVE account : ${live}`);
    console.log(`  rows under a DELETED one  : ${orphans}`);
    console.log(`  retired root-collection   : ${rootRows}`);

    if (orphans > 0) {
        console.log('\n✗ FAIL — a deleted account still owns device rows. They are in the');
        console.log('  broadcast audience and NO maintenance job can reach them, because every');
        console.log('  one of them iterates `users` and this account is not there.');
        process.exitCode = 1;
    } else {
        console.log('\nPASS — every device row belongs to an account that still exists.');
    }
})().catch((e) => { console.error(e); process.exit(1); });
