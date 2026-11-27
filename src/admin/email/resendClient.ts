/**
 * Everything this feature asks of Resend, behind one throttle.
 *
 * Free plan, so the rules are:
 *   - 10 requests/second for the whole team → every call goes through `call()`,
 *     which spaces them (8/s, leaving room for the app's own emails) and backs
 *     off on 429.
 *   - Transactional: 100/day, 3,000/month. `sendBatch` sends ≤100 emails per
 *     request (one request against the rate limit, each email against quota).
 *   - Marketing: unlimited broadcasts to ≤1,000 contacts, ≤3 segments. We use
 *     ONE segment, "Stationly managed broadcast", and set its members to the
 *     audience before each broadcast (segments have fixed membership).
 */
import { Resend } from 'resend';
import { EMAIL_LIMITS } from './emailStores';

let client: Resend | null = null;
function resend(): Resend {
    if (!process.env.RESEND_API_KEY) throw Object.assign(new Error('RESEND_API_KEY is not set on this server.'), { status: 503 });
    if (!client) client = new Resend(process.env.RESEND_API_KEY);
    return client;
}

export const MANAGED_SEGMENT_NAME = 'Stationly managed broadcast';

// ── throttle ─────────────────────────────────────────────────────────────

const GAP_MS = Math.ceil(1000 / Math.max(1, EMAIL_LIMITS.requestsPerSecond - 2));
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one Resend SDK call in its rate-limit slot; retry 429s and 5xx. */
async function call<T extends { data: any; error: any }>(label: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const now = Date.now();
        const wait = Math.max(0, nextSlot - now);
        nextSlot = Math.max(now, nextSlot) + GAP_MS;
        if (wait) await sleep(wait);
        const res = await fn();
        const err: any = res.error;
        const status = Number(err?.statusCode || 0);
        const retryable = err && (status === 429 || status >= 500 || /rate limit/i.test(err?.message || '') || err?.name === 'rate_limit_exceeded');
        if (!retryable || attempt >= 4) return res;
        const backoff = 1000 * 2 ** attempt;
        console.warn(`[Resend] ${label}: ${err?.message || status}; retrying in ${backoff} ms`);
        await sleep(backoff);
    }
}

function fail(label: string, err: any): never {
    throw Object.assign(new Error(`Resend ${label}: ${err?.message || err?.name || 'request failed'}`), { status: 502, resend: err });
}

// ── transactional ────────────────────────────────────────────────────────

export interface OutgoingEmail {
    to: string;
    subject: string;
    html: string;
    text: string;
    from: string;
    replyTo?: string;
    headers?: Record<string, string>;
    tags?: Array<{ name: string; value: string }>;
}

export interface BatchResult {
    sent: Array<{ to: string; id: string }>;
    failed: Array<{ to: string; error: string }>;
}

/** ≤100 emails in one request. Bad addresses fail alone (permissive mode). */
export async function sendBatch(emails: OutgoingEmail[], idempotencyKey?: string): Promise<BatchResult> {
    if (emails.length === 0) return { sent: [], failed: [] };
    if (emails.length > EMAIL_LIMITS.batchSize) throw new Error(`A batch holds at most ${EMAIL_LIMITS.batchSize} emails.`);
    const payload = emails.map((e) => ({
        from: e.from, to: [e.to], subject: e.subject, html: e.html, text: e.text,
        replyTo: e.replyTo, headers: e.headers, tags: e.tags,
    }));
    const res = await call('batch.send', () => resend().batch.send(payload as any, { batchValidation: 'permissive', ...(idempotencyKey ? { idempotencyKey } : {}) } as any));
    if (res.error) {
        return { sent: [], failed: emails.map((e) => ({ to: e.to, error: res.error?.message || 'batch failed' })) };
    }
    const data: any = res.data || {};
    const ids: Array<{ id: string }> = data.data || [];
    const errors: Array<{ index: number; message: string }> = data.errors || [];
    const failedIdx = new Map(errors.map((x) => [x.index, x.message]));
    const out: BatchResult = { sent: [], failed: [] };
    // Resend returns ids for the emails it accepted, in order, skipping failures.
    let k = 0;
    emails.forEach((e, i) => {
        if (failedIdx.has(i)) out.failed.push({ to: e.to, error: failedIdx.get(i) || 'rejected' });
        else out.sent.push({ to: e.to, id: ids[k++]?.id || '' });
    });
    return out;
}

// ── marketing: contacts, segment, broadcast ──────────────────────────────

export interface ResendContact { id: string; email: string; firstName: string; unsubscribed: boolean }

async function listAll(opts: { segmentId?: string }): Promise<ResendContact[]> {
    const out: ResendContact[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
        const res = await call('contacts.list', () => resend().contacts.list({ limit: 100, ...(after ? { after } : {}), ...(opts.segmentId ? { segmentId: opts.segmentId } : {}) } as any));
        if (res.error) fail('contacts.list', res.error);
        const data: any = res.data;
        const rows: any[] = data?.data || [];
        for (const c of rows) out.push({ id: c.id, email: String(c.email || '').toLowerCase(), firstName: c.first_name || '', unsubscribed: !!c.unsubscribed });
        if (!data?.has_more || rows.length === 0) break;
        after = rows[rows.length - 1].id;
    }
    return out;
}

export const listContacts = () => listAll({});

