/**
 * Email campaigns: drafts, previews, tests and real sends.
 *
 * Storage (Firestore, master): `admin_email_campaigns/<id>` holds the draft
 * (doc + audience filter) and, once sent, its status and result. Each sent
 * chunk is recorded under `…/<id>/deliveries/<n>` (who, Resend ids, errors) so
 * there is an audit trail of exactly who received what. Reads happen only when
 * the console opens the list or a campaign.
 *
 * Two ways to send, picked per campaign (see `plan()`):
 *   direct    Resend batch API, ≤100 per request, one render per recipient, so
 *             {{station}} works. Uses the transactional quota (100/day free).
 *   broadcast Resend Broadcasts to the managed segment. Uses no transactional
 *             quota (free: unlimited sends to ≤1,000 contacts); Resend handles
 *             unsubscribes. Only {{first_name}} / {{email}} personalise.
 *
 * One send runs at a time (lock doc `admin_email_meta/state`, auto-expires
 * after 30 min), because broadcasts share one segment and quota is shared.
 */
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import { db } from '../../config/firebase';
import { getBaseUrl, getWebUrl, isStaging } from '../../utils/formatters';
import { AdminDataService } from '../adminDataService';
import { EmailDoc, emptyDoc, validateDoc, broadcastName } from './emailDoc';
import { renderEmail, RenderRecipient, fromHeader, firstNameOf } from './emailRender';
import { AudienceFilter, AudienceResult, Recipient, resolveAudience, parseEmailList, EMAIL_RE } from './emailAudience';
import { EMAIL_LIMITS, EmailOptOuts, EmailUsage, UsageSnapshot, unsubscribeUrl } from './emailStores';
import * as R from './resendClient';

export type SendMode = 'direct' | 'broadcast';
export type CampaignStatus = 'draft' | 'sending' | 'sent' | 'partial' | 'failed';

export interface Campaign {
    id: string;
    name: string;
    doc: EmailDoc;
    audience: AudienceFilter;
    status: CampaignStatus;
    mode?: SendMode;
    createdAt: number;
    updatedAt: number;
    sentAt?: number;
    progress?: { phase: string; done: number; total: number } | null;
    result?: {
        total: number; sent: number; failed: number;
        broadcastId?: string; broadcastStatus?: string;
        errors?: Array<{ to?: string; error: string }>;
        segmentSync?: { added: number; removed: number; created: number };
    } | null;
    tests?: Array<{ at: number; to: string[]; ok: number; failed: number }>;
}

const COL = () => db.collection('admin_email_campaigns');
const STATE = () => db.collection('admin_email_meta').doc('state');
const LOCK_TTL = 15 * 60_000;
/**
 * A send writes progress at least every batch of 100 (direct) or every 10
 * contacts (broadcast sync), so 10 minutes without an update means the worker
 * running it is gone (e.g. a PM2 reload during a deploy).
 */
const STALE_MS = 10 * 60_000;
const now = () => Date.now();
const err = (status: number, message: string, extra?: object) => Object.assign(new Error(message), { status, ...extra });

function defaultAudience(): AudienceFilter {
    return { source: 'none', customEmails: [] };
}

function stagingAllowlist(): Set<string> | null {
    if (!isStaging()) return null;
    const list = parseEmailList(process.env.EMAIL_STAGING_ALLOWLIST || '');
    return list.length ? new Set(list) : null;
}

function toCampaign(id: string, d: any): Campaign {
    return {
        id,
        name: d.name || 'Untitled email',
        doc: { ...emptyDoc(), ...(d.doc || {}) },
        audience: d.audience || defaultAudience(),
        status: d.status || 'draft',
        mode: d.mode,
        createdAt: d.createdAt || 0,
        updatedAt: d.updatedAt || 0,
        sentAt: d.sentAt,
        progress: d.progress || null,
        result: d.result || null,
        tests: d.tests || [],
    };
}

// ── audience ────────────────────────────────────────────────────────────

