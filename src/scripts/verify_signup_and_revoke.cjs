/*
 * END-TO-END verification of two fixes that are otherwise only reachable by
 * hand on a device:
 *
 *   §1.1  a SIGNUP creates users/{uid}/devices/{deviceId}
 *   §1.2  /device/register refuses a token whose account has been DELETED
 *
 *   node src/scripts/verify_signup_and_revoke.cjs --key=<sa> --api-key=<x> \
 *        --web-key=<firebase web api key> --base=<https://…>
 *
 * ## ⚠️ This one WRITES. It is the only verification script that does.
 * It creates ONE throwaway Firebase Auth user, drives the real HTTP endpoints
 * with a real ID token, and deletes everything it made — including on failure,
 * via the finally block. Nothing it touches belongs to anybody.
 *
 * ## Why an end-to-end script and not a unit test
 * Both fixes live in the gap between Firebase Auth and this backend, which is
 * exactly the gap a stub erases. §1.2 in particular turns on `verifyIdToken`'s
 * SECOND argument reaching Google and being told the user is gone — a unit test
 * that stubbed `auth` would assert the argument was passed and prove nothing
 * about what it does. The bug it guards (a deleted account's device row, live in
 * the broadcast audience, unreachable by every maintenance job) is worth a real
 * token.
 */
const admin = require('firebase-admin');
const path = require('path');
const crypto = require('crypto');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const sa = require(path.resolve(process.cwd(), arg('key')));
const apiKey = arg('api-key');
const webKey = arg('web-key');
const base = (arg('base') || '').replace(/\/$/, '');
if (!apiKey || !webKey || !base) {
    console.error('need --key= --api-key= --web-key= --base=');
    process.exit(64);
}

admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const auth = admin.auth();

const deviceId = `TEST-${crypto.randomUUID().toUpperCase()}`;
const email = `zz-verify-${Date.now()}@stationly-test.invalid`;
let uid = null;
let failures = 0;

const ok = (pass, msg) => { console.log(`  ${pass ? '✓' : '✗'} ${msg}`); if (!pass) failures++; };

/** Custom token → ID token, the same exchange the mobile SDK performs. */
async function idTokenFor(u) {
    const custom = await auth.createCustomToken(u);
    const r = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${webKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const j = await r.json();
    if (!j.idToken) throw new Error(`token exchange failed: ${JSON.stringify(j)}`);
    return j.idToken;
}

const post = (p, body, bearer) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Stationly-Key': apiKey,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
});

const deviceRow = async () =>
    (await db.collection('users').doc(uid).collection('devices').doc(deviceId).get());

(async () => {
    console.log(`Project : ${sa.project_id}`);
    console.log(`Target  : ${base}`);
    console.log(`Throwaway: ${email}\n`);

    const user = await auth.createUser({ email, password: crypto.randomUUID() });
    uid = user.uid;
    let token = await idTokenFor(uid);

    // ── §1.1 SIGNUP ─────────────────────────────────────────────────────────
    console.log('§1.1  signup must create the device row');
    const signup = await post('/api/v1/user/sync/profile', {
        uid, email, displayName: 'Verify Bot', signInProvider: 'email',
        deviceId, deviceInfo: { platform: 'ios', model: 'VerifyPhone', osVersion: 'iOS 26.3', appVersion: '1.0' },
    }, token);
    ok(signup.status === 200, `POST /user/sync/profile → ${signup.status}`);

    const doc = await db.collection('users').doc(uid).get();
    ok(doc.exists, 'user document created');
    ok(doc.data()?.loggedIn === true, 'loggedIn is true');

    const row = await deviceRow();
    // THE assertion. Before the fix this branch returned before `startSession`
    // and `bind()` was a no-op, so a brand-new account sat at `loggedIn: true`
    // with ZERO rows — which the nightly sweep reads as "every session ended".
    ok(row.exists, 'device row EXISTS immediately after signup');
    if (row.exists) {
        const r = row.data();
        ok(r.deviceId === deviceId, 'deviceId stored as a FIELD');
        ok(typeof r.firstSeen === 'number', 'firstSeen written by login');
        ok(r.model === 'VerifyPhone', 'model written by login');
        ok(!r.appToken && !r.widgetToken, 'login invented NO token fields');
    }

    // The invariant the sweep depends on now actually holds for a new account.
    const devs = await db.collection('users').doc(uid).collection('devices').get();
    ok(devs.size === 1, `loggedIn ⇔ exactly one live row (found ${devs.size})`);

    // ── §1.2 REVOKED / DELETED ──────────────────────────────────────────────
    console.log('\n§1.2  /device/register must refuse a deleted account');
    const before = await post('/api/v1/device/register', {
        deviceId, environment: 'sandbox', appToken: 'a'.repeat(64), iosVersion: 'iOS 26.3',
    }, token);
    ok(before.status === 200, `register while alive → ${before.status} (expected 200)`);
    ok((await deviceRow()).data()?.appToken !== undefined, 'token merged onto the row');

    // Delete the ACCOUNT. The ID token minted above stays signature-valid for
    // ~an hour — this is exactly the window a real device foregrounds into.
    await auth.deleteUser(uid);
    await db.collection('users').doc(uid).delete();
    for (const d of (await db.collection('users').doc(uid).collection('devices').get()).docs) {
        await d.ref.delete();
    }

    const after = await post('/api/v1/device/register', {
        deviceId, environment: 'sandbox', appToken: 'b'.repeat(64), iosVersion: 'iOS 26.3',
    }, token);
    // 401 is the fix working: `verifyIdToken(token, true)` asks Google, which
    // reports the user gone. Without the second argument the check is OFFLINE,
    // the signature still validates, and this returns 200 having written a row
    // under a deleted account that no maintenance job can ever reach.
    ok(after.status === 401, `register after deletion → ${after.status} (expected 401)`);

    const resurrected = await deviceRow();
    ok(!resurrected.exists, 'NO device row resurrected under the deleted account');

    console.log(`\n${failures === 0 ? 'PASS — both fixes verified end to end.' : `✗ FAIL — ${failures} assertion(s).`}`);
    process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error('\nERROR', e); process.exitCode = 1; })
  .finally(async () => {
      // Always, including on failure. This script is the only one that writes,
      // so it is the only one that can leave litter.
      if (!uid) return;
      try {
          for (const d of (await db.collection('users').doc(uid).collection('devices').get()).docs) {
              await d.ref.delete();
          }
          await db.collection('users').doc(uid).delete();
          await auth.deleteUser(uid).catch(() => {});
          console.log('cleanup: throwaway account removed');
      } catch (e) { console.error('cleanup failed — remove manually:', uid, e.message); }
  });
