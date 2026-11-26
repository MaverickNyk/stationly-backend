/*
 * READ-ONLY: how far people get through asking for support, from the apps'
 * activity trail, plus what was actually paid.
 *
 *   node src/scripts/support_funnel.cjs --key=<service account json>
 *   node src/scripts/support_funnel.cjs --key=… --days=30
 *   node src/scripts/support_funnel.cjs --key=… --from=2026-12-01 --to=2026-12-31
 *
 * Reads `users/{uid}/activity/{YYYY-MM-DD}_{deviceId}` (see
 * userActivityService.ts) for every account, keeps the support events, and
 * prints, per platform:
 *
 *   - how many times each step happened, and how many PEOPLE did it
 *   - the step to step rates that matter: asked → opened the amounts →
 *     tapped an amount → paid
 *
 * and then the payments the server recorded in `support_money_txns` over the
 * same dates, by route. Those are the truth about money; the activity trail is
 * the truth about where people stop.
 *
 * Two things to remember when reading it:
 *   - Activity uploads in batches, often overnight, so the last day or two is
 *     always short. Leave a two day gap before trusting a week.
 *   - Only signed-in people upload activity. Someone who uses the app signed
 *     out is invisible here, and cannot pay either (a payment needs an account
 *     to credit).
 *
 * NEVER writes. One read per account to list its activity documents in range.
 */
const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');

const keyArg = arg('key');
if (!keyArg || !fs.existsSync(path.resolve(keyArg))) {
    console.error('usage: node src/scripts/support_funnel.cjs --key=<service account json> [--days=N | --from=YYYY-MM-DD --to=YYYY-MM-DD]');
    process.exit(2);
}
admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyArg))) });
const db = admin.firestore();

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const days = Number(arg('days')) || 14;
const to = arg('to') || day(Date.now());
const from = arg('from') || day(Date.now() - (days - 1) * 86_400_000);

// The steps, in the order a person meets them. Names are the client's
// ActivityEvents constants; keep the two in step.
const STEPS = [
    ['support.asked', 'asked (banner shown)'],
    ['support.ask_dismissed', 'said maybe later'],
    ['whats_new.shown', "saw What's new"],
    ['whats_new.support_tapped', "tapped Support on What's new"],
    ['support.sheet_opened', 'opened the amounts'],
    ['support.tier_tapped', 'tapped an amount'],
    ['support.purchase', 'store answered'],
    ['support.verified', 'our server answered (Play)'],
    ['support.sheet_closed', 'closed the amounts'],
    ['support.thanks_shown', 'saw the thank you'],
];

(async () => {
    const counts = {};   // platform → event → { n, people:Set }
    const detail = {};   // platform → "event prop=value" → n
    const bump = (platform, name, uid) => {
        counts[platform] ??= {};
        counts[platform][name] ??= { n: 0, people: new Set() };
        counts[platform][name].n++;
        counts[platform][name].people.add(uid);
    };
    const note = (platform, key) => {
        detail[platform] ??= {};
        detail[platform][key] = (detail[platform][key] || 0) + 1;
    };

    const users = await db.collection('users').select().get();
    const openers = {}; // platform → Set of uids that opened the app in range
    for (const u of users.docs) {
        const snap = await u.ref.collection('activity')
            .where(admin.firestore.FieldPath.documentId(), '>=', from)
            .where(admin.firestore.FieldPath.documentId(), '<', `${to}~`)
            .get();
        for (const d of snap.docs) {
            const data = d.data();
            const platform = data.platform || 'unknown';
            for (const e of data.events || []) {
                if (e.name === 'app.opened') (openers[platform] ??= new Set()).add(u.id);
                if (!e.name.startsWith('support.') && !e.name.startsWith('whats_new.')) continue;
                bump(platform, e.name, u.id);
                const p = e.props || {};
                for (const k of ['trigger', 'from', 'progress', 'result', 'outcome', 'tier', 'started', 'route', 'code', 'via']) {
                    if (p[k] !== undefined) note(platform, `${e.name} ${k}=${p[k]}`);
                }
            }
        }
    }

    console.log(`Support funnel ${from} → ${to} (${users.size} accounts scanned)\n`);
    const platforms = new Set([...Object.keys(counts), ...Object.keys(openers)]);
    for (const platform of platforms) {
        const c = counts[platform] || {};
        const people = (name) => (c[name] ? c[name].people.size : 0);
        console.log(`── ${platform}: ${openers[platform]?.size || 0} people opened the app`);
        for (const [name, label] of STEPS) {
            if (!c[name]) continue;
            console.log(`   ${label.padEnd(32)} ${String(c[name].n).padStart(6)} times  ${String(people(name)).padStart(5)} people`);
        }
        const rate = (a, b) => (people(b) ? `${Math.round((100 * people(a)) / people(b))}%` : 'n/a');
        console.log(`   asked → opened amounts: ${rate('support.sheet_opened', 'support.asked')}   ` +
            `opened → tapped amount: ${rate('support.tier_tapped', 'support.sheet_opened')}   ` +
            `tapped → thank you: ${rate('support.thanks_shown', 'support.tier_tapped')}`);
        for (const [k, n] of Object.entries(detail[platform] || {}).sort()) console.log(`     ${k}: ${n}`);
        console.log('');
    }

    // Money, from the server's own record of each payment.
    const txns = await db.collection('support_money_txns')
        .where('atMs', '>=', Date.parse(`${from}T00:00:00Z`))
        .where('atMs', '<', Date.parse(`${to}T00:00:00Z`) + 86_400_000)
        .get();
    const bySource = {};
    for (const t of txns.docs) {
        const r = t.data();
        const key = `${r.source} ${String(r.currency || 'GBP').toUpperCase()}`;
        bySource[key] ??= { n: 0, minor: 0 };
        bySource[key].n++;
        bySource[key].minor += Number(r.amountMinor) || 0;
    }
    // Real money only: store test purchases and unverified receipts are never
    // written to support_money_txns. Grouped by currency, never summed across.
    console.log('── payments recorded by the server');
    if (!txns.size) console.log('   none');
    for (const [key, v] of Object.entries(bySource)) {
        const [src, cur] = key.split(' ');
        const sym = cur === 'GBP' ? '£' : `${cur} `;
        console.log(`   ${src.padEnd(8)} ${v.n} payments  ${sym}${(v.minor / 100).toFixed(2)} gross`);
    }
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