export async function audienceFor(filter: AudienceFilter, category: EmailDoc['category']): Promise<AudienceResult> {
    await AdminDataService.getUsers(); // warm/refresh the cache (0 reads when warm)
    const needWaitlist = filter.source === 'waitlist';
    const waitlist = needWaitlist ? (await AdminDataService.getWaitlist()).rows : [];
    const optedOut = category === 'marketing' ? await EmailOptOuts.all() : new Set<string>();
    return resolveAudience(filter, category, {
        users: AdminDataService.allUsers(),
        waitlist,
        optedOut,
        allowlist: stagingAllowlist(),
    });
}

export interface SendPlan {
    count: number;
    recommended: SendMode | null;
    direct: { allowed: boolean; reason: string; quotaAfter?: number };
    broadcast: { allowed: boolean; reason: string };
    usage: UsageSnapshot;
}

/** Which way to send, given size, category, content and today's quota. */
export function plan(count: number, doc: EmailDoc, usage: UsageSnapshot, recipients?: Recipient[]): SendPlan {
    const directProblems = validateDoc(doc, { mode: 'direct' });
    // {{station}} with no fallback needs every recipient to have matched one.
    if (recipients && /\{\{\s*station\s*\}\}/i.test(JSON.stringify(doc))) {
        const missing = recipients.filter((r) => !r.stations?.length).length;
        if (missing) directProblems.push(`${missing} of ${count} ${missing === 1 ? 'person has' : 'people have'} no matched station for {{station}}. Add a station filter, or write {{station|your station}}.`);
    }
    const broadcastProblems = validateDoc(doc, { mode: 'broadcast' });
    const remaining = Math.min(usage.remainingToday, usage.remainingThisMonth);

    const direct = directProblems.length
        ? { allowed: false, reason: directProblems[0] }
        : count === 0 ? { allowed: false, reason: 'Nobody matches this audience.' }
        : count > remaining ? { allowed: false, reason: `Needs ${count} of today's transactional quota; ${remaining} left (resets at midnight UTC). Use a broadcast, or send tomorrow.` }
        : { allowed: true, reason: `Uses ${count} of ${remaining} emails left today. Personal fields like {{station}} work.`, quotaAfter: remaining - count };

    const broadcast = !R.resendConfigured() ? { allowed: false, reason: 'RESEND_API_KEY is not set on this server.' }
        : broadcastProblems.length ? { allowed: false, reason: broadcastProblems[0] }
        : count === 0 ? { allowed: false, reason: 'Nobody matches this audience.' }
        : count > EMAIL_LIMITS.marketingContacts ? { allowed: false, reason: `More than ${EMAIL_LIMITS.marketingContacts} people: over the free marketing contacts limit.` }
        : { allowed: true, reason: `Uses none of the daily quota. Resend skips anyone who unsubscribed from Stationly news${doc.category === 'service' ? ' (even for this service email)' : ''}.` };

    let recommended: SendMode | null = null;
    if (direct.allowed && broadcast.allowed) {
        // Marketing → broadcast (Resend manages unsubscribes, saves quota).
        // Service → direct when small, so everyone gets it regardless of
        // marketing opt-outs; broadcast when it would eat most of today's quota.
        recommended = doc.category === 'marketing' ? 'broadcast' : count <= Math.max(10, Math.floor(remaining / 2)) ? 'direct' : 'broadcast';
    } else if (direct.allowed) recommended = 'direct';
    else if (broadcast.allowed) recommended = 'broadcast';
    return { count, recommended, direct, broadcast, usage };
}

// ── CRUD ────────────────────────────────────────────────────────────────

export class EmailCampaigns {
    static async list(): Promise<Array<Omit<Campaign, 'doc' | 'audience'> & { subject: string; category: string }>> {
        const snap = await COL().orderBy('updatedAt', 'desc').limit(60)
            .select('name', 'status', 'mode', 'createdAt', 'updatedAt', 'sentAt', 'result', 'doc.subject', 'doc.category').get();
        return snap.docs.map((d) => {
            const c = toCampaign(d.id, d.data());
            const { doc, audience, ...rest } = c;
            return { ...rest, subject: doc.subject, category: doc.category };
        });
    }

