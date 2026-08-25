/*
 * Trigger a maintenance job WITHOUT starting the HTTP server.
 *
 *   node src/scripts/run_maintenance.cjs sweep
 *   node src/scripts/run_maintenance.cjs reconcile
 *
 * This WRITES. Run the read-only probe for the job first
 * (`check_session_sweep.cjs --before` / `check_drift_reconcile.cjs --before`),
 * confirm the prediction is what you expect, then run this, then re-run the
 * probe with `--after`.
 *
 * ## Why this exists at all
 * The real trigger is the crontab hitting `POST /internal/maintenance/{job}`
 * on the host. That path is loopback-only on the raw socket address and nginx
 * has no catch-all `location /`, so it is unreachable from the internet —
 * which also means it is unreachable from a developer machine, and reaching it
 * would otherwise require running a local web server just to curl yourself.
 * This calls the same service method the route calls, with no port opened.
 *
 * Reads `.env` for FIREBASE_KEY_PATH exactly as the server does, so it acts on
 * whichever project that key names. CHECK THAT FIRST — staging is
 * `mindthetimefcm`, production is `stationly-prod`.
 *
 * ## ⚠️ `reconcile` FROM A DEVELOPER MACHINE NOW WRITES THE WRONG SQLITE
 * The reconcile rebuilds the `user_watch` push-audience index as part of its
 * pass. That table lives in the HOST's `data/stationly.sqlite`; run from here it
 * fills a local developer database nothing serves from, while correctly writing
 * Firestore. The registry half is right and the index half goes nowhere — and
 * `UserWatchIndex` swallows its own errors, so nothing says so.
 *
 * Run `reconcile` ON THE HOST, through the crontab wrapper:
 *
 *     ssh <host> '~/stationly-backend/<ops-dir>/maintenance_cron.sh reconcile'
 *
 * `sweep` is unaffected — it touches Firestore only — and is safe from here.
 *
 * (`backfill_user_watch.cjs` was deleted for the same reason: it wrote that
 * index from a second process, which fights the running server for the SQLite
 * lock and fails SILENTLY. The `/internal/maintenance/reindex-watch` route does
 * it in-process, and the nightly reconcile now does it unprompted.)
 */
require('dotenv').config();
const path = require('path');

const job = process.argv[2];
if (job !== 'sweep' && job !== 'reconcile') {
    console.error('usage: node src/scripts/run_maintenance.cjs <sweep|reconcile>');
    process.exit(1);
}

const keyPath = process.env.FIREBASE_KEY_PATH || './serviceAccountKey.json';
let projectId = 'unknown';
try { projectId = require(path.resolve(keyPath)).project_id; } catch { /* default creds */ }
console.log(`Firestore project : ${projectId}`);
console.log(`Job               : ${job}\n`);

const { SessionMaintenanceService } = require('../../dist/services/sessionMaintenanceService');

SessionMaintenanceService[job]()
    .then((result) => {
        console.log('\nRESULT:', JSON.stringify(result, null, 2));
        process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
