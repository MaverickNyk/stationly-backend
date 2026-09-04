/*
 * Read-only snapshot of everything the P2 cutover could damage.
 *
 *   node src/scripts/backup_firestore_snapshot.cjs --key=<sa> [--out=<dir>]
 *
 * Written for the D-phase window: `gcloud` is not installed and a managed
 * Firestore export needs a new IAM role plus a GCS bucket, neither of which is
 * worth doing mid-window for ~108 accounts. This reads the same documents a
 * managed export would and writes them as one JSON file.
 *
 * ## What it captures, and why each one is at risk
 *   users/{uid}                  the `sessions` map (the backfill's SOURCE),
 *                                `loggedIn`, `stateRev`, `supportMoney`
 *   users/{uid}/<subcollections> fcm_tokens (purged by a release — push dies
 *                                and does not recover) and devices (the new
 *                                rows, so a re-run can be compared)
 *   metadata/*                   subscribed_stations — the registry a release
 *                                empties; 71 stations would lose their LAST holder
 *   devices/*                    the root registry; expected EMPTY on prod
 *
 * READ-ONLY. It opens no transaction and writes nothing back.
 */
require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const keyArg = arg('key');
const sa = keyArg ? require(path.resolve(process.cwd(), keyArg)) : require('../../serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// Firestore types do not survive JSON.stringify. Tag them so a restore can
// rebuild them rather than silently writing strings where Timestamps were.
function encode(v) {
    if (v === null || v === undefined) return v;
    if (v instanceof admin.firestore.Timestamp) {
        return { __t: 'ts', seconds: v.seconds, nanoseconds: v.nanoseconds, iso: v.toDate().toISOString() };
    }
    if (v instanceof admin.firestore.GeoPoint) return { __t: 'geo', lat: v.latitude, lng: v.longitude };
    if (v && typeof v.path === 'string' && v.firestore) return { __t: 'ref', path: v.path };
    if (Buffer.isBuffer(v)) return { __t: 'bytes', b64: v.toString('base64') };
    if (Array.isArray(v)) return v.map(encode);
    if (typeof v === 'object') {
        const o = {};
        for (const [k, val] of Object.entries(v)) o[k] = encode(val);
        return o;
    }
    return v;
}

async function dumpDoc(doc) {
    const out = { id: doc.id, path: doc.ref.path, data: encode(doc.data()), sub: {} };
    for (const sub of await doc.ref.listCollections()) {
        const snap = await sub.get();
        out.sub[sub.id] = snap.docs.map((d) => ({ id: d.id, data: encode(d.data()) }));
    }
    return out;
}

async function dumpCollection(name) {
    const snap = await db.collection(name).get();
    const rows = [];
    for (const doc of snap.docs) rows.push(await dumpDoc(doc));
    return rows;
}

async function main() {
    console.log(`Project : ${sa.project_id}`);
    console.log(`Mode    : READ-ONLY SNAPSHOT`);
    console.log();

    const started = new Date();
    const users = await dumpCollection('users');
    const metadata = await dumpCollection('metadata');
    const devices = await dumpCollection('devices');

    let fcm = 0, devRows = 0, sessions = 0;
    for (const u of users) {
        fcm += (u.sub.fcm_tokens || []).length;
        devRows += (u.sub.devices || []).length;
        sessions += Object.keys((u.data && u.data.sessions) || {}).length;
    }

    const outDir = arg('out') || path.resolve(process.cwd(), 'backups');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = started.toISOString().replace(/[:.]/g, '-');
    const file = path.join(outDir, `${sa.project_id}-snapshot-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({
        project: sa.project_id,
        takenAt: started.toISOString(),
        counts: { users: users.length, metadata: metadata.length, rootDevices: devices.length, fcmTokens: fcm, deviceRows: devRows, legacySessions: sessions },
        users, metadata, devices,
    }, null, 2));

    console.log('CAPTURED');
    console.log(`  users                       ${users.length}`);
    console.log(`  legacy sessions entries     ${sessions}   <- the backfill's source`);
    console.log(`  users/{uid}/devices rows    ${devRows}   <- new store`);
    console.log(`  users/{uid}/fcm_tokens      ${fcm}   <- purged by a release`);
    console.log(`  metadata docs               ${metadata.length}`);
    console.log(`  root devices                ${devices.length}   <- expected 0 on prod`);
    console.log();
    console.log(`Written : ${file}`);
    console.log(`Size    : ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
    console.log(`Took    : ${Date.now() - started.getTime()} ms`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
