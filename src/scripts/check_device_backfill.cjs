/*
 * READ-ONLY verification of the P2b backfill.
 *
 *   node src/scripts/check_device_backfill.cjs --key=<sa>
 *   node src/scripts/check_device_backfill.cjs --key=<sa> --uid=<uid>
 *
 * The design's requirement, verbatim: "Verify per user that the row count
 * matches the union of map entries and root rows for that uid." This does that,
 * and then checks the FIELDS as well, because a row that exists but lost its
 * APNs token is a device that has silently stopped receiving pushes — and a
 * zero audience is silent by design.
 *
 * ## Why it recomputes instead of importing UserDeviceService
 * Same discipline as the P0 probes. A probe that imports the merge it is
 * checking agrees with that merge by construction, including when the merge is
 * wrong. This is a deliberate SECOND implementation of the union and the field
 * mapping; a disagreement between them is the finding, not a bug in the script.
 *
 * ## It has a SHELF LIFE, and says so
 * The whole probe is "does the new store match the two old ones". Step 7 of the
 * runbook DELETES those two, and from that moment the question has no answer:
 * every genuine live row reads as unaccounted-for because its source is gone.
 * Left alone it would report a red FAIL forever, on a perfectly healthy
 * environment, telling the reader to "fix the backfill and re-run it" against a
 * source that no longer exists. A probe that cries wolf is worse than no probe,
 * so this one detects that state and reports N/A instead.
 *
 * After that point `check_session_state.cjs` is the standing invariant check.
 *
 * NEVER writes.
 */
const admin = require('firebase-admin');
const path = require('path');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const onlyUid = arg('uid');
const keyArg = arg('key');
const sa = keyArg ? require(path.resolve(process.cwd(), keyArg)) : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

/** Independent restatement of the ISO/epoch coercion. */
function epochOf(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
    return null;
}

