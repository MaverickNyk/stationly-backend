/*
 * The FROZEN APK's wire contract, exercised against a running backend.
 *
 *   node src/scripts/verify_android_contract.cjs --key=<sa> --api-key=<x> \
 *        --web-key=<firebase web api key> --base=<https://…>
 *
 * ## Why this exists as well as the unit tests
 * `src/tests/run.ts` has seven ANDROID CONTRACT tests, and they run against
 * stubbed Firestore. They prove `getUserProfile` and `createOrUpdateUser` build
 * the right object. They cannot prove that the object survives the ROUTE — the
 * middleware, the JSON serialiser, and whatever a controller does between the
 * service and `res.json`. The one production incident this contract has actually
 * had was exactly there: a `FieldValue.increment` sentinel that looked correct in
 * memory and became an opaque object on the wire, while the POST logged 200.
 *
 * So this drives the real HTTP endpoints with the real request shapes taken from
 * the released client at commit `1a6c846`, and asserts on the PARSED JSON.
 *
 * ## The contract, and why these four fields
 * `UserProfileResponse` at that commit declares `uid`, `email`, `displayName`
 * and `stations` with NO default. kotlinx throws `MissingFieldException` on a
 * missing or null one, and `coerceInputValues` does not save `stations` because
 * coercion falls back to a default and it has none. Omit any of the four and
 * every production Android login fails hard.
 *
 * Everything else the APK reads is status-code only, so those endpoints are
 * asserted on the status alone — which is the whole contract for them.
 *
 * ## ⚠️ WRITES. One throwaway auth user, deleted in `finally`.
 */
const admin = require('firebase-admin');
const path = require('path');
const crypto = require('crypto');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const sa = require(path.resolve(process.cwd(), arg('key')));
const apiKey = arg('api-key'); const webKey = arg('web-key');
const base = (arg('base') || '').replace(/\/$/, '');
if (!apiKey || !webKey || !base) { console.error('need --key= --api-key= --web-key= --base='); process.exit(64); }

admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore(); const auth = admin.auth();

const email = `zz-android-${Date.now()}@stationly-test.invalid`;
let uid = null, failures = 0;
const ok = (p, m) => { console.log(`  ${p ? '✓' : '✗'} ${m}`); if (!p) failures++; };

async function idTokenFor(u) {
    const custom = await auth.createCustomToken(u);
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const j = await r.json();
    if (!j.idToken) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
    return j.idToken;
}
const call = (method, p, body, bearer) => fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Stationly-Key': apiKey,
               ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
});

/** The four fields the released APK cannot survive losing. */
function assertProfileContract(label, json) {
    for (const f of ['uid', 'email', 'displayName', 'stations']) {
        ok(f in json, `${label}: "${f}" present`);
        ok(json[f] !== null && json[f] !== undefined, `${label}: "${f}" not null`);
    }
    ok(Array.isArray(json.stations), `${label}: "stations" is an array`);
    // A sentinel serialises as an opaque object where a scalar is expected. This
    // is the shape of the one incident this contract has had.
    for (const [k, v] of Object.entries(json)) {
        if (['stations', 'boards', 'preferences', 'sessions'].includes(k)) continue;
        ok(v === null || typeof v !== 'object' || Array.isArray(v),
           `${label}: "${k}" is not an opaque object`);
    }
}

(async () => {
    console.log(`Project : ${sa.project_id}\nTarget  : ${base}\nAccount : ${email}\n`);
    const user = await auth.createUser({ email, password: crypto.randomUUID() });
    uid = user.uid;
    const token = await idTokenFor(uid);
    const deviceId = `ANDROID-${crypto.randomUUID().toUpperCase()}`;

    // ── POST /user/sync/profile — the LOGIN, and the one that decodes a body ──
    console.log('POST /user/sync/profile   (released SyncProfileRequest)');
    let r = await call('POST', '/api/v1/user/sync/profile', {
        uid, email, displayName: 'Android Bot', photoURL: null, signInProvider: 'email',
        deviceId, deviceInfo: { platform: 'android', osVersion: 'Android 14 (SDK 34)', model: 'Pixel 8', appVersion: '1.0' },
    }, token);
    ok(r.status === 200, `status ${r.status}`);
    assertProfileContract('login', await r.json());

    // A SECOND login with a CHANGED display name — the only branch that builds a
    // non-empty update, and therefore the only one that ever carried the sentinel.
    console.log('\nPOST /user/sync/profile   (changed displayName — the sentinel branch)');
    r = await call('POST', '/api/v1/user/sync/profile', {
        uid, email, displayName: 'Android Bot Renamed', signInProvider: 'email', deviceId,
    }, token);
    ok(r.status === 200, `status ${r.status}`);
    const renamed = await r.json();
    assertProfileContract('relogin', renamed);
    ok(renamed.displayName === 'Android Bot Renamed', 'the changed name came back');
    ok(typeof renamed.stateRev === 'number', 'stateRev is a NUMBER, not a sentinel');

    // ── POST /user/sync/stations ──
    console.log('\nPOST /user/sync/stations  (released SyncStationsRequest)');
    const stations = [{ id: '940GZZLUKSX', name: "King's Cross", line: 'victoria', mode: 'tube', direction: 'inbound' }];
    r = await call('POST', '/api/v1/user/sync/stations', { uid, stations }, token);
    ok(r.status === 200, `status ${r.status}`);

    // ── GET /user/sync/profile ──
    console.log('\nGET  /user/sync/profile');
    r = await call('GET', `/api/v1/user/sync/profile?uid=${uid}`, null, token);
    ok(r.status === 200, `status ${r.status}`);
    const fetched = await r.json();
    assertProfileContract('fetch', fetched);
    ok(fetched.stations.length === 1, 'the legacy stations list round-tripped');
    ok(fetched.stations[0].id === '940GZZLUKSX', 'station id preserved');

    // ── status-only endpoints ──
    console.log('\nstatus-only endpoints (the APK reads no body from these)');
    r = await call('POST', '/api/v1/user/fcm/register', { token: 'f'.repeat(140), platform: 'android', appVersion: '1.0' }, token);
    ok(r.status === 200, `POST /user/fcm/register → ${r.status}`);
    r = await call('POST', '/api/v1/user/fcm/unregister', { token: 'f'.repeat(140) }, token);
    ok(r.status === 200, `POST /user/fcm/unregister → ${r.status}`);
    r = await call('POST', '/api/v1/user/logout', { uid, deviceId }, token);
    ok(r.status === 200, `POST /user/logout → ${r.status}`);
    r = await call('POST', '/api/v1/user/delete-account', { uid }, token);
    ok(r.status === 200, `POST /user/delete-account → ${r.status}`);

    console.log(`\n${failures === 0 ? 'PASS — the frozen APK\'s contract is intact.' : `✗ FAIL — ${failures} assertion(s).`}`);
    process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error('\nERROR', e); process.exitCode = 1; })
  .finally(async () => {
      if (!uid) return;
      try {
          for (const c of await db.collection('users').doc(uid).listCollections()) {
              for (const d of (await c.get()).docs) await d.ref.delete();
          }
          await db.collection('users').doc(uid).delete();
          await auth.deleteUser(uid).catch(() => {});
          console.log('cleanup: throwaway account removed');
      } catch (e) { console.error('cleanup failed — remove manually:', uid, e.message); }
  });