/** The managed segment's id: env override, else found by name, else created. */
export async function ensureManagedSegment(): Promise<{ id: string; created: boolean; total: number }> {
    const fixed = process.env.RESEND_BROADCAST_SEGMENT_ID;
    const res = await call('segments.list', () => resend().segments.list({ limit: 100 } as any));
    if (res.error) fail('segments.list', res.error);
    const all: any[] = (res.data as any)?.data || [];
    if (fixed) return { id: fixed, created: false, total: all.length };
    const found = all.find((s) => s.name === MANAGED_SEGMENT_NAME);
    if (found) return { id: found.id, created: false, total: all.length };
    if (all.length >= EMAIL_LIMITS.segments) {
        throw Object.assign(new Error(`Resend already has ${all.length} segments (the free plan allows ${EMAIL_LIMITS.segments}). Delete one, or set RESEND_BROADCAST_SEGMENT_ID to an existing segment this tool may manage.`), { status: 409 });
    }
    const c = await call('segments.create', () => resend().segments.create({ name: MANAGED_SEGMENT_NAME }));
    if (c.error) fail('segments.create', c.error);
    return { id: (c.data as any).id, created: true, total: all.length + 1 };
}

export interface SyncProgress { phase: string; done: number; total: number }

/**
 * Make the segment's members exactly `targets`. Creates missing contacts
 * (with first names), adds them, removes everyone else from the SEGMENT
 * (contacts themselves are kept, so their unsubscribe state survives).
 * Returns Resend-side unsubscribes found along the way.
 */
export async function syncSegment(
    segmentId: string,
    targets: Array<{ email: string; firstName: string }>,
    onProgress: (p: SyncProgress) => void,
): Promise<{ added: number; removed: number; created: number; unsubscribed: string[]; contactsTotal: number }> {
    onProgress({ phase: 'Reading Resend contacts', done: 0, total: targets.length });
    const [contacts, members] = await Promise.all([listAll({}), listAll({ segmentId })]);
    const byEmail = new Map(contacts.map((c) => [c.email, c]));
    const inSegment = new Set(members.map((m) => m.email));
    const want = new Map(targets.map((t) => [t.email.toLowerCase(), t]));

    const newContacts = [...want.keys()].filter((e) => !byEmail.has(e)).length;
    if (contacts.length + newContacts > EMAIL_LIMITS.marketingContacts) {
        throw Object.assign(new Error(`This needs ${contacts.length + newContacts} Resend contacts; the free plan allows ${EMAIL_LIMITS.marketingContacts}. Narrow the audience or remove old contacts in Resend.`), { status: 409 });
    }

    let created = 0, added = 0, removed = 0, done = 0;
    const total = want.size + [...inSegment].filter((e) => !want.has(e)).length;
    for (const [email, t] of want) {
        const existing = byEmail.get(email);
        if (!existing) {
            const r = await call('contacts.create', () => resend().contacts.create({ email, firstName: t.firstName || undefined, unsubscribed: false, segments: [{ id: segmentId }] } as any));
            if (r.error && !/exist/i.test(r.error.message || '')) fail(`contacts.create ${email}`, r.error);
            if (!r.error) { created++; added++; }
            else {
                const a = await call('contacts.segments.add', () => resend().contacts.segments.add({ email, segmentId }));
                if (a.error) fail(`segments.add ${email}`, a.error);
                added++;
            }
        } else {
            if (t.firstName && t.firstName !== existing.firstName) {
                await call('contacts.update', () => resend().contacts.update({ email, firstName: t.firstName } as any));
            }
            if (!inSegment.has(email)) {
                const a = await call('contacts.segments.add', () => resend().contacts.segments.add({ email, segmentId }));
                if (a.error) fail(`segments.add ${email}`, a.error);
                added++;
            }
        }
        onProgress({ phase: 'Syncing contacts', done: ++done, total });
    }
    for (const email of inSegment) {
        if (want.has(email)) continue;
        const r = await call('contacts.segments.remove', () => resend().contacts.segments.remove({ email, segmentId }));
        if (r.error) fail(`segments.remove ${email}`, r.error);
        removed++;
        onProgress({ phase: 'Removing old members', done: ++done, total });
    }
    return {
        added, removed, created,
        unsubscribed: contacts.filter((c) => c.unsubscribed).map((c) => c.email),
        contactsTotal: contacts.length + created,
    };
}

export async function createAndSendBroadcast(o: {
    segmentId: string; name: string; from: string; subject: string; html: string; text: string; previewText?: string; replyTo?: string; scheduledAt?: string;
}): Promise<string> {
    const res = await call('broadcasts.create', () => resend().broadcasts.create({
        segmentId: o.segmentId, name: o.name, from: o.from, subject: o.subject, html: o.html, text: o.text,
        ...(o.previewText ? { previewText: o.previewText } : {}),
        ...(o.replyTo ? { replyTo: o.replyTo } : {}),
        send: true,
        ...(o.scheduledAt ? { scheduledAt: o.scheduledAt } : {}),
    } as any));
    if (res.error) fail('broadcasts.create', res.error);
    return (res.data as any).id;
}

export async function getBroadcast(id: string): Promise<{ status: string; sentAt: string | null; scheduledAt: string | null } | null> {
    const res = await call('broadcasts.get', () => resend().broadcasts.get(id));
    if (res.error) return null;
    const d: any = res.data;
    return { status: d.status, sentAt: d.sent_at, scheduledAt: d.scheduled_at };
}

/** Mark a contact unsubscribed in Resend too (best effort). */
export async function markUnsubscribed(email: string): Promise<void> {
    if (!process.env.RESEND_API_KEY) return;
    try {
        await call('contacts.update', () => resend().contacts.update({ email, unsubscribed: true } as any));
    } catch { /* the local opt-out is what our own sends obey */ }
}

export function resendConfigured(): boolean { return !!process.env.RESEND_API_KEY; }
