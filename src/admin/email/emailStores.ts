/**
 * Small Firestore-backed stores for email sending, each built for few reads:
 *
 *   EmailUsage    `email_usage/d_<YYYY-MM-DD>` and `m_<YYYY-MM>` counters
 *                 (UTC, like Resend's quota). Written with increment() on every
 *                 send from this server (no read); read as 2 docs, cached 30s.
 *   EmailOptOuts  `email_optouts/<sha256(email)>`. Read as one small
 *                 collection, cached 5 min; every write updates the cache.
 *   unsubscribe tokens: HMAC over the address, so links can't be forged or
 *                 used to unsubscribe somebody else.
 */
import * as crypto from 'crypto';
import * as admin from 'firebase-admin';
import { db } from '../../config/firebase';

const int = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const EMAIL_LIMITS = {
    /**
     * What this tool plans with, deliberately BELOW Resend's free plan
     * (100/day, 3,000/month). The app's own emails from this environment are
     * counted, but the other environment (staging and production share one
     * Resend account) and the Resend dashboard are not, so the gap is the
     * room left for sign-ups and password resets.
     */
    dailyTransactional: int(process.env.RESEND_DAILY_LIMIT, 70),
    monthlyTransactional: int(process.env.RESEND_MONTHLY_LIMIT, 2500),
    /** Resend free plan, marketing: contacts, not sends. */
    marketingContacts: int(process.env.RESEND_CONTACTS_LIMIT, 1000),
    segments: int(process.env.RESEND_SEGMENTS_LIMIT, 3),
    requestsPerSecond: int(process.env.RESEND_RATE_LIMIT, 10),
    batchSize: 100,
};

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

export interface UsageSnapshot {
    day: string;
    month: string;
    usedToday: number;
    usedThisMonth: number;
    dailyLimit: number;
    monthlyLimit: number;
    remainingToday: number;
    remainingThisMonth: number;
    /** Next midnight UTC, epoch ms. */
    resetsAt: number;
    note: string;
}

export class EmailUsage {
    private static cache: { at: number; snap: UsageSnapshot } | null = null;

    /** Count `n` transactional emails sent now. Fire-and-forget; never throws. */
    static record(n: number): void {
        if (!(n > 0)) return;
        const inc = admin.firestore.FieldValue.increment(n);
        const at = admin.firestore.FieldValue.serverTimestamp();
        const col = db.collection('email_usage');
        Promise.all([
            col.doc(`d_${dayKey()}`).set({ count: inc, updatedAt: at }, { merge: true }),
            col.doc(`m_${monthKey()}`).set({ count: inc, updatedAt: at }, { merge: true }),
        ]).catch((e) => console.warn('[EmailUsage] counter write failed', e?.message || e));
        if (this.cache) {
            this.cache.snap.usedToday += n;
            this.cache.snap.usedThisMonth += n;
            this.cache.snap.remainingToday = Math.max(0, this.cache.snap.dailyLimit - this.cache.snap.usedToday);
            this.cache.snap.remainingThisMonth = Math.max(0, this.cache.snap.monthlyLimit - this.cache.snap.usedThisMonth);
        }
    }

    /** 2 doc reads at most every 30 s. */
    static async snapshot(force = false): Promise<UsageSnapshot> {
        const day = dayKey();
        if (!force && this.cache && this.cache.snap.day === day && Date.now() - this.cache.at < 30_000) return this.cache.snap;
        const month = monthKey();
        const [d, m] = await db.getAll(db.collection('email_usage').doc(`d_${day}`), db.collection('email_usage').doc(`m_${month}`));
        const usedToday = Number(d.exists ? d.get('count') : 0) || 0;
        const usedThisMonth = Number(m.exists ? m.get('count') : 0) || 0;
        const next = new Date(); next.setUTCHours(24, 0, 0, 0);
        const snap: UsageSnapshot = {
            day, month, usedToday, usedThisMonth,
            dailyLimit: EMAIL_LIMITS.dailyTransactional,
            monthlyLimit: EMAIL_LIMITS.monthlyTransactional,
            remainingToday: Math.max(0, EMAIL_LIMITS.dailyTransactional - usedToday),
            remainingThisMonth: Math.max(0, EMAIL_LIMITS.monthlyTransactional - usedThisMonth),
            resetsAt: next.getTime(),
            note: 'Budget kept below Resend’s 100/day and 3,000/month so sign-up and password emails always have room. Counts this environment’s emails (including the app’s own); the other environment and the Resend dashboard aren’t counted, so check Resend → Usage when close.',
        };
        this.cache = { at: Date.now(), snap };
        return snap;
    }
}

