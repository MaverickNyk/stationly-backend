/*
 * READ-ONLY probe for the P1 `stateRev` ledger.
 *
 *   node src/scripts/check_state_rev.cjs --key=<service account>
 *   node src/scripts/check_state_rev.cjs --key=… --uid=<uid>
 *   node src/scripts/check_state_rev.cjs --key=… --watch=<uid>   # poll until it moves
 *
 * Answers two questions the backend cannot be trusted to answer about itself:
 *
 *   1. What does the MASTER say each account's `stateRev` is?
 *   2. Does the backend's SQLite ledger agree?
 *
 * NEVER writes to Firestore, and never writes to the ledger either — it opens
 * the SQLite file read-only, so running this against a live host cannot perturb
 * the thing it is measuring.
 *
 * ## Why it restates the rules instead of importing them
 * Same reason as the P0 probes: a probe that imports `UserRevLedger` agrees
 * with `UserRevLedger` by construction, including when both are wrong. The
 * disagreement between two independent implementations is the finding.
 *
 * ## Reading the output
 * `ledger < master` is EXPECTED and benign on a host that has just restarted or
 * has never served that account — the ledger is a cache and seeds lazily. What
 * is NOT expected is `ledger > master`: the ledger is only ever written from a
 * ## Exit codes
 *   0  the ledger was read and every value is sound
 *   1  FAIL — the ledger holds a value the master never had
 *   2  INCONCLUSIVE — the ledger could not be read, so nothing was compared.
 *      This is what you get from a developer machine: the ledger is on the
 *      deployed HOST. Treated as its own code rather than folded into 0,
 *      because a probe that reports success for a check it did not run is worse
 *      than one that reports nothing.
 *
 * value read out of the master, so a ledger ahead of Firestore means either a
 * write path guessed a value (the bug `UserRevLedger`'s header exists to
 * prevent) or the two are pointed at different projects.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1];

const keyArg = arg('key');
const serviceAccount = keyArg
    ? require(path.resolve(process.cwd(), keyArg))
    : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const uidArg = arg('uid');
const watchUid = arg('watch');
const dbPath = arg('db') || path.resolve(process.cwd(), 'data', 'stationly.sqlite');

console.log(`Project : ${serviceAccount.project_id}`);
console.log(`Ledger  : ${dbPath}${fs.existsSync(dbPath) ? '' : '  (absent — ledger checks skipped)'}\n`);

/** The ledger, read-only. Returns a uid→rev map, or null if unreadable. */
function readLedger() {
    if (!fs.existsSync(dbPath)) return null;
    try {
        // Lazy require: the probe still works for the master-only half on a
        // machine where the native module will not load.
        const sqlite3 = require('sqlite3');
        return new Promise((resolve) => {
            const conn = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) { console.warn(`  ⚠️  ledger unreadable: ${err.message}`); return resolve(null); }
            });
            conn.all('SELECT uid, rev FROM user_revs', (err, rows) => {
                conn.close();
                if (err) { console.warn(`  ⚠️  no user_revs table yet: ${err.message}`); return resolve(null); }
                resolve(Object.fromEntries(rows.map((r) => [r.uid, Number(r.rev)])));
            });
        });
    } catch (e) {
        console.warn(`  ⚠️  sqlite3 unavailable: ${e.message}`);
        return null;
    }
}

async function masterRevs() {
    const out = {};
    if (uidArg) {
        const doc = await db.collection('users').doc(uidArg).get();
        if (!doc.exists) throw new Error(`no such user: ${uidArg}`);
        out[uidArg] = Number(doc.data().stateRev ?? 0);
        return out;
    }
    const snap = await db.collection('users').get();
    snap.forEach((d) => { out[d.id] = Number(d.data().stateRev ?? 0); });
    return out;
}

async function report() {
    const master = await masterRevs();
    const ledger = await readLedger();

    const uids = Object.keys(master).sort();
    let disagreements = 0;
    let unseeded = 0;
    let neverWritten = 0;

    console.log('uid                              master   ledger   verdict');
    console.log('─'.repeat(72));
    for (const uid of uids) {
        const m = master[uid];
        const l = ledger ? ledger[uid] : undefined;
        let verdict;
        if (m === 0) { verdict = 'no content write since the field shipped'; neverWritten++; }
        else if (ledger == null) verdict = '(ledger not checked)';
        else if (l === undefined) { verdict = 'not seeded yet — benign'; unseeded++; }
        else if (l === m) verdict = '✓ agrees';
        else if (l < m) { verdict = `behind by ${m - l} — benign if a write just landed`; unseeded++; }
        else { verdict = `✗ AHEAD OF MASTER by ${l - m} — see header`; disagreements++; }
        console.log(`${uid.padEnd(32)} ${String(m).padStart(6)}   ${String(l ?? '—').padStart(6)}   ${verdict}`);
    }

    console.log('\nsummary');
    console.log(`  accounts                       : ${uids.length}`);
    console.log(`  never had a content write      : ${neverWritten}   (these read the profile every foreground, as before P1)`);
    console.log(`  ledger cold or behind          : ${unseeded}`);
    console.log(`  ledger AHEAD of master         : ${disagreements}`);
    if (disagreements > 0) {
        console.log('\n✗ FAIL — the ledger holds a value the master never had.');
        process.exitCode = 1;
    } else if (ledger == null) {
        // ⚠️ NOT a pass. The one assertion this probe exists to make — no ledger
        // value exceeds its master — compared nothing at all, because the ledger
        // could not be read.
        //
        // This is the DEFAULT outcome when the probe is run from a developer
        // machine, which is exactly how the handover tells you to run it: the
        // ledger lives in the deployed host's `data/stationly.sqlite`, and the
        // local repo's copy has no `user_revs` table until the server has run
        // here. Printing PASS in that state taught the reader that a green line
        // meant the ledger was checked, when the only thing verified was the
        // master half.
        console.log('\n⚠️  INCONCLUSIVE — the master half is sound, but the LEDGER WAS NOT READ,');
        console.log('   so "no ledger value exceeds its master" was never actually tested.');
        console.log('   The ledger lives on the HOST that serves the traffic. To check it, run');
        console.log('   this on that host, or point it at a copy of its data/stationly.sqlite.');
        process.exitCode = 2;
    } else {
        const compared = uids.length - neverWritten;
        console.log(`\nPASS — no ledger value exceeds its master (${compared} account(s) compared).`);
    }
}

async function watch() {
    let last = null;
    console.log(`watching ${watchUid} — make a change on the device; Ctrl-C to stop\n`);
    for (;;) {
        const doc = await db.collection('users').doc(watchUid).get();
        const rev = Number(doc.data()?.stateRev ?? 0);
        const boards = (doc.data()?.boards ?? []).length;
        if (rev !== last) {
            console.log(`[${new Date().toISOString().slice(11, 19)}] stateRev = ${rev}   boards = ${boards}` +
                (last === null ? '   (initial)' : `   ← moved by ${rev - last}`));
            last = rev;
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
}

(watchUid ? watch() : report()).catch((e) => { console.error(e.message); process.exit(1); });
