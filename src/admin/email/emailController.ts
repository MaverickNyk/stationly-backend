/**
 * Admin email endpoints, mounted under /api/v1/admin/email (admin key).
 * No @swagger annotations, by design (see ../CLAUDE.md).
 *
 *   GET    /meta                       quota, limits, Resend state, filter options
 *   GET    /campaigns                  list (no bodies)
 *   POST   /campaigns                  create draft
 *   GET    /campaigns/:id              one draft or sent email
 *   PUT    /campaigns/:id              save draft (name, doc, audience)
 *   DELETE /campaigns/:id              delete a draft
 *   POST   /campaigns/:id/duplicate
 *   POST   /campaigns/:id/send         { mode, confirmCount }
 *   POST   /campaigns/:id/refresh      broadcast status from Resend
 *   GET    /campaigns/:id/deliveries   who got it (audit)
 *   POST   /render                     { doc, audience?, sampleEmail?, mode? } → html/text + problems
 *   POST   /audience                   { audience, doc } → recipients, exclusions, send plan
 *   POST   /test                       { doc, to[], campaignId?, audience?, sampleEmail? }
 *   GET    /assets  ·  POST /assets    { dataUrl, name }
 *   GET    /optouts                    the opt-out list (read only: nobody is re-subscribed by an admin)
 */
import { Request, Response, Router } from 'express';
import { getBaseUrl, getEnv, getWebUrl } from '../../utils/formatters';
import { AdminDataService } from '../adminDataService';
import { EmailDoc, ICONS, MERGE_FIELDS, FROM_ADDRESS, validateDoc, emptyDoc } from './emailDoc';
import { renderEmail, RenderMode } from './emailRender';
import { AudienceFilter, audienceOptions, Recipient } from './emailAudience';
import { EMAIL_LIMITS, EmailOptOuts, EmailUsage, unsubscribeUrl } from './emailStores';
import { EmailAssets } from './emailAssets';
import { EmailCampaigns, audienceFor, plan, emailState, SendMode } from './emailCampaigns';
import { resendConfigured, MANAGED_SEGMENT_NAME } from './resendClient';
import { isStaging } from '../../utils/formatters';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out);
    } catch (e: any) {
        const status = Number(e?.status) || 500;
        if (status >= 500) console.error('[AdminEmail]', e);
        res.status(status).json({ error: status >= 500 ? 'Server Error' : 'Bad Request', message: e?.message || 'Failed', ...(e?.problems ? { problems: e.problems } : {}), ...(e?.count !== undefined ? { count: e.count } : {}) });
    }
};

function docOf(body: any): EmailDoc {
    const d = body?.doc;
    if (!d || typeof d !== 'object') throw Object.assign(new Error('Missing "doc".'), { status: 400 });
    return { ...emptyDoc(), ...d, header: { ...emptyDoc().header, ...(d.header || {}) } };
}

function audienceOf(body: any): AudienceFilter {
    const a = body?.audience;
    if (!a || typeof a !== 'object') return { source: 'none', customEmails: [] };
    if (!['users', 'waitlist', 'none'].includes(a.source)) throw Object.assign(new Error('audience.source must be users, waitlist or none.'), { status: 400 });
    return a as AudienceFilter;
}

/** The person a preview or test is personalised as. */
function pickSample(recipients: Recipient[], sampleEmail?: string): Recipient | undefined {
    if (sampleEmail) {
        const hit = recipients.find((r) => r.email === String(sampleEmail).toLowerCase());
        if (hit) return hit;
    }
    return recipients[0];
}

const trimRecipient = (r: Recipient) => ({
    email: r.email, firstName: r.firstName, uid: r.uid, displayName: r.displayName, source: r.source,
    platforms: r.platforms, versions: r.versions, lastSeen: r.lastSeen, joined: r.joined, stations: r.stations,
});

export const adminEmailRouter = Router();

adminEmailRouter.get('/meta', wrap(async () => {
    await AdminDataService.getUsers();
    const users = AdminDataService.allUsers();
    const [usage, state, optouts] = await Promise.all([EmailUsage.snapshot(), emailState().catch(() => ({} as any)), EmailOptOuts.all().catch(() => new Set<string>())]);
    return {
        env: getEnv(),
        baseUrl: getBaseUrl(),
        webUrl: getWebUrl(),
        fromAddress: FROM_ADDRESS,
        usage,
        limits: EMAIL_LIMITS,
        resend: {
            configured: resendConfigured(),
            managedSegmentName: MANAGED_SEGMENT_NAME,
            segmentId: state.segmentId || process.env.RESEND_BROADCAST_SEGMENT_ID || null,
            lastBroadcastId: state.lastBroadcastId || null,
            lock: state.lock || null,
        },
        staging: isStaging() ? { allowlist: (process.env.EMAIL_STAGING_ALLOWLIST || '').split(/[\s,;]+/).filter(Boolean).length } : null,
        counts: { users: users.length, waitlist: AdminDataService.waitlistCount(), optouts: optouts.size },
        mergeFields: MERGE_FIELDS,
        icons: Object.entries(ICONS).map(([id, v]) => ({ id, label: v.label, url: getBaseUrl() + v.path + '?v=2' })),
        options: audienceOptions(users),
    };
}));

