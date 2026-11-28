/**
 * Email studio: renderer + audience. Pure modules only (no Firestore, no
 * Resend), so this is safe to run anywhere:
 *
 *     npx ts-node src/tests/email.test.ts
 */
import assert from 'assert';
import { renderEmail, firstNameOf } from '../admin/email/emailRender';
import { EmailDoc, validateDoc, broadcastName, BROADCAST_NAME_MAX } from '../admin/email/emailDoc';
import { resolveAudience, compareVersions, parseEmailList } from '../admin/email/emailAudience';
import type { AdminUser } from '../admin/adminDataService';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e: any) { failed++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

const ctx = { baseUrl: 'https://api.example', webUrl: 'https://web.example' };
const doc = (over: Partial<EmailDoc> = {}): EmailDoc => ({
    subject: 'Hi {{first_name}}', preheader: 'About {{station}}', fromName: 'Stationly', category: 'service',
    header: { logo: true, accentBars: true },
    blocks: [
        { id: 'a', type: 'heading', text: 'Hello {{first_name|friend}}' },
        { id: 'b', type: 'text', text: 'You follow **{{station}}**. See [TfL](https://tfl.gov.uk/x?a=1&b=2).\n\nSecond <script>alert(1)</script>' },
        { id: 'c', type: 'references', items: [{ text: 'FOI-1277-2526', url: 'https://tfl.gov.uk/foi' }, { text: 'FOI-4657' }] },
    ],
    ...over,
});

console.log('email renderer');
test('direct mode merges the recipient and escapes markup', () => {
    const r = renderEmail(doc(), { ...ctx, mode: 'direct', recipient: { firstName: 'Cara', email: 'c@x.com', stations: ['Southfields', 'Wimbledon'] } });
    assert.strictEqual(r.subject, 'Hi Cara');
    assert.ok(r.html.includes('Hello Cara'));
    assert.ok(r.html.includes('<strong>Southfields and Wimbledon</strong>'));
    assert.ok(r.html.includes('href="https://tfl.gov.uk/x?a=1&amp;b=2"'));
    assert.ok(!r.html.includes('<script>'), 'raw script must never reach the HTML');
    assert.ok(r.html.includes('&lt;script&gt;'));
    assert.ok(r.text.includes('TfL (https://tfl.gov.uk/x?a=1&b=2)'));
    assert.ok(r.text.includes('[1] FOI-1277-2526 https://tfl.gov.uk/foi') && r.text.includes('[2] FOI-4657'));
});
test('fallbacks: no first name → the fallback, default "there"', () => {
    const r = renderEmail(doc(), { ...ctx, mode: 'direct', recipient: { firstName: '', email: 'a@b.c' } });
    assert.strictEqual(r.subject, 'Hi there');
    assert.ok(r.html.includes('Hello friend'));
});
test('a name cannot inject HTML', () => {
    const r = renderEmail(doc(), { ...ctx, mode: 'direct', recipient: { firstName: '<img src=x onerror=1>', email: 'a@b.c' } });
    assert.ok(!r.html.includes('<img src=x'));
});
test('broadcast mode emits Resend placeholders and the unsubscribe URL', () => {
    const r = renderEmail(doc({ category: 'marketing', blocks: [{ id: 'a', type: 'text', text: 'Hi {{first_name}}, {{email}}' }] }), { ...ctx, mode: 'broadcast' });
    assert.ok(r.html.includes('{{{contact.first_name|there}}}'));
    assert.ok(r.html.includes('{{{contact.email}}}'));
    assert.ok(r.html.includes('href="{{{RESEND_UNSUBSCRIBE_URL}}}"'));
});
test('service emails carry no unsubscribe link; marketing direct uses ours', () => {
    const s = renderEmail(doc(), { ...ctx, mode: 'direct', recipient: { email: 'a@b.c' } });
    assert.ok(!/Unsubscribe/.test(s.html));
    const m = renderEmail(doc({ category: 'marketing' }), { ...ctx, mode: 'direct', recipient: { email: 'a@b.c' }, unsubscribeUrl: 'https://api.example/u?x=1' });
    assert.ok(m.html.includes('href="https://api.example/u?x=1"'));
});
test('service emails have no "why you got this" footer line', () => {
    const s = renderEmail(doc(), { ...ctx, mode: 'direct', recipient: { email: 'a@b.c' } });
    assert.ok(!/receiving this/i.test(s.html) && !/receiving this/i.test(s.text));
    assert.ok(s.text.includes('Stationly Ltd, London, UK'));
});
test('signature card: logo, name, role, website; plain sign-off unchanged', () => {
    const card = renderEmail(doc({ blocks: [{ id: 's', type: 'signoff', name: 'Stationly Support', role: 'Support team', url: 'https://www.stationly.co.uk/', logo: true }] }), { ...ctx, mode: 'preview' });
    assert.ok(card.html.includes('stationly_logo_final.png'));
    assert.ok(card.html.includes('href="https://www.stationly.co.uk/"') && card.html.includes('>stationly.co.uk</a>'));
    assert.ok(card.text.includes('Stationly Support\nSupport team\nhttps://www.stationly.co.uk/'));
    const plainSig = renderEmail(doc({ blocks: [{ id: 's', type: 'signoff', name: 'Stationly Support' }] }), { ...ctx, mode: 'preview' });
    assert.ok(!/<a [^>]*>stationly\.co\.uk/.test(plainSig.html));
    const bad = renderEmail(doc({ blocks: [{ id: 's', type: 'signoff', name: 'X', url: 'javascript:alert(1)' }] }), { ...ctx, mode: 'preview' });
    assert.ok(!bad.html.includes('javascript:') && !bad.text.includes('javascript:'));
    assert.ok(validateDoc(doc({ blocks: [{ id: 's', type: 'signoff', name: 'X', url: 'javascript:alert(1)' }] })).some((p) => p.includes('website link')));
});
test('unsafe link schemes are neutralised', () => {
    const r = renderEmail(doc({ blocks: [{ id: 'a', type: 'text', text: '[x](javascript:alert(1))' }, { id: 'b', type: 'button', label: 'Go', url: 'javascript:alert(1)' }] }), { ...ctx, mode: 'preview' });
    assert.ok(!r.html.includes('javascript:'));
});
test('validation: broadcasts reject {{station}}; direct accepts it', () => {
    assert.ok(validateDoc(doc(), { mode: 'broadcast' }).some((p) => p.includes('{{station}}')));
    assert.deepStrictEqual(validateDoc(doc(), { mode: 'direct' }), []);
    assert.ok(validateDoc(doc({ subject: '' })).length > 0);
});
test('firstNameOf skips placeholders and email-like names', () => {
    assert.strictEqual(firstNameOf('Cara McAvinchey'), 'Cara');
    assert.strictEqual(firstNameOf('Stationly User'), '');
    assert.strictEqual(firstNameOf('john@x.com'), '');
    assert.strictEqual(firstNameOf('vince prash', 'vinceprash@gmail.com'), 'Vince');
});

console.log('email audience');
const day = 86_400_000;
const NOW = Date.UTC(2026, 10, 27);
const user = (uid: string, email: string, o: Partial<AdminUser> = {}): AdminUser => ({
    uid, email, displayName: `${uid} Test`, photoURL: '', signInProvider: 'google.com', createdAt: NOW - 30 * day, updatedAt: 0,
    lastLoggedInTime: 0, loggedIn: true, emailVerified: true, stationCount: 0, sessions: [], stations: [],
    support: { count: 0, totalMinor: 0, lastAtMs: 0 }, ...o,
});
const users: AdminUser[] = [
    user('a', 'A@x.com', { displayName: 'alice smith', stationCount: 1, sessions: [{ deviceId: '1', platform: 'android', appVersion: '1.0', lastSeen: new Date(NOW - 2 * day).toISOString() }],
        stations: [{ id: '940GZZLUSFS', name: 'Southfields Underground Station', line: 'district', mode: 'tube', direction: 'outbound' }] }),
    user('b', 'b@x.com', { sessions: [{ deviceId: '2', platform: 'ios', appVersion: '1.1', lastSeen: new Date(NOW - 40 * day).toISOString() }] }),
    user('c', 'c@privaterelay.appleid.com', { stationCount: 1, sessions: [{ deviceId: '3', platform: 'android', appVersion: '2.0', lastSeen: new Date(NOW).toISOString() }],
        stations: [{ id: '940GZZLUSFS', name: 'Southfields Underground Station', line: 'district', mode: 'tube', direction: 'inbound' }] }),
    user('d', '', {}),
];
const inp = { users, waitlist: [{ id: 'w', email: 'w@x.com', joinedAt: NOW }], optedOut: new Set(['b@x.com']), now: NOW };

test('platform + version: Android users still on 1.x', () => {
    const r = resolveAudience({ source: 'users', platforms: ['android'], appVersion: { platform: 'android', op: 'lt', value: '2.0' } }, 'service', inp);
    assert.deepStrictEqual(r.recipients.map((x) => x.email), ['a@x.com']);
});
test('station + line + direction, with matched station names', () => {
    const r = resolveAudience({ source: 'users', stations: ['940GZZLUSFS'], lines: ['district'], directions: ['outbound'] }, 'service', inp);
    assert.deepStrictEqual(r.recipients.map((x) => x.email), ['a@x.com']);
    assert.deepStrictEqual(r.recipients[0].stations, ['Southfields']);
});
test('marketing skips opt-outs; service does not', () => {
    assert.ok(!resolveAudience({ source: 'users' }, 'marketing', inp).recipients.some((x) => x.email === 'b@x.com'));
    assert.ok(resolveAudience({ source: 'users' }, 'service', inp).recipients.some((x) => x.email === 'b@x.com'));
});
test('exclusions are counted with reasons', () => {
    const r = resolveAudience({ source: 'users', excludeAppleRelay: true, excludeEmails: ['a@x.com'] }, 'marketing', inp);
    const reasons = Object.fromEntries(r.excluded.map((e) => [e.reason, e.count]));
    assert.strictEqual(reasons['No email on the account'], 1);
    assert.strictEqual(reasons['Apple hidden email (excluded)'], 1);
    assert.strictEqual(reasons['Excluded by you'], 1);
    assert.strictEqual(reasons['Unsubscribed from news emails'], 1);
    assert.strictEqual(r.recipients.length, 0);
});
test('custom emails, dedupe, and account names for known addresses', () => {
    const r = resolveAudience({ source: 'none', customEmails: ['a@x.com', 'A@X.com', 'new@y.com', 'bad'] }, 'service', inp);
    assert.deepStrictEqual(r.recipients.map((x) => x.email).sort(), ['a@x.com', 'new@y.com']);
    assert.strictEqual(r.recipients.find((x) => x.email === 'a@x.com')!.firstName, 'Alice');
});
test('activity window and staging allowlist', () => {
    assert.deepStrictEqual(resolveAudience({ source: 'users', activeWithinDays: 7 }, 'service', inp).recipients.map((x) => x.email).sort(), ['a@x.com', 'c@privaterelay.appleid.com']);
    const r = resolveAudience({ source: 'users' }, 'service', { ...inp, allowlist: new Set(['a@x.com']) });
    assert.deepStrictEqual(r.recipients.map((x) => x.email), ['a@x.com']);
});
test('waitlist source', () => {
    assert.deepStrictEqual(resolveAudience({ source: 'waitlist' }, 'marketing', inp).recipients.map((x) => x.email), ['w@x.com']);
});
test('broadcast names fit Resend\'s 70 characters and keep the campaign id', () => {
    const id = 'DtuIzUqoEJ3NaSfTYyey';
    assert.strictEqual(broadcastName('Android launch', id), `Android launch (${id})`);
    const long = broadcastName('TEST broadcast 2: Android you asked, we listened', id);
    assert.ok(long.length <= BROADCAST_NAME_MAX, `${long.length} chars`);
    assert.ok(long.endsWith(`(${id})`));
    assert.ok(broadcastName('x'.repeat(500), id).length <= BROADCAST_NAME_MAX);
    assert.strictEqual(broadcastName('  ', id), `Untitled email (${id})`);
});
test('one-line headings keep each half whole and break only between them', () => {
    const mk = (oneLine?: boolean, accent = 'Kept going by you.') => ({ subject: 's', fromName: 'Stationly', category: 'marketing', header: { logo: false, accentBars: false },
        blocks: [{ id: 'h', type: 'heading', text: 'Free. No ads.', accent, size: 'md', oneLine }] } as EmailDoc);
    const two = renderEmail(mk(false), { mode: 'preview', baseUrl: 'https://api.x', webUrl: 'https://x' }).html;
    assert.ok(/Free\. No ads\.<br><span style="color:#DD2C33;">Kept going by you\.<\/span>/.test(two), 'default stays two lines');
    const one = renderEmail(mk(true), { mode: 'preview', baseUrl: 'https://api.x', webUrl: 'https://x' }).html;
    assert.ok(one.includes('<span style="white-space:nowrap;">Free. No ads.</span> <span style="color:#DD2C33;"><span style="white-space:nowrap;">Kept going by you.</span></span>'), 'one line, nowrap halves');
    const long = renderEmail(mk(true, 'and a very long red part that cannot fit'), { mode: 'preview', baseUrl: 'https://api.x', webUrl: 'https://x' }).html;
    assert.ok(!long.includes('white-space:nowrap;">and a very long'), 'a half too long for a phone may wrap');
    // The phone size of a large heading fits fewer characters than a small one.
    const big = (accent: string, size: 'xl' | 'md') => renderEmail({ ...mk(true, accent), blocks: [{ id: 'h', type: 'heading', text: 'Hi.', accent, size, oneLine: true }] } as EmailDoc, { mode: 'preview', baseUrl: 'https://api.x', webUrl: 'https://x' }).html;
    const twenty = 'Twenty characters ok';
    assert.ok(big(twenty, 'md').includes(`nowrap;">${twenty}`), 'md keeps 20 characters whole');
    assert.ok(!big(twenty, 'xl').includes(`nowrap;">${twenty}`), 'xl lets 20 characters wrap on a phone');
    assert.ok(big('We listened.', 'xl').includes('nowrap;">We listened.'), 'short hero halves stay whole');
});
test('helpers', () => {
    assert.strictEqual(compareVersions('2.0.10', '2.0.9'), 1);
    assert.strictEqual(compareVersions('1.1', '1.1.0'), 0);
    assert.deepStrictEqual(parseEmailList('a@x.com, B@x.com;\nc@x.com a@x.com'), ['a@x.com', 'b@x.com', 'c@x.com']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