    static async get(id: string): Promise<Campaign> {
        const d = await COL().doc(id).get();
        if (!d.exists) throw err(404, 'No such email.');
        const c = toCampaign(d.id, d.data());
        return c.status === 'sending' && now() - c.updatedAt > STALE_MS ? markInterrupted(c) : c;
    }

    static async create(input?: Partial<Pick<Campaign, 'name' | 'doc' | 'audience'>>): Promise<Campaign> {
        const ref = COL().doc();
        const c: Omit<Campaign, 'id'> = {
            name: input?.name?.trim() || 'Untitled email',
            doc: { ...emptyDoc(), ...(input?.doc || {}) },
            audience: input?.audience || defaultAudience(),
            status: 'draft', createdAt: now(), updatedAt: now(), progress: null, result: null, tests: [],
        };
        await ref.set(c);
        return { id: ref.id, ...c };
    }

    static async update(id: string, patch: Partial<Pick<Campaign, 'name' | 'doc' | 'audience'>>): Promise<Campaign> {
        const ref = COL().doc(id);
        return db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) throw err(404, 'No such email.');
            const cur = toCampaign(id, snap.data());
            if (cur.status !== 'draft') throw err(409, 'This email has been sent. Duplicate it to make changes.');
            const next = {
                ...(patch.name !== undefined ? { name: String(patch.name).slice(0, 120) || 'Untitled email' } : {}),
                ...(patch.doc ? { doc: patch.doc } : {}),
                ...(patch.audience ? { audience: patch.audience } : {}),
                updatedAt: now(),
            };
            tx.update(ref, next);
            return { ...cur, ...next } as Campaign;
        });
    }

    static async duplicate(id: string): Promise<Campaign> {
        const c = await this.get(id);
        return this.create({ name: `${c.name} (copy)`, doc: c.doc, audience: c.audience });
    }

    static async remove(id: string): Promise<void> {
        const c = await this.get(id);
        if (c.status === 'sending') throw err(409, 'This email is sending right now.');
        if (c.status !== 'draft') throw err(409, 'Sent emails are kept as a record and cannot be deleted.');
        await COL().doc(id).delete();
    }

    // ── test send ───────────────────────────────────────────────────────

    /** Send the draft to ≤5 addresses typed in the console, marked [Test]. */
    static async sendTest(doc: EmailDoc, to: string[], opts?: { campaignId?: string; sample?: Recipient }): Promise<{ sent: string[]; failed: Array<{ to: string; error: string }>; usage: UsageSnapshot }> {
        const emails = parseEmailList(to);
        if (emails.length === 0) throw err(400, 'Add at least one test address.');
        if (emails.length > 5) throw err(400, 'Test sends go to at most 5 addresses.');
        const bad = emails.filter((e) => !EMAIL_RE.test(e));
        if (bad.length) throw err(400, `Not a valid email: ${bad.join(', ')}`);
        const problems = validateDoc(doc, { mode: 'direct' });
        if (problems.length) throw err(400, problems[0], { problems });
        const usage = await EmailUsage.snapshot(true);
        if (emails.length > usage.remainingToday) throw err(409, `Only ${usage.remainingToday} emails left today.`);

        await AdminDataService.getUsers();
        const users = new Map(AdminDataService.allUsers().map((u) => [u.email.toLowerCase(), u]));
        const out = emails.map((email) => {
            const u = users.get(email);
            const sample: RenderRecipient = opts?.sample
                ? { firstName: opts.sample.firstName, email, stations: opts.sample.stations }
                : { firstName: u ? firstNameOf(u.displayName, email) : '', email };
            const r = renderEmail(doc, {
                mode: 'direct', baseUrl: getBaseUrl(), webUrl: getWebUrl(), recipient: sample,
                unsubscribeUrl: doc.category === 'marketing' ? unsubscribeUrl(getBaseUrl(), email) : undefined,
                subjectPrefix: `${isStaging() ? '[Staging] ' : ''}[Test] `,
            });
            return { to: email, from: r.from, subject: r.subject, html: r.html, text: r.text, replyTo: doc.replyTo, tags: [{ name: 'kind', value: 'test' }] };
        });
        const res = await R.sendBatch(out);
        EmailUsage.record(res.sent.length);
        if (opts?.campaignId) {
            await COL().doc(opts.campaignId).update({
                tests: admin.firestore.FieldValue.arrayUnion({ at: now(), to: emails, ok: res.sent.length, failed: res.failed.length }),
            }).catch(() => undefined);
        }
        return { sent: res.sent.map((s) => s.to), failed: res.failed, usage: await EmailUsage.snapshot() };
    }

    // ── real send ───────────────────────────────────────────────────────

    /**
     * Start sending. Re-resolves the audience server-side and refuses unless
     * the count matches what the admin confirmed (`confirmCount`), so a
     * filter that changed since the preview can't silently widen a send.
     */
    static async send(id: string, mode: SendMode, confirmCount: number): Promise<Campaign> {
        const c = await this.get(id);
        if (c.status !== 'draft') throw err(409, 'This email has already been sent. Duplicate it to send again.');
        const problems = validateDoc(c.doc, { mode });
        if (problems.length) throw err(400, problems[0], { problems });

        // Pull Resend-side unsubscribes into our list first (marketing only).
        if (c.doc.category === 'marketing' && R.resendConfigured()) {
            const contacts = await R.listContacts().catch(() => []);
            const unsub = contacts.filter((x) => x.unsubscribed).map((x) => x.email);
            if (unsub.length) await EmailOptOuts.addMany(unsub, 'resend');
        }

        const aud = await audienceFor(c.audience, c.doc.category);
        if (aud.recipients.length !== confirmCount) {
            throw err(409, `The audience is now ${aud.recipients.length} people, not ${confirmCount}. Check the list again before sending.`, { count: aud.recipients.length });
        }
        const usage = await EmailUsage.snapshot(true);
        const p = plan(aud.recipients.length, c.doc, usage, aud.recipients);
        const choice = mode === 'direct' ? p.direct : p.broadcast;
        if (!choice.allowed) throw err(409, choice.reason);

        const started: Partial<Campaign> = {
            status: 'sending', mode, updatedAt: now(),
            progress: { phase: 'Starting', done: 0, total: aud.recipients.length }, result: null,
        };
        // Lock + draft→sending in ONE transaction, so a double click (or two
        // tabs) can never start the same email twice.
        await startSend(id, mode, started);

        const stats = { sent: 0, failed: 0 };
        const job = mode === 'direct' ? runDirect(c, aud.recipients, stats) : runBroadcast(c, aud.recipients);
        job.catch(async (e) => {
            console.error(`[EmailCampaigns] ${id} failed`, e);
            const notTried = Math.max(0, aud.recipients.length - stats.sent - stats.failed);
            await COL().doc(id).update({
                status: stats.sent > 0 ? 'partial' : 'failed', updatedAt: now(), progress: null,
                result: {
                    total: aud.recipients.length, sent: stats.sent, failed: stats.failed + notTried,
                    errors: [{ error: `Stopped: ${e?.message || String(e)}${notTried ? ` (${notTried} not attempted)` : ''}. "Who received it" lists exactly who got it.` }],
                },
            }).catch(() => undefined);
        }).finally(() => releaseLock(id).catch(() => undefined));

        return { ...c, ...started } as Campaign;
    }

    /** Refresh a broadcast's status from Resend (1 Resend call, 1 write). */
    static async refreshBroadcast(id: string): Promise<Campaign> {
        const c = await this.get(id);
        const bid = c.result?.broadcastId;
        if (!bid) return c;
        const b = await R.getBroadcast(bid);
        if (b && b.status !== c.result?.broadcastStatus) {
            await COL().doc(id).update({ 'result.broadcastStatus': b.status, updatedAt: now() });
            return { ...c, result: { ...c.result!, broadcastStatus: b.status } };
        }
        return c;
    }

    static async deliveries(id: string): Promise<Array<{ n: number; sent: Array<{ to: string; id: string }>; failed: Array<{ to: string; error: string }> }>> {
        const snap = await COL().doc(id).collection('deliveries').orderBy('n').get();
        return snap.docs.map((d) => d.data() as any);
    }
}