// ── opt-outs ─────────────────────────────────────────────────────────────

const hashEmail = (email: string) => crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 40);

export class EmailOptOuts {
    private static cache: { at: number; set: Set<string> } | null = null;

    static async all(): Promise<Set<string>> {
        if (this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.set;
        const snap = await db.collection('email_optouts').get();
        const set = new Set<string>(snap.docs.map((d) => String(d.get('email') || '').toLowerCase()).filter(Boolean));
        this.cache = { at: Date.now(), set };
        return set;
    }

    static async add(email: string, source: 'link' | 'one_click' | 'resend' | 'admin'): Promise<void> {
        const e = email.trim().toLowerCase();
        if (!e) return;
        await db.collection('email_optouts').doc(hashEmail(e)).set(
            { email: e, source, at: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true },
        );
        if (this.cache) this.cache.set.add(e);
    }

    /** Add many (e.g. imported from Resend). Skips ones already known. */
    static async addMany(emails: string[], source: 'resend'): Promise<number> {
        const known = await this.all();
        const fresh = [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter((e) => e && !known.has(e));
        for (let i = 0; i < fresh.length; i += 400) {
            const batch = db.batch();
            for (const e of fresh.slice(i, i + 400)) {
                batch.set(db.collection('email_optouts').doc(hashEmail(e)), { email: e, source, at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            }
            await batch.commit();
        }
        fresh.forEach((e) => known.add(e));
        return fresh.length;
    }

    static async remove(email: string): Promise<void> {
        const e = email.trim().toLowerCase();
        await db.collection('email_optouts').doc(hashEmail(e)).delete();
        this.cache?.set.delete(e);
    }
}

// ── unsubscribe links ────────────────────────────────────────────────────

function linkSecret(): string {
    const explicit = process.env.EMAIL_LINK_SECRET;
    if (explicit && explicit.length >= 16) return explicit;
    // Derived from the admin key so no new secret is REQUIRED. Rotating the
    // admin key invalidates old unsubscribe links; set EMAIL_LINK_SECRET to
    // decouple them.
    const adminKey = process.env.STATIONLY_ADMIN_KEY || '';
    if (adminKey.length < 16) throw new Error('No EMAIL_LINK_SECRET or STATIONLY_ADMIN_KEY to sign unsubscribe links.');
    return crypto.createHmac('sha256', adminKey).update('email-unsubscribe-v1').digest('hex');
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

export function unsubscribeToken(email: string): string {
    return crypto.createHmac('sha256', linkSecret()).update(email.trim().toLowerCase()).digest('base64url').slice(0, 32);
}

export function unsubscribeUrl(baseUrl: string, email: string): string {
    const e = email.trim().toLowerCase();
    return `${baseUrl}/api/v1/email/unsubscribe?e=${b64u(e)}&t=${unsubscribeToken(e)}`;
}

/** The address a link was made for, or null if the link was altered. */
export function verifyUnsubscribe(eParam: string, token: string): string | null {
    try {
        const email = unb64u(String(eParam || '')).trim().toLowerCase();
        if (!email.includes('@')) return null;
        const expected = Buffer.from(unsubscribeToken(email));
        const given = Buffer.from(String(token || ''));
        if (expected.length !== given.length) return null;
        return crypto.timingSafeEqual(expected, given) ? email : null;
    } catch {
        return null;
    }
}