(async () => {
    console.log(`Project : ${sa.project_id}\n`);

    const registryByUid = new Map();
    (await db.collection('devices').get()).forEach((d) => {
        const r = d.data();
        if (!r.uid) return;
        if (!registryByUid.has(r.uid)) registryByUid.set(r.uid, new Map());
        registryByUid.get(r.uid).set(d.id, r);
    });

    const users = onlyUid
        ? [await db.collection('users').doc(onlyUid).get()]
        : (await db.collection('users').get()).docs;

    let checked = 0, missing = 0, extra = 0, fieldIssues = 0, tokenLoss = 0;
    // Rows that exist and are correct but have no legacy SOURCE to be checked
    // against — normal once the cleanup has run, and not a defect.
    let liveOnly = 0;
    let legacySessionEntries = 0;
    const legacyRegistryRows = [...registryByUid.values()].reduce((n, m) => n + m.size, 0);

    for (const doc of users) {
        if (!doc.exists) continue;
        const uid = doc.id;
        const user = doc.data() ?? {};
        const sessions = user.sessions ?? {};
        legacySessionEntries += Object.keys(sessions).length;
        const registry = registryByUid.get(uid) ?? new Map();

        const expected = new Set([...Object.keys(sessions), ...registry.keys()]);
        const actualSnap = await db.collection('users').doc(uid).collection('devices').get();
        const actual = new Map(actualSnap.docs.map((d) => [d.id, d.data()]));

        if (expected.size === 0 && actual.size === 0) continue;
        checked++;

        const miss = [...expected].filter((id) => !actual.has(id));
        const surplus = [...actual.keys()].filter((id) => !expected.has(id));

        const bad = [];
        for (const id of expected) {
            const row = actual.get(id);
            if (!row) continue;
            const s = sessions[id];
            const r = registry.get(id);

            // deviceId must be a FIELD — the collection-group steal query cannot
            // filter on document id across unknown parents.
            if (row.deviceId !== id) bad.push(`${id.slice(0, 8)}: deviceId field ≠ doc id`);

            // Epoch ms, never ISO. A string here breaks the sweep's range query.
            if (typeof row.firstSeen !== 'number') bad.push(`${id.slice(0, 8)}: firstSeen not a number`);
            if (typeof row.lastSeen !== 'number') bad.push(`${id.slice(0, 8)}: lastSeen not a number`);
            if (typeof row.lastSeen === 'number' && typeof row.firstSeen === 'number'
                && row.lastSeen < row.firstSeen) bad.push(`${id.slice(0, 8)}: lastSeen before firstSeen`);

            // The timestamp must not be OLDER than the source, and must not be
            // invented as "now" at backfill time.
            //
            // NOT an equality check, and that distinction only became visible
            // once the cutover went live. Before it, the frozen map was the only
            // writer and the two matched exactly. After it, `startSession`
            // updates the ROW on every sign-in while the superseded map stays
            // where it was — so a newer row is CORRECT, and asserting equality
            // reported two healthy devices as drift.
            //
            // The direction is what matters: older than the source means the
            // backfill lost time (a device looks abandoned sooner than it is,
            // and the sweep releases it early). Newer is just the live path
            // doing its job.
            const wantLast = epochOf(s?.lastSeen) ?? epochOf(r?.updatedAt);
            if (wantLast != null && typeof row.lastSeen === 'number' && row.lastSeen < wantLast - 1000) {
                bad.push(`${id.slice(0, 8)}: lastSeen ${row.lastSeen} is OLDER than source ${wantLast}`);
            }

            // The rename must have happened.
            if (r?.iosVersion && !row.osVersion) bad.push(`${id.slice(0, 8)}: lost osVersion (was iosVersion)`);
            if ('iosVersion' in row) bad.push(`${id.slice(0, 8)}: still carries iosVersion`);

            // The audit's drops must have happened.
            if ('stations' in row) bad.push(`${id.slice(0, 8)}: stations[] was NOT dropped`);
            if ('lines' in row) bad.push(`${id.slice(0, 8)}: lines[] was NOT dropped`);
            if ('uid' in row) bad.push(`${id.slice(0, 8)}: uid duplicated onto the row`);

            // Push reachability. Losing a token here is silent in production.
            if (r?.appToken && row.appToken !== r.appToken) { bad.push(`${id.slice(0, 8)}: LOST appToken`); tokenLoss++; }
            if (r?.widgetToken && row.widgetToken !== r.widgetToken) { bad.push(`${id.slice(0, 8)}: LOST widgetToken`); tokenLoss++; }
            if (r?.environment && row.environment !== r.environment) { bad.push(`${id.slice(0, 8)}: environment ${row.environment} ≠ ${r.environment}`); tokenLoss++; }

            // A null token is worse than an absent one: it can join an audience
            // and then be undeliverable.
            for (const f of ['appToken', 'widgetToken', 'model', 'osVersion', 'appVersion', 'environment']) {
                if (f in row && row[f] === null) bad.push(`${id.slice(0, 8)}: ${f} is null (should be absent)`);
            }
        }

        // No legacy source for this account means there is nothing to compare
        // against. Its rows are reported for the record and never as surplus:
        // "the backfill invented a row" and "the live path wrote a row after the
        // source was deleted" look identical from here, and only the first is a
        // defect. Judging them the same way is how this probe went permanently
        // red after the cleanup.
        const judged = expected.size > 0;
        const ok = miss.length === 0 && bad.length === 0 && (!judged || surplus.length === 0);
        const tag = judged ? `expected ${expected.size}, found ${actual.size}`
                           : `${actual.size} live row(s), no legacy source to check against`;
        console.log(`  ${ok ? '✓' : '✗'} ${(user.email ?? uid).padEnd(30)} ${tag}`);
        miss.forEach((id) => console.log(`        MISSING  ${id}`));
        surplus.forEach((id) => console.log(`        ${judged ? 'EXTRA   ' : 'LIVE    '} ${id}`));
        bad.forEach((b) => console.log(`        ${b}`));
        missing += miss.length;
        if (judged) extra += surplus.length; else liveOnly += surplus.length;
        fieldIssues += bad.length;
    }

    const legacyPresent = legacySessionEntries > 0 || legacyRegistryRows > 0;

    console.log(`\nsummary`);
    console.log(`  accounts checked   : ${checked}`);
    console.log(`  legacy sources     : ${legacySessionEntries} session map entr(ies), ${legacyRegistryRows} root device row(s)`);
    console.log(`  rows missing       : ${missing}`);
    console.log(`  rows unaccounted   : ${extra}`);
    if (liveOnly) console.log(`  rows with no source: ${liveOnly}   (informational — see below)`);
    console.log(`  field problems     : ${fieldIssues}`);
    console.log(`  PUSH TOKEN LOSSES  : ${tokenLoss}`);

    if (missing || extra || fieldIssues) {
        console.log('\n✗ FAIL — do not proceed to P2c. Nothing reads these rows yet, so the');
        console.log('  safe move is to fix the backfill and re-run it, not to patch forward.');
        process.exitCode = 1;
    } else if (!legacyPresent) {
        console.log('\nN/A — the legacy stores are EMPTY, so there is nothing left to verify.');
        console.log('  This is the expected state once the runbook\'s cleanup step has run:');
        console.log('  the two stores this probe compares against were deleted, and the rows');
        console.log('  above are simply the live ones. Nothing here is a defect.');
        console.log('\n  Use check_session_state.cjs as the standing invariant check from now on.');
    } else {
        console.log('\nPASS — every account\'s rows match the union of the two old stores,');
        console.log('  every field mapping held, and no push token was lost.');
    }
})().catch((e) => { console.error(e); process.exit(1); });