adminEmailRouter.get('/campaigns', wrap(async () => ({ items: await EmailCampaigns.list() })));
adminEmailRouter.post('/campaigns', wrap(async (req) => EmailCampaigns.create({ name: req.body?.name, doc: req.body?.doc, audience: req.body?.audience })));
adminEmailRouter.get('/campaigns/:id', wrap(async (req) => EmailCampaigns.get(req.params.id)));
adminEmailRouter.put('/campaigns/:id', wrap(async (req) => EmailCampaigns.update(req.params.id, {
    ...(req.body?.name !== undefined ? { name: req.body.name } : {}),
    ...(req.body?.doc ? { doc: docOf(req.body) } : {}),
    ...(req.body?.audience ? { audience: audienceOf(req.body) } : {}),
})));
adminEmailRouter.delete('/campaigns/:id', wrap(async (req) => { await EmailCampaigns.remove(req.params.id); return { ok: true }; }));
adminEmailRouter.post('/campaigns/:id/duplicate', wrap(async (req) => EmailCampaigns.duplicate(req.params.id)));
adminEmailRouter.post('/campaigns/:id/send', wrap(async (req, res) => {
    const mode = req.body?.mode as SendMode;
    if (mode !== 'direct' && mode !== 'broadcast') throw Object.assign(new Error('mode must be direct or broadcast.'), { status: 400 });
    const confirmCount = Number(req.body?.confirmCount);
    if (!Number.isInteger(confirmCount) || confirmCount < 1) throw Object.assign(new Error('confirmCount is required.'), { status: 400 });
    const c = await EmailCampaigns.send(req.params.id, mode, confirmCount);
    res.status(202);
    return c;
}));
adminEmailRouter.post('/campaigns/:id/refresh', wrap(async (req) => EmailCampaigns.refreshBroadcast(req.params.id)));
adminEmailRouter.get('/campaigns/:id/deliveries', wrap(async (req) => ({ items: await EmailCampaigns.deliveries(req.params.id) })));

adminEmailRouter.post('/render', wrap(async (req) => {
    const doc = docOf(req.body);
    const mode: RenderMode = req.body?.mode === 'broadcast' ? 'broadcast' : 'preview';
    let sample: Recipient | undefined;
    if (req.body?.audience) {
        const aud = await audienceFor(audienceOf(req.body), doc.category);
        sample = pickSample(aud.recipients, req.body?.sampleEmail);
    }
    const out = renderEmail(doc, {
        mode, baseUrl: getBaseUrl(), webUrl: getWebUrl(),
        recipient: sample ? { firstName: sample.firstName, email: sample.email, stations: sample.stations } : undefined,
        unsubscribeUrl: doc.category === 'marketing' && sample ? unsubscribeUrl(getBaseUrl(), sample.email) : undefined,
        subjectPrefix: isStaging() ? '[Staging] ' : '',
    });
    const bytes = Buffer.byteLength(out.html, 'utf8');
    return {
        ...out,
        sizeKb: Math.round(bytes / 102.4) / 10,
        // Gmail hides everything after ~102 KB behind "View entire message".
        warnings: bytes > 100 * 1024 ? ['This email is over 100 KB; Gmail will clip it. Remove some content.'] : [],
        problems: { direct: validateDoc(doc, { mode: 'direct' }), broadcast: validateDoc(doc, { mode: 'broadcast' }) },
        sample: sample ? trimRecipient(sample) : null,
    };
}));

adminEmailRouter.post('/audience', wrap(async (req) => {
    const doc = req.body?.doc ? docOf(req.body) : emptyDoc();
    const filter = audienceOf(req.body);
    const aud = await audienceFor(filter, doc.category);
    const usage = await EmailUsage.snapshot();
    const limit = Math.min(2000, Number(req.body?.limit) || 1000);
    return {
        count: aud.recipients.length,
        recipients: aud.recipients.slice(0, limit).map(trimRecipient),
        truncated: aud.recipients.length > limit,
        excluded: aud.excluded,
        plan: plan(aud.recipients.length, doc, usage, aud.recipients),
    };
}));

adminEmailRouter.post('/test', wrap(async (req) => {
    const doc = docOf(req.body);
    let sample: Recipient | undefined;
    if (req.body?.audience) {
        const aud = await audienceFor(audienceOf(req.body), doc.category);
        sample = pickSample(aud.recipients, req.body?.sampleEmail);
    }
    return EmailCampaigns.sendTest(doc, req.body?.to || [], { campaignId: req.body?.campaignId, sample });
}));

adminEmailRouter.get('/assets', wrap(async () => ({ items: await EmailAssets.list() })));
adminEmailRouter.post('/assets', wrap(async (req) => EmailAssets.upload(req.body?.dataUrl, req.body?.name)));

adminEmailRouter.get('/optouts', wrap(async () => ({ items: [...(await EmailOptOuts.all())].sort() })));