// ── jobs ────────────────────────────────────────────────────────────────

async function progress(id: string, phase: string, done: number, total: number) {
    await COL().doc(id).update({ progress: { phase, done, total }, updatedAt: now() }).catch(() => undefined);
}

async function runDirect(c: Campaign, recipients: Recipient[], stats: { sent: number; failed: number }): Promise<void> {
    const base = getBaseUrl(), web = getWebUrl();
    const runKey = crypto.randomBytes(4).toString('hex');
    let sent = 0, failed = 0;
    const errors: Array<{ to?: string; error: string }> = [];
    const size = EMAIL_LIMITS.batchSize;
    for (let i = 0, n = 0; i < recipients.length; i += size, n++) {
        const chunk = recipients.slice(i, i + size);
        const emails = chunk.map((r) => {
            const unsub = c.doc.category === 'marketing' ? unsubscribeUrl(base, r.email) : undefined;
            const out = renderEmail(c.doc, {
                mode: 'direct', baseUrl: base, webUrl: web,
                recipient: { firstName: r.firstName, email: r.email, stations: r.stations },
                unsubscribeUrl: unsub, subjectPrefix: isStaging() ? '[Staging] ' : '',
            });
            return {
                to: r.email, from: out.from, subject: out.subject, html: out.html, text: out.text, replyTo: c.doc.replyTo,
                tags: [{ name: 'campaign', value: c.id.replace(/[^\w-]/g, '').slice(0, 60) }],
                headers: unsub ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
            };
        });
        const res = await R.sendBatch(emails, `${c.id}-${runKey}-${n}`);
        sent += res.sent.length; failed += res.failed.length;
        stats.sent = sent; stats.failed = failed;
        res.failed.slice(0, 20 - errors.length).forEach((f) => errors.push(f));
        EmailUsage.record(res.sent.length);
        await COL().doc(c.id).collection('deliveries').doc(String(n).padStart(4, '0')).set({ n, at: now(), mode: 'direct', sent: res.sent, failed: res.failed });
        await progress(c.id, 'Sending', Math.min(i + size, recipients.length), recipients.length);
    }
    await COL().doc(c.id).update({
        status: failed === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial',
        sentAt: now(), updatedAt: now(), progress: null,
        result: { total: recipients.length, sent, failed, errors },
    });
}

