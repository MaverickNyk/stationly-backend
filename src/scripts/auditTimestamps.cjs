/*
 * Read-only audit of Firestore timestamp fields ahead of the
 * epoch-millis standardization. Quota-cheap by design:
 *   - count() aggregation per collection (≈1 read / 1000 docs)
 *   - a 5-doc sample per collection to detect the "last updated" field + type
 * It NEVER writes and NEVER full-scans. `stations` is counted but NOT sampled
 * by default (pass --sample-stations to read 5 of them).
 */
const admin = require('firebase-admin');
const path = require('path');
// Defaults to the local staging key; pass --key=/path/to/prod-key.json for prod.
const keyArg = (process.argv.find((a) => a.startsWith('--key=')) || '').split('=')[1];
const serviceAccount = keyArg
    ? require(path.resolve(process.cwd(), keyArg))
    : require('../../serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const COLLECTIONS = [
  'api_keys', 'lineStatuses', 'lines', 'metadata',
  'modes', 'routes', 'stationPredictions', 'stations', 'users',
];
const CANDIDATE_FIELDS = ['lastUpdatedTime', 'lastUpdated', 'lut', 'updatedAt'];
const SAMPLE_STATIONS = process.argv.includes('--sample-stations');

function classify(v) {
  if (v === undefined) return 'absent';
  if (typeof v === 'number') return `number(${v})`;
  if (typeof v === 'string') return `string("${v}")`;
  return `${typeof v}`;
}

(async () => {
  console.log('Project:', serviceAccount.project_id, '\n');
  for (const name of COLLECTIONS) {
    try {
      const col = db.collection(name);
      const countSnap = await col.count().get();
      const total = countSnap.data().count;

      const sampleStations = name === 'stations' && !SAMPLE_STATIONS;
      let fieldReport = '(sample skipped to save quota)';
      if (!sampleStations) {
        const sample = await col.limit(5).get();
        const fields = {};
        sample.forEach((doc) => {
          const d = doc.data();
          CANDIDATE_FIELDS.forEach((f) => {
            if (d[f] !== undefined) {
              fields[f] = fields[f] || classify(d[f]);
            }
          });
        });
        const present = Object.keys(fields);
        fieldReport = present.length
          ? present.map((f) => `${f}=${fields[f]}`).join('  |  ')
          : 'NO last-updated field on sampled docs';
      }
      console.log(`• ${name.padEnd(20)} count=${String(total).padStart(6)}   ${fieldReport}`);
    } catch (e) {
      console.log(`• ${name.padEnd(20)} ERROR: ${e.message}`);
    }
  }
  console.log('\nAudit complete (read-only, no writes).');
  process.exit(0);
})();
