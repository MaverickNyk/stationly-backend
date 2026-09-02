/*
 * P2b — create users/{uid}/devices/{deviceId} from the two stores being merged.
 *
 *   node src/scripts/backfill_device_rows.cjs --key=<sa> --dry-run   # predict
 *   node src/scripts/backfill_device_rows.cjs --key=<sa>             # WRITES
 *   node src/scripts/backfill_device_rows.cjs --key=<sa> --uid=<uid> # one account
 *
 * IDEMPOTENT and re-runnable: it writes with merge, and re-running over
 * unchanged sources produces an identical row.
 *
 * ## This is the SAFE half of P2
 * Nothing reads these rows yet. The old stores stay authoritative until P2c
 * ships, so a mistake here is undone by deleting the subcollections and nothing
 * user-facing has moved. That is the entire reason the storage move is split in
 * three: this step can be run, checked, and left alone for as long as it takes
 * to be confident.
 *
 * ALWAYS --dry-run first, read what it predicts, then run it. Then run
 * `check_device_backfill.cjs`, which counts the same thing independently.
 *
 * ## Sources
 *   users/{uid}.sessions[deviceId]  → platform, model, osVersion, appVersion,
 *                                     firstSeen, lastSeen (ISO → epoch ms)
 *   devices/{deviceId} where uid==  → environment, appToken, widgetToken
 *
 * The union is deliberate. A session with no registry row is a device that
 * signed in but never registered for push; a registry row with no session is a
 * device that registered while signed out or whose session was pruned. Both are
 * real, and dropping either would lose a device.
 */
require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const DRY = process.argv.includes('--dry-run');
const onlyUid = arg('uid');

const keyArg = arg('key');
const sa = keyArg ? require(path.resolve(process.cwd(), keyArg)) : require('../../serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

// The merge lives in the service — this script is the DRIVER, not a second
// implementation of the rules. (The verification probe is where an independent
// restatement belongs; a backfill that disagrees with the service it feeds
// would be the bug.)
const { UserDeviceService } = require('../../dist/services/userDeviceService');

async function main() {
    console.log(`Project : ${sa.project_id}`);
    console.log(`Mode    : ${DRY ? 'DRY RUN — nothing will be written' : 'APPLY — WRITES'}`);
    if (onlyUid) console.log(`Scope   : ${onlyUid}`);
    console.log();

    // Root registry rows, grouped by the account they name.
    const registryByUid = new Map();
    const rootSnap = await db.collection('devices').get();
    rootSnap.forEach((d) => {
        const row = d.data();
        if (!row.uid) return; // registered while signed out — belongs to nobody
        if (!registryByUid.has(row.uid)) registryByUid.set(row.uid, new Map());
        registryByUid.get(row.uid).set(d.id, row);
    });
    console.log(`root devices    : ${rootSnap.size} row(s), ${registryByUid.size} account(s) named\n`);

    const users = onlyUid
        ? [await db.collection('users').doc(onlyUid).get()]
        : (await db.collection('users').get()).docs;

    let accounts = 0, planned = 0, written = 0, skipped = 0;

    for (const doc of users) {
        if (!doc.exists) { console.log(`  ✗ ${onlyUid}: no such user`); continue; }
        const uid = doc.id;
        const user = doc.data() ?? {};
        const sessions = user.sessions ?? {};
        const registry = registryByUid.get(uid) ?? new Map();

        // The UNION of both stores' device ids for this account.
        const ids = new Set([...Object.keys(sessions), ...registry.keys()]);
        if (ids.size === 0) { skipped++; continue; }

        accounts++;
        console.log(`  ${user.email ?? uid}  (${ids.size} device(s))`);

        for (const deviceId of ids) {
            const row = UserDeviceService.rowFrom(deviceId, sessions[deviceId], registry.get(deviceId));
            const src = [
                sessions[deviceId] ? 'session' : null,
                registry.get(deviceId) ? 'registry' : null,
            ].filter(Boolean).join('+');
            const age = ((Date.now() - row.lastSeen) / 86400000).toFixed(1);
            console.log(
                `      ${deviceId.slice(0, 8)}  ${row.platform.padEnd(7)} ${src.padEnd(16)}` +
                ` os=${(row.osVersion ?? '—').padEnd(8)} env=${(row.environment ?? '—').padEnd(10)}` +
                ` app=${row.appToken ? 'y' : 'n'} widget=${row.widgetToken ? 'y' : 'n'} lastSeen=${age}d`,
            );
            planned++;
            if (!DRY) {
                await db.collection('users').doc(uid).collection('devices').doc(deviceId).set(row, { merge: true });
                written++;
            }
        }
    }

    console.log(`\nsummary`);
    console.log(`  accounts with devices : ${accounts}`);
    console.log(`  accounts with none    : ${skipped}`);
    console.log(`  rows ${DRY ? 'PREDICTED' : 'WRITTEN  '}        : ${DRY ? planned : written}`);
    console.log(
        DRY
            ? '\nDRY RUN — nothing was written. Re-run without --dry-run to apply, then verify:\n  node src/scripts/check_device_backfill.cjs --key=<sa>'
            : '\nNow VERIFY independently:\n  node src/scripts/check_device_backfill.cjs --key=<sa>',
    );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
