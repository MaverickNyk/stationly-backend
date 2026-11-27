/**
 * The two PUBLIC email endpoints (no API key: they're opened from inboxes).
 * Mounted in server.ts before the /api/v1 router, like the Stripe webhook.
 *
 *   GET  /api/v1/email-assets/<id>.<ext>   images uploaded for emails
 *   GET  /api/v1/email/unsubscribe?e&t     confirmation page
 *   POST /api/v1/email/unsubscribe?e&t     the click, and RFC 8058 one-click
 *                                           (List-Unsubscribe-Post) from Gmail/Apple
 *
 * Unsubscribing only stops NEWS (marketing) emails; service emails about the
 * account or a feature in use still go out, and the pages say so.
 */
import express, { Request, Response, Router } from 'express';
import { RateLimitMiddleware } from '../../middleware/rateLimitMiddleware';
import { EmailAssets } from './emailAssets';
import { EmailOptOuts, verifyUnsubscribe } from './emailStores';
import { markUnsubscribed } from './resendClient';
import { getWebUrl } from '../../utils/formatters';

export const emailPublicRouter = Router();

emailPublicRouter.get('/email-assets/:file', RateLimitMiddleware.emailAssets, async (req: Request, res: Response) => {
    try {
        const hit = await EmailAssets.read(String(req.params.file || ''));
        if (!hit) { res.status(404).end(); return; }
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('Content-Type', hit.mime);
        res.set('X-Content-Type-Options', 'nosniff');
        res.end(hit.buf);
    } catch (e) {
        console.error('[EmailAssets] read failed', e);
        res.status(500).end();
    }
});

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const mask = (e: string) => e.replace(/^(.)(.*)(@.*)$/, (_m, a, b, c) => a + '•'.repeat(Math.min(6, Math.max(1, b.length))) + c);

function page(title: string, body: string): string {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#222}
.card{max-width:460px;margin:48px auto;background:#fff;border:1px solid #e5e5e5;border-radius:20px;overflow:hidden}
.bar{height:4px;background:#DD2C33}.in{padding:32px 30px}h1{font-size:22px;margin:0 0 12px}p{color:#555;line-height:1.6;font-size:15px;margin:0 0 14px}
button{background:#DD2C33;color:#fff;border:0;border-radius:12px;padding:14px 22px;font-size:15px;font-weight:700;cursor:pointer;width:100%}
a{color:#DD2C33}.small{font-size:13px;color:#888}</style></head>
<body><div class="card"><div class="bar"></div><div class="in">${body}</div></div></body></html>`;
}

emailPublicRouter.get('/email/unsubscribe', RateLimitMiddleware.emailUnsubscribe, (req: Request, res: Response) => {
    const email = verifyUnsubscribe(String(req.query.e || ''), String(req.query.t || ''));
    res.set('Cache-Control', 'no-store');
    if (!email) {
        res.status(400).send(page('Link not valid', `<h1>This link isn't valid</h1><p>It may have been cut off by your email app. Reply to any Stationly email and we'll take you off the list.</p>`));
        return;
    }
    const q = `e=${encodeURIComponent(String(req.query.e))}&t=${encodeURIComponent(String(req.query.t))}`;
    res.send(page('Unsubscribe', `<h1>Stop Stationly news emails?</h1>
<p>We'll stop sending news and announcements to <strong>${esc(mask(email))}</strong>.</p>
<form method="post" action="?${q}"><button type="submit">Unsubscribe</button></form>
<p class="small" style="margin-top:16px">You'll still get emails you need for your account, like password resets, and notices about a feature you use.</p>`));
});

emailPublicRouter.post('/email/unsubscribe', RateLimitMiddleware.emailUnsubscribe, express.urlencoded({ extended: false, limit: '2kb' }), async (req: Request, res: Response) => {
    const email = verifyUnsubscribe(String(req.query.e || ''), String(req.query.t || ''));
    res.set('Cache-Control', 'no-store');
    if (!email) { res.status(400).send(page('Link not valid', `<h1>This link isn't valid</h1><p>Reply to any Stationly email and we'll take you off the list.</p>`)); return; }
    const oneClick = String((req.body || {})['List-Unsubscribe'] || '') === 'One-Click';
    try {
        await EmailOptOuts.add(email, oneClick ? 'one_click' : 'link');
        void markUnsubscribed(email);
    } catch (e) {
        console.error('[EmailUnsubscribe] failed', e);
        res.status(500).send(page('Try again', `<h1>Something went wrong</h1><p>Please try the link again in a minute.</p>`));
        return;
    }
    if (oneClick) { res.status(200).json({ ok: true }); return; }
    res.send(page('Unsubscribed', `<h1>You're unsubscribed</h1><p>No more Stationly news emails to <strong>${esc(mask(email))}</strong>.</p><p class="small">Changed your mind? Email <a href="mailto:info@stationly.co.uk">info@stationly.co.uk</a>. <a href="${esc(getWebUrl())}">stationly.co.uk</a></p>`));
});
