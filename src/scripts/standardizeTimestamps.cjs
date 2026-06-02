/*
 * One-off migration: standardize every synced collection's "last updated"
 * field to a single integer `lastUpdatedTime` = epoch milliseconds (UTC).
 *
 *   - Converts ISO-string `lastUpdatedTime` / `lastUpdated` / `lut` / `updatedAt`
 *     → epoch millis (number), written to `lastUpdatedTime`.
 *   - Docs with no last-updated field get stamped with Date.now().
 *   - The legacy differently-named fields (`lastUpdated`, `lut`, `updatedAt`)
 *     are removed once their value has been migrated.
 *
 * SAFETY:
 *   - `stations` is SKIPPED (20k docs would blow the Spark write quota).
 *   - `stationPredictions` is SKIPPED (it is leaving Firestore entirely).
 *   - DRY-RUN by default. Pass `--apply` to actually write.
 *   - MUST be run AFTER the integer-aware code is deployed (see migrate-last
 *     note in SYNC_ARCHITECTURE.md) — flipping types under old code breaks
 *     its string-based delta queries.
 */
const admin = require('firebase-admin');
const path = require('path');
// Target Firestore via service-account key. Defaults to the local staging key;
// pass --key=/abs/or/relative/path/to/prod-service-account.json for production.
const keyArg = (process.argv.find((a) => a.startsWith('--key=')) || '').split('=')[1];
const serviceAccount = keyArg
    ? require(path.resolve(process.cwd(), keyArg))
    : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const APPLY = process.argv.includes('--apply');
// Optional: restrict to a comma list of collections, e.g. --only=modes,lines,routes
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const onlySet = ONLY ? new Set(ONLY.split(',').map((s) => s.trim())) : null;

// collection -> source field to read the existing timestamp from (in priority order)
const PLAN = {
  api_keys:     [],                          // no field -> stamp now
  lines:        [],                          // no field -> stamp now
  modes:        [],                          // no field -> stamp now
  lineStatuses: ['lastUpdatedTime'],         // ISO string -> int (same name)
  routes:       ['lastUpdatedTime'],         // ISO string -> int (same name)
  metadata:     ['lastUpdated'],             // rename -> lastUpdatedTime int
  stations:     ['lastUpdatedTime'],         // Option A: ISO(local/bad-fmt) -> int
  // users: NOT migrated — not replicated; `updatedAt` is profile metadata, kept as-is.
  // stationPredictions: SKIPPED (leaving Firestore)
};
const LEGACY_FIELDS_TO_DROP = ['lastUpdated', 'lut'];

function toEpochMs(value) {
  if (typeof value === 'number') return value;            // already epoch
  if (typeof value === 'string') {
    const ms = Date.parse(value);                          // ISO -> ms
    if (!Number.isNaN(ms)) return ms;
  }
  return null;                                             // unparseable / absent
}

(async () => {
  console.log(`Project: ${serviceAccount.project_id}   mode: ${APPLY ? 'APPLY ✍️' : 'DRY-RUN 👀'}\n`);
  const now = Date.now();
  let totalReads = 0, totalWrites = 0;

  for (const [name, sources] of Object.entries(PLAN)) {
    if (onlySet && !onlySet.has(name)) continue;
    const snap = await db.collection(name).get();
    totalReads += snap.size;

    let converted = 0, stamped = 0, already = 0;
    let batch = db.batch(), pending = 0;

    for (const doc of snap.docs) {
      const d = doc.data();
      const src = sources.find((f) => d[f] !== undefined);
      let epoch = src ? toEpochMs(d[src]) : null;

      const alreadyInt = typeof d.lastUpdatedTime === 'number';
      if (epoch === null) { epoch = now; stamped++; }
      else if (alreadyInt) { already++; }
      else { converted++; }

      const update = { lastUpdatedTime: epoch };
      for (const f of LEGACY_FIELDS_TO_DROP) {
        if (d[f] !== undefined) update[f] = FieldValue.delete();
      }

      if (APPLY && !(alreadyInt && !LEGACY_FIELDS_TO_DROP.some((f) => d[f] !== undefined))) {
        batch.set(doc.ref, update, { merge: true });
        pending++; totalWrites++;
        if (pending === 450) {
          try { await batch.commit(); }
          catch (e) { await onWriteError(e, name, totalWrites); }
          batch = db.batch(); pending = 0;
        }
      }
    }
    if (APPLY && pending > 0) {
      try { await batch.commit(); }
      catch (e) { await onWriteError(e, name, totalWrites); }
    }

    console.log(`• ${name.padEnd(14)} docs=${String(snap.size).padStart(5)}  converted=${converted}  stamped(no-field)=${stamped}  already-int=${already}`);
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'} — reads≈${totalReads}  writes≈${APPLY ? totalWrites : 0}`);
  process.exit(0);
})();

/**
 * Graceful stop on write-quota exhaustion. The migration is idempotent —
 * already-converted docs are skipped on re-run — so re-running tomorrow simply
 * resumes where this left off. Any other error is rethrown.
 */
async function onWriteError(e, collection, writesSoFar) {
  const msg = String(e && e.message || e);
  const quota = e?.code === 8 || /quota|RESOURCE_EXHAUSTED|exceeded/i.test(msg);
  if (quota) {
    console.log(`\n🛑 Write quota exhausted while on [${collection}] (~${writesSoFar} writes done).`);
    console.log('   Re-run this script tomorrow to resume — already-migrated docs are skipped.');
    process.exit(0);
  }
  throw e;
}