async function runBroadcast(c: Campaign, recipients: Recipient[]): Promise<void> {
    const seg = await R.ensureManagedSegment();
    await STATE().set({ segmentId: seg.id }, { merge: true });
    const sync = await R.syncSegment(seg.id, recipients.map((r) => ({ email: r.email, firstName: r.firstName })), (p) => {
        // Write progress at most every 10 contacts (cheap, still live enough).
        if (p.done % 10 === 0 || p.done === p.total) void progress(c.id, p.phase, p.done, p.total);
    });
    if (sync.unsubscribed.length) await EmailOptOuts.addMany(sync.unsubscribed, 'resend');

    await progress(c.id, 'Creating the broadcast', recipients.length, recipients.length);
    const out = renderEmail(c.doc, { mode: 'broadcast', baseUrl: getBaseUrl(), webUrl: getWebUrl(), subjectPrefix: isStaging() ? '[Staging] ' : '' });
    const broadcastId = await R.createAndSendBroadcast({
        segmentId: seg.id, name: broadcastName(c.name, c.id), from: fromHeader(c.doc),
        subject: out.subject, html: out.html, text: out.text, previewText: out.preheader || undefined, replyTo: c.doc.replyTo,
    });
    await STATE().set({ lastBroadcastId: broadcastId, lastBroadcastAt: now() }, { merge: true });
    const reachable = recipients.filter((r) => !sync.unsubscribed.includes(r.email)).length;
    await COL().doc(c.id).collection('deliveries').doc('0000').set({
        n: 0, at: now(), mode: 'broadcast', broadcastId,
        sent: recipients.map((r) => ({ to: r.email, id: broadcastId })), failed: [],
    });
    await COL().doc(c.id).update({
        status: 'sent', sentAt: now(), updatedAt: now(), progress: null,
        result: {
            total: recipients.length, sent: reachable, failed: 0, broadcastId, broadcastStatus: 'queued',
            segmentSync: { added: sync.added, removed: sync.removed, created: sync.created },
            errors: reachable < recipients.length ? [{ error: `${recipients.length - reachable} unsubscribed in Resend and will be skipped.` }] : [],
        },
    });
}

