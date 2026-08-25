/*
 * Delete the stores the P2 storage move superseded.
 *
 *   node src/scripts/cleanup_legacy_stores.cjs --key=<sa> --dry-run   # ALWAYS FIRST
 *   node src/scripts/cleanup_legacy_stores.cjs --key=<sa>             # DESTRUCTIVE
 *
 * Removes, in this order:
 *   1. the `users.sessions` map        → replaced by users/{uid}/devices
 *   2. `users.address` / `.phoneNumber`→ declared, never written, never read (§3.1)
 *   3. `users.preferences`             → device-local settings, already off the write path
 *   4. the ROOT `devices` collection   → replaced by users/{uid}/devices
 *
 * ## Read this before running it
 * This is the ONLY destructive script in the repo and it cannot be undone. Run
 * `check_device_backfill.cjs` first: it proves every account's device rows match
 * the union of the two old stores. Deleting the sources before that passes
 * destroys the only evidence of what the rows should have been.
 *
 * ## Why the root collection goes LAST
 * A collection GROUP query matches every collection of that name at any depth,
 * including the root one. The backend filters those out by parent, but the
 * ordering here means that if the run is interrupted, what survives is the
 * SOURCE data rather than a half-emptied account document.
 *
 * ## Why this is safe for the frozen Android app
 * Verified rather than assumed. The released APK's `UserProfileResponse` models
 * `uid`, `email`, `displayName`, `photoURL?`, `address?` and `stations` — and
 * `sessions` was NEVER in the client model, in any commit. `address` is
 * optional with a default, so its absence decodes fine. Android reaches
 * `/user/fcm/register`, `/user/logout`, `/user/sync/profile` and
 * `delete-account`; it never touched the root `devices` collection, which has
 * only ever held iOS APNs rows. The four fields it CANNOT survive losing are
 * pinned by the ANDROID CONTRACT tests and none of them are touched here.
 */
require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');
const readline = require('readline');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const DRY = process.argv.includes('--dry-run');
const YES = process.argv.includes('--yes');
const sa = arg('key') ? require(path.resolve(process.cwd(), arg('key'))) : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const DEAD_FIELDS = ['sessions', 'address', 'phoneNumber', 'preferences'];

async function confirm(question) {
    if (YES) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question(question, r));
    rl.close();
    return answer.trim() === 'DELETE';
}

(async () => {
    console.log(`Project : ${sa.project_id}`);
    console.log(`Mode    : ${DRY ? 'DRY RUN — nothing will be deleted' : '⚠️  DESTRUCTIVE'}\n`);

    // ── survey ──
    const users = await db.collection('users').get();
    const plan = [];
    for (const doc of users.docs) {
        const data = doc.data() ?? {};
        const present = DEAD_FIELDS.filter((f) => f in data);
        if (present.length) plan.push({ uid: doc.id, email: data.email, fields: present });
    }
    const rootDevices = await db.collection('devices').get();

    console.log('user documents');
    for (const p of plan) console.log(`  ${(p.email ?? p.uid).padEnd(30)} ${p.fields.join(', ')}`);
    if (plan.length === 0) console.log('  (nothing to clear)');
    console.log(`\nroot 'devices' collection : ${rootDevices.size} document(s)`);

    if (DRY) {
        console.log('\nDRY RUN — nothing written. Before running for real:');
        console.log('  node src/scripts/check_device_backfill.cjs --key=<sa>   # MUST pass');
        return;
    }

    if (plan.length === 0 && rootDevices.size === 0) { console.log('\nNothing to do.'); return; }
    if (!(await confirm('\nType DELETE to confirm this is irreversible: '))) {
        console.log('Aborted.');
        return;
    }

    // ── 1-3. dead fields on the user documents ──
    let fieldsCleared = 0;
    for (const p of plan) {
        const patch = {};
        // FieldValue.delete() on a FIELD PATH — `set(merge:true)` deep-merges
        // maps, so writing `sessions: {}` would NOT remove the key.
        for (const f of p.fields) patch[f] = FieldValue.delete();
        await db.collection('users').doc(p.uid).update(patch);
        fieldsCleared += p.fields.length;
        console.log(`  ✓ ${p.email ?? p.uid}: cleared ${p.fields.join(', ')}`);
    }

    // ── 4. the root collection, last ──
    let devicesDeleted = 0;
    for (let i = 0; i < rootDevices.docs.length; i += 400) {
        const batch = db.batch();
        for (const doc of rootDevices.docs.slice(i, i + 400)) { batch.delete(doc.ref); devicesDeleted++; }
        await batch.commit();
    }
    if (devicesDeleted) console.log(`  ✓ deleted ${devicesDeleted} root device document(s)`);

    console.log(`\nDone — ${fieldsCleared} field(s) cleared, ${devicesDeleted} root device row(s) deleted.`);
    console.log('Verify with:');
    console.log('  node src/scripts/check_session_state.cjs  --key=<sa>');
    console.log('  node src/scripts/check_device_indexes.cjs --key=<sa>   # root collection must read 0');
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
