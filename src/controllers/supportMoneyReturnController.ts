import { Request, Response } from 'express';
import { getUrlScheme, getWebUrl, getBaseUrl } from '../utils/formatters';

/**
 * `GET /api/v1/support-money/return`
 *
 * Where Stripe sends the browser after a contribution checkout. Stripe's
 * "redirect after payment" only accepts an `https://` URL, so it cannot point
 * straight at `stationly-staging://` — this page is the bounce: it renders a
 * branded holding screen and immediately tries the app's deep link
 * (`<scheme>://support-money/thanks?...`), falling back to a "Back to Stationly"
 * button and the website after ~1.5s for anyone without the app.
 *
 * Same two-step pattern as the existing `/verified` and `/open` pages. Mounted
 * in `server.ts` before `apiRoutes` so it is not behind `X-Stationly-Key` (a
 * browser arriving from Stripe carries no key). Under `/api/v1/*` so nginx
 * proxies it — there is no catch-all `location /`.
 *
 * ## Untrusted input
 * `session_id`, `tier`, `amount` are Stripe-templated query params but reach us
 * through the user's browser, so every one is JSON-encoded and `<`-escaped
 * before it touches the page — the same hardening the reset-password page uses.
 * They are passed straight through to the deep link and are not trusted by the
 * app either; the authoritative record is the webhook write.
 */
export class SupportMoneyReturnController {
    static render(req: Request, res: Response): void {
        const scheme = getUrlScheme();
        const webUrl = getWebUrl();
        const baseUrl = getBaseUrl();

        const pick = (v: unknown): string => (typeof v === 'string' && v.length <= 200 ? v : '');
        const params = new URLSearchParams();
        const sid = pick(req.query.session_id);
        const tier = pick(req.query.tier);
        const amount = pick(req.query.amount);
        if (sid) params.set('session_id', sid);
        if (tier) params.set('tier', tier);
        if (amount) params.set('amount', amount);
        const qs = params.toString();

        const deepLink = `${scheme}://support-money/thanks${qs ? `?${qs}` : ''}`;
        const enc = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c');

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thank you — Stationly</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;padding:0;min-height:100vh;background:#000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{max-width:460px;width:100%;text-align:center;padding:40px 32px;}
  .logo{width:48px;height:48px;margin:0 auto 20px;display:block;}
  .label{color:#8a8a8a;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 12px;}
  h1{color:#fff;font-size:30px;font-weight:800;letter-spacing:-1px;line-height:1.15;margin:0 0 14px;}
  h1 span{color:#FFB81C;}
  p{color:#9a9a9a;font-size:15px;line-height:1.65;margin:0 0 26px;}
  .spinner{display:inline-block;width:40px;height:40px;border:3px solid rgba(255,184,28,0.25);border-top-color:#FFB81C;border-radius:50%;animation:spin .9s linear infinite;margin:0 auto 22px;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .btn{background:#FFB81C;color:#000;padding:15px 30px;border-radius:14px;text-decoration:none;font-weight:800;font-size:15px;display:inline-block;letter-spacing:.2px;}
  .secondary{display:block;margin-top:16px;color:#7a7a7a;font-size:13px;text-decoration:none;}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <img class="logo" src="${baseUrl}/assets/stationly_logo_final.png" alt="Stationly">
    <div id="loading">
      <div class="spinner"></div>
      <p class="label">Thank you</p>
      <h1>Opening <span>Stationly…</span></h1>
      <p>Your contribution went through. Sending you back to the app.</p>
    </div>
    <div id="fallback" style="display:none;">
      <p class="label">Thank you</p>
      <h1>You're a <span>supporter.</span></h1>
      <p>The board's yours. Tap below to jump back into Stationly.</p>
      <a class="btn" href="${deepLink.replace(/"/g, '&quot;')}">Back to Stationly &#8594;</a>
      <a class="secondary" href="${webUrl}">Open stationly.co.uk instead</a>
    </div>
  </div>
</div>
<script>
(function(){
  var deep = ${enc(deepLink)};
  var tried = false;
  function go(){
    if (tried) return; tried = true;
    try { window.location = deep; } catch(_) {}
    setTimeout(function(){
      document.getElementById('loading').style.display = 'none';
      document.getElementById('fallback').style.display = 'block';
    }, 1500);
  }
  go();
})();
</script>
</body></html>`);
    }
}