// ── lock ────────────────────────────────────────────────────────────────

async function startSend(campaignId: string, mode: SendMode, started: Partial<Campaign>): Promise<void> {
    if (mode === 'broadcast') {
        const st = await STATE().get();
        const last = st.exists ? st.get('lastBroadcastId') : null;
        if (last) {
            const b = await R.getBroadcast(last);
            if (b && b.status === 'queued') {
                throw err(409, 'The previous broadcast is still queued in Resend. Wait until it has gone out (it shares the segment).');
            }
        }
    }
    await db.runTransaction(async (tx) => {
        const ref = COL().doc(campaignId);
        const [st, cur] = await Promise.all([tx.get(STATE()), tx.get(ref)]);
        if (!cur.exists) throw err(404, 'No such email.');
        if (cur.get('status') !== 'draft') throw err(409, 'This email is already sending or sent.');
        const lock = st.exists ? st.get('lock') : null;
        if (lock && lock.campaignId !== campaignId && now() - (lock.at || 0) < LOCK_TTL) {
            throw err(409, 'Another email is sending right now. Try again when it has finished.');
        }
        tx.set(STATE(), { lock: { campaignId, at: now() } }, { merge: true });
        tx.update(ref, started);
    });
}

/** A send whose worker died: say so, keep what was delivered, free the lock. */
async function markInterrupted(c: Campaign): Promise<Campaign> {
    const deliveries = await COL().doc(c.id).collection('deliveries').get().catch(() => null);
    let sent = 0, failed = 0;
    deliveries?.docs.forEach((d) => { sent += (d.get('sent') || []).length; failed += (d.get('failed') || []).length; });
    const total = c.progress?.total ?? sent + failed;
    const patch: Partial<Campaign> = {
        status: sent > 0 ? 'partial' : 'failed', progress: null, updatedAt: now(),
        result: {
            total, sent, failed: total - sent,
            errors: [{ error: `Stopped: the server restarted while sending. ${sent} of ${total} went out ("Who received it" has the list). Duplicate the email and exclude those addresses to send the rest.` }],
        },
    };
    await COL().doc(c.id).update(patch).catch(() => undefined);
    await releaseLock(c.id).catch(() => undefined);
    return { ...c, ...patch } as Campaign;
}

async function releaseLock(campaignId: string): Promise<void> {
    await db.runTransaction(async (tx) => {
        const st = await tx.get(STATE());
        if (st.exists && st.get('lock')?.campaignId === campaignId) tx.set(STATE(), { lock: null }, { merge: true });
    });
}

export async function emailState(): Promise<{ segmentId?: string; lastBroadcastId?: string; lock?: { campaignId: string; at: number } | null }> {
    const st = await STATE().get();
    return st.exists ? (st.data() as any) : {};
}
