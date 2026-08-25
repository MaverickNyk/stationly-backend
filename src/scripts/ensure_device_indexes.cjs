/*
 * Create the two collection-group indexes P2 needs. IDEMPOTENT.
 *
 *   node src/scripts/ensure_device_indexes.cjs --key=<service account>
 *   node src/scripts/ensure_device_indexes.cjs --key=<sa> --dry-run
 *
 * `firestore.indexes.json` is the declarative source of truth; this script is
 * what applies it, because there is no Firebase CLI on this machine and adding
 * one would mean a global install and a separate interactive login for a job
 * that is two API calls.
 *
 * It talks to the Firestore ADMIN API (not the data API the Admin SDK wraps),
 * authenticating with the same service-account JSON everything else here uses.
 *
 * ## Why PATCH a field instead of POSTing an index
 * These are SINGLE-field indexes that need COLLECTION_GROUP scope. Firestore
 * models that as the field's `indexConfig`, not as a composite index — so it is
 * `PATCH .../collectionGroups/devices/fields/deviceId`, and posting to
 * `.../indexes` instead is accepted and does nothing useful. That mistake is
 * silent in exactly the wrong way: the call succeeds and the query still fails.
 *
 * ## Safe to run before the data exists
 * Index configuration is metadata on a field path; it does not require the
 * collection to have documents, and creating it early is the point — P2b's
 * backfill and P2c's queries both need it in place first.
 */
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const DRY = process.argv.includes('--dry-run');

const keyArg = arg('key');
const sa = keyArg ? require(path.resolve(process.cwd(), keyArg)) : require('../../serviceAccountKey.json');
const project = sa.project_id;

// Mirrors firestore.indexes.json. Restated rather than imported so a probe-style
// disagreement between the file and what is actually applied is visible.
const TARGETS = [
    { field: 'deviceId', order: 'ASCENDING', why: 'the steal check on login (design 4.1)' },
    { field: 'lastSeen', order: 'ASCENDING', why: 'the abandoned-session sweep (design 9)' },
];

const BASE = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups/devices/fields`;

async function main() {
    console.log(`Project : ${project}`);
    console.log(`Mode    : ${DRY ? 'DRY RUN — nothing will be written' : 'APPLY'}\n`);

    const auth = new GoogleAuth({
        credentials: sa,
        scopes: ['https://www.googleapis.com/auth/datastore'],
    });
    const client = await auth.getClient();

    for (const t of TARGETS) {
        const url = `${BASE}/${t.field}`;
        const current = await client.request({ url, method: 'GET' }).catch((e) => {
            console.error(`  ✗ ${t.field}: cannot read field config — ${e.message}`);
            return null;
        });
        if (!current) continue;

        const existing = current.data?.indexConfig?.indexes ?? [];
        const hasGroup = existing.some(
            (i) => i.queryScope === 'COLLECTION_GROUP' && (i.fields ?? []).some((f) => f.order === t.order),
        );

        if (hasGroup) {
            console.log(`  ✓ ${t.field}: COLLECTION_GROUP index already present — ${t.why}`);
            continue;
        }
        if (DRY) {
            console.log(`  → ${t.field}: WOULD create COLLECTION_GROUP ${t.order} — ${t.why}`);
            continue;
        }

        // Keep whatever COLLECTION-scope indexes Firestore made automatically and
        // ADD the group-scoped one. Sending only the new entry would replace the
        // set and silently drop the automatic single-field indexes every existing
        // per-collection query depends on.
        const kept = existing.filter((i) => i.queryScope === 'COLLECTION');
        const body = {
            indexConfig: {
                usesAncestorConfig: false,
                indexes: [
                    ...kept,
                    { queryScope: 'COLLECTION_GROUP', fields: [{ fieldPath: t.field, order: t.order }] },
                ],
            },
        };

        try {
            await client.request({
                // `updateMask=indexConfig`, not `updateMask.fieldPaths=` — the
                // dotted form is the proto field name, which this REST surface
                // rejects outright rather than ignoring.
                url: `${url}?updateMask=indexConfig`,
                method: 'PATCH',
                data: body,
            });
            console.log(`  ✓ ${t.field}: COLLECTION_GROUP ${t.order} requested — ${t.why}`);
        } catch (e) {
            const detail = e.response?.data?.error?.message ?? e.message;
            console.error(`  ✗ ${t.field}: ${detail}`);
            process.exitCode = 1;
        }
    }

    console.log(
        '\nIndex builds are ASYNCHRONOUS. Firestore reports the field immediately but the\n' +
        'index may take minutes to become queryable on a collection with data. Prove it\n' +
        'with the read-only probe rather than assuming:\n' +
        '  node src/scripts/check_device_indexes.cjs --key=<sa>',
    );
}

main().catch((e) => { console.error(e.message); process.exit(1); });
