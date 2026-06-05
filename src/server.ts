import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import * as dotenv from 'dotenv';
import swaggerJsdoc from 'swagger-jsdoc';
import apiRoutes from './routes/apiRoutes';
import adminRoutes from './admin/adminRoutes';
import { AuthMiddleware } from './middleware/authMiddleware';
import { DataCacheService } from './services/dataCacheService';
import { WaitlistController } from './controllers/waitlistController';
import { RateLimitMiddleware } from './middleware/rateLimitMiddleware';
import { getWebUrl, getBaseUrl } from './utils/formatters';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Trust Nginx reverse proxy so req.ip reflects the real client IP (X-Forwarded-For)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: false, // Scalar needs this for its assets
}));
app.use(morgan('dev'));
app.use(express.json());

// Serving icons from the public directory
// Dynamic line-icon route — generates a TfL-roundel PNG for any known
// line ID on first hit, caches to disk under public/icons/lines/.
// Registered BEFORE express.static so the very first request triggers
// generation; subsequent requests are served by static (the file is
// now on disk). For unknown lines (bus, made-up names) we 404 and let
// callers fall back to the mode icon.
app.get('/icons/lines/:lineId.png', async (req, res) => {
    const lineId = req.params.lineId;
    try {
        const buf = await import('./services/lineIconService')
            .then(m => m.LineIconService.resolve(lineId));
        if (!buf) {
            res.status(404).end();
            return;
        }
        res.set('Cache-Control', 'public, max-age=2592000, immutable'); // 30 days
        res.set('Content-Type', 'image/png');
        res.end(buf);
    } catch (e) {
        console.error('line-icon generate failed', e);
        res.status(500).end();
    }
});
app.use('/icons', express.static(path.join(process.cwd(), 'public', 'icons')));
app.use('/assets', express.static(path.join(process.cwd(), 'public', 'assets')));

// Smart deep link redirect — used in email CTAs
// ?deep=stationly%3A%2F%2Fauth  &web=https%3A%2F%2Fstationly.co.uk
// Tries to open the app; falls back to web URL after 1.5s if app isn't installed
app.get('/open', (req, res) => {
    const deep = typeof req.query.deep === 'string' ? decodeURIComponent(req.query.deep) : 'stationly://';
    const web  = typeof req.query.web  === 'string' ? decodeURIComponent(req.query.web)  : getWebUrl();
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Stationly…</title>
<style>
  body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,sans-serif;}
  .card{text-align:center;padding:40px 32px;}
  .logo{font-size:32px;font-weight:900;color:#FFB81C;letter-spacing:-1px;margin-bottom:12px;}
  p{color:#666;font-size:14px;margin:0 0 24px;}
  a{color:#FFB81C;font-size:13px;}
</style>
</head><body>
<div class="card">
  <div class="logo">STATIONLY</div>
  <p>Opening the app…</p>
  <a href="${web}">Open in browser instead</a>
</div>
<script>
  var tried = false;
  function tryOpen() {
    if (tried) return;
    tried = true;
    window.location = ${JSON.stringify(deep)};
    setTimeout(function() { window.location = ${JSON.stringify(web)}; }, 1500);
  }
  tryOpen();
</script>
</body></html>`);
});

// Branded email-verification landing page. Reached as the web fallback from the
// /open smart redirect when the user clicks the verify link in their email and
// the Stationly app deep-link doesn't catch (desktop, no app installed, etc).
//
// The page reads the oobCode + apiKey from query params, hits Firebase's REST
// identitytoolkit endpoint to apply the action code in-browser, and shows a
// Stationly-branded success/failure state. No domain whitelisting needed
// because Firebase's identitytoolkit accepts oobCode validation from anywhere.
app.get('/verified', (req, res) => {
    const oobCode = typeof req.query.oobCode === 'string' ? req.query.oobCode : '';
    const apiKey  = typeof req.query.apiKey  === 'string' ? req.query.apiKey  : '';
    const baseUrl = getBaseUrl();
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.stationly.mobile';

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verifying — Stationly</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;padding:0;min-height:100vh;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{max-width:520px;width:100%;background:#fff;border:1px solid #E5E5E5;border-radius:22px;overflow:hidden;}
  .topbar{height:4px;background:linear-gradient(90deg,#CC8800,#FFB81C 40%,#FFC819 60%,#CC8800);}
  .body{padding:48px 40px;text-align:center;}
  .logo{width:52px;height:52px;margin:0 auto 20px;display:block;}
  .label{color:#999;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 14px;}
  .label.ok{color:#CC8800;}
  .label.err{color:#CC0000;}
  h1{color:#111;font-size:34px;font-weight:800;letter-spacing:-1px;line-height:1.15;margin:0 0 16px;}
  h1 span{color:#CC8800;}
  p{color:#555;font-size:15px;line-height:1.7;margin:0 0 24px;}
  .spinner{display:inline-block;width:44px;height:44px;border:3px solid #FFE8A0;border-top-color:#FFB81C;border-radius:50%;animation:spin 0.9s linear infinite;margin:0 auto 24px;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .btn{background:#FFB81C;color:#000;padding:16px 32px;border-radius:14px;text-decoration:none;font-weight:800;font-size:15px;display:inline-block;letter-spacing:0.2px;margin:4px 0;}
  .btn:hover{background:#FFC819;}
  .btn.outline{background:transparent;color:#CC8800;border:1.5px solid #FFB81C;}
  .secondary{display:block;margin-top:16px;color:#999;font-size:13px;text-decoration:none;}
  .secondary:hover{color:#CC8800;}
  .footer{padding:20px 36px 28px;background:#FAFAFA;border-top:1px solid #EEEEEE;text-align:center;color:#AAAAAA;font-size:12px;line-height:1.7;}
  .footer a{color:#BBBBBB;text-decoration:none;}
  .bottombar{height:4px;background:linear-gradient(90deg,#CC8800,#FFB81C 50%,#CC8800);}
  .hidden{display:none;}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="topbar"></div>
    <div class="body">
      <img class="logo" src="${baseUrl}/assets/stationly_logo_final.png" alt="Stationly">

      <!-- Loading state -->
      <div id="loading">
        <div class="spinner"></div>
        <p class="label">Verifying your email</p>
        <h1>Just a moment…</h1>
        <p>Confirming with Stationly's servers — this only takes a second.</p>
      </div>

      <!-- Success state -->
      <div id="success" class="hidden">
        <p class="label ok">Email verified</p>
        <h1>You're all set,<br/><span>welcome to Stationly.</span></h1>
        <p>Your email's confirmed. Open the app to finish setting up your home-screen board.</p>
        <a class="btn" id="openApp" href="stationly://verified">Open the App &#8594;</a>
        <a class="secondary" href="${playStoreUrl}">Don't have the app yet? Get it on Google Play</a>
      </div>

      <!-- Error state -->
      <div id="error" class="hidden">
        <p class="label err">Couldn't verify</p>
        <h1>This link is no<br/><span>longer valid.</span></h1>
        <p id="errMsg">The link may have expired or already been used. Open Stationly and tap "Resend email" to get a fresh one.</p>
        <a class="btn outline" href="stationly://home">Open Stationly</a>
        <a class="secondary" href="${playStoreUrl}">Get Stationly on Google Play</a>
      </div>

    </div>
    <div class="footer">
      &copy; 2026 Stationly Ltd · London, UK<br/>
      <a href="https://stationly.co.uk/privacy">Privacy</a> ·
      <a href="https://stationly.co.uk/terms">Terms</a> ·
      <a href="mailto:info@stationly.co.uk">info@stationly.co.uk</a>
    </div>
    <div class="bottombar"></div>
  </div>
</div>

<script>
(function() {
  // Embedded as JSON literals; we additionally escape "<" so a malicious
  // query-param value can't break out via </script>.
  var oobCode = ${JSON.stringify(oobCode).replace(/</g, '\\u003c')};
  var apiKey  = ${JSON.stringify(apiKey).replace(/</g, '\\u003c')};

  function showSuccess() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('success').classList.remove('hidden');
    // Try the deep link automatically on mobile — many users open the link in the
    // email app's in-app browser and would otherwise miss the manual button.
    setTimeout(function() {
      try { window.location = 'stationly://verified'; } catch(_) {}
    }, 600);
  }
  function showError(msg) {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('error').classList.remove('hidden');
    if (msg) document.getElementById('errMsg').textContent = msg;
  }

  if (!oobCode || !apiKey) {
    showError('Missing verification details. Open Stationly and tap "Resend email".');
    return;
  }

  // Firebase's identitytoolkit REST endpoint that applies an action code
  // (verifyEmail / resetPassword / etc). Returns the email on success.
  fetch('https://identitytoolkit.googleapis.com/v1/accounts:update?key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oobCode: oobCode })
  })
  .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }); })
  .then(function(res) {
    if (res.ok) {
      showSuccess();
    } else {
      var err = res.body && res.body.error && res.body.error.message;
      if (err === 'EXPIRED_OOB_CODE')        showError('This link has expired. Request a fresh one from the app.');
      else if (err === 'INVALID_OOB_CODE')   showError('This link has already been used or is invalid.');
      else if (err === 'USER_DISABLED')      showError('This account has been disabled. Contact info@stationly.co.uk.');
      else                                   showError();
    }
  })
  .catch(function() { showError('Could not reach Stationly. Check your connection and try again.'); });
})();
</script>
</body></html>`);
});

// Branded password-reset landing page. Reached as the web fallback from the
// /open smart redirect when the user clicks the reset link in their email and
// the Stationly app deep-link doesn't catch (desktop, no app installed, etc).
//
// The page reads oobCode + apiKey from query params, presents a new-password
// form, and POSTs to Firebase's identitytoolkit REST endpoint in-browser to
// apply the change. Same visual language as /verified.
app.get('/reset-password', (req, res) => {
    const oobCode = typeof req.query.oobCode === 'string' ? req.query.oobCode : '';
    const apiKey  = typeof req.query.apiKey  === 'string' ? req.query.apiKey  : '';
    const baseUrl = getBaseUrl();
    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.stationly.mobile';

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset password — Stationly</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;padding:0;min-height:100vh;background:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}
  .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
  .card{max-width:520px;width:100%;background:#fff;border:1px solid #E5E5E5;border-radius:22px;overflow:hidden;}
  .topbar{height:4px;background:linear-gradient(90deg,#CC8800,#FFB81C 40%,#FFC819 60%,#CC8800);}
  .body{padding:44px 40px 32px;}
  .logo{width:52px;height:52px;margin:0 auto 18px;display:block;}
  .label{color:#999;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 12px;text-align:center;}
  .label.ok{color:#CC8800;}
  .label.err{color:#CC0000;}
  h1{color:#111;font-size:32px;font-weight:800;letter-spacing:-1px;line-height:1.15;margin:0 0 14px;text-align:center;}
  h1 span{color:#CC8800;}
  p.lead{color:#555;font-size:15px;line-height:1.6;margin:0 0 22px;text-align:center;}
  .field{display:block;margin-bottom:14px;}
  .field label{display:block;color:#666;font-size:13px;font-weight:600;margin-bottom:6px;}
  .field input{width:100%;padding:14px 16px;border:1.5px solid #E5E5E5;border-radius:12px;font-size:15px;font-family:inherit;background:#FAFAFA;}
  .field input:focus{outline:none;border-color:#FFB81C;background:#fff;}
  .field input[aria-invalid="true"]{border-color:#CC0000;background:#FFF5F5;}
  .field .err{color:#CC0000;font-size:12px;margin-top:6px;min-height:16px;}
  .btn{width:100%;background:#FFB81C;color:#000;padding:16px;border:0;border-radius:14px;font-weight:800;font-size:15px;cursor:pointer;letter-spacing:0.2px;margin-top:6px;}
  .btn:hover{background:#FFC819;}
  .btn:disabled{background:#FFE8A0;color:#888;cursor:not-allowed;}
  .spinner{display:inline-block;width:44px;height:44px;border:3px solid #FFE8A0;border-top-color:#FFB81C;border-radius:50%;animation:spin 0.9s linear infinite;margin:0 auto 16px;}
  @keyframes spin{to{transform:rotate(360deg);}}
  .center{text-align:center;}
  .secondary{display:block;text-align:center;margin-top:18px;color:#999;font-size:13px;text-decoration:none;}
  .secondary:hover{color:#CC8800;}
  .footer{padding:20px 36px 26px;background:#FAFAFA;border-top:1px solid #EEEEEE;text-align:center;color:#AAAAAA;font-size:12px;line-height:1.7;}
  .footer a{color:#BBBBBB;text-decoration:none;}
  .bottombar{height:4px;background:linear-gradient(90deg,#CC8800,#FFB81C 50%,#CC8800);}
  .hidden{display:none;}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="topbar"></div>
    <div class="body">
      <img class="logo" src="${baseUrl}/assets/stationly_logo_final.png" alt="Stationly">

      <div id="form">
        <p class="label">Reset your password</p>
        <h1>Set a new<br/><span>Stationly password.</span></h1>
        <p class="lead">Make it strong, make it memorable.</p>

        <div class="field">
          <label for="pw1">New password</label>
          <input id="pw1" type="password" autocomplete="new-password" minlength="6"
                 placeholder="At least 6 characters">
          <div class="err" id="pw1err"></div>
        </div>

        <div class="field">
          <label for="pw2">Confirm password</label>
          <input id="pw2" type="password" autocomplete="new-password" placeholder="Type it again">
          <div class="err" id="pw2err"></div>
        </div>

        <button id="submitBtn" class="btn">Reset Password</button>
      </div>

      <div id="working" class="hidden center">
        <div class="spinner"></div>
        <p class="label">Resetting</p>
        <h1>One moment…</h1>
        <p class="lead">Saving your new password with Stationly.</p>
      </div>

      <div id="done" class="hidden center">
        <p class="label ok">All set</p>
        <h1>Password<br/><span>changed.</span></h1>
        <p class="lead">Sign in with your new password to get back to your boards.</p>
        <a class="btn" style="text-decoration:none;display:inline-block;padding:16px 32px;width:auto;"
           href="stationly://auth">Open the App &#8594;</a>
        <a class="secondary" href="${playStoreUrl}">Don't have the app? Get it on Google Play</a>
      </div>

      <div id="failed" class="hidden center">
        <p class="label err">Couldn't reset</p>
        <h1>This link is no<br/><span>longer valid.</span></h1>
        <p class="lead" id="failedMsg">The link may have expired or already been used. Request a fresh one from the Stationly app.</p>
        <a class="btn" style="background:transparent;color:#CC8800;border:1.5px solid #FFB81C;text-decoration:none;display:inline-block;padding:16px 32px;width:auto;"
           href="stationly://home">Open Stationly</a>
      </div>

    </div>
    <div class="footer">
      &copy; 2026 Stationly Ltd · London, UK<br/>
      <a href="https://stationly.co.uk/privacy">Privacy</a> ·
      <a href="https://stationly.co.uk/terms">Terms</a> ·
      <a href="mailto:info@stationly.co.uk">info@stationly.co.uk</a>
    </div>
    <div class="bottombar"></div>
  </div>
</div>

<script>
(function() {
  // Embedded as JSON literals; we additionally escape "<" so a malicious
  // query-param value can't break out via </script>.
  var oobCode = ${JSON.stringify(oobCode).replace(/</g, '\\u003c')};
  var apiKey  = ${JSON.stringify(apiKey).replace(/</g, '\\u003c')};

  function show(which) {
    ['form','working','done','failed'].forEach(function(id) {
      document.getElementById(id).classList.toggle('hidden', id !== which);
    });
  }
  function showFailed(msg) {
    if (msg) document.getElementById('failedMsg').textContent = msg;
    show('failed');
  }

  if (!oobCode || !apiKey) {
    showFailed('Missing reset details. Request a fresh link from the Stationly app.');
    return;
  }

  var pw1 = document.getElementById('pw1');
  var pw2 = document.getElementById('pw2');
  var pw1err = document.getElementById('pw1err');
  var pw2err = document.getElementById('pw2err');
  var btn = document.getElementById('submitBtn');

  function validate() {
    pw1err.textContent = ''; pw2err.textContent = '';
    pw1.setAttribute('aria-invalid', 'false'); pw2.setAttribute('aria-invalid', 'false');
    var p1 = pw1.value, p2 = pw2.value;
    if (p1.length < 6) { pw1err.textContent = 'At least 6 characters'; pw1.setAttribute('aria-invalid','true'); return false; }
    if (p1 !== p2)     { pw2err.textContent = 'Passwords don\\'t match';  pw2.setAttribute('aria-invalid','true'); return false; }
    return true;
  }

  btn.addEventListener('click', function() {
    if (!validate()) return;
    show('working');

    fetch('https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oobCode: oobCode, newPassword: pw1.value })
    })
    .then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }); })
    .then(function(res) {
      if (res.ok) {
        show('done');
        // Try deep-linking the user back into the app — many will be on mobile.
        setTimeout(function() { try { window.location = 'stationly://auth'; } catch(_) {} }, 600);
      } else {
        var err = res.body && res.body.error && res.body.error.message;
        if (err === 'EXPIRED_OOB_CODE')      showFailed('This link has expired. Request a fresh one from the app.');
        else if (err === 'INVALID_OOB_CODE') showFailed('This link has already been used or is invalid.');
        else if (err === 'USER_DISABLED')    showFailed('This account has been disabled. Contact info@stationly.co.uk.');
        else if (err === 'WEAK_PASSWORD')    { show('form'); pw1err.textContent = 'Please choose a stronger password.'; pw1.setAttribute('aria-invalid','true'); }
        else                                  showFailed();
      }
    })
    .catch(function() { showFailed('Could not reach Stationly. Check your connection and try again.'); });
  });

  // Submit on Enter from the second field
  pw2.addEventListener('keydown', function(e) { if (e.key === 'Enter') btn.click(); });
})();
</script>
</body></html>`);
});

// OpenAPI Configuration
const swaggerOptions = {
    definition: {
        openapi: '3.1.0',
        info: {
            title: 'Stationly API documentation',
            version: 'v1.0.0',
            description: `
Welcome to the Stationly API Documentation. 

Stationly provides a high-performance middleware for transport data, specializing in TfL (Transport for London) integration. Our API offers real-time arrival predictions, station metadata, and live line status updates.

### Key Features
*   **Real-time Predictions**: Accurate arrival times for Tube, Overground, DLR, and more.
*   **Station Metadata**: Detailed information about stations including coordinates and available modes.
*   **Line Status**: Live updates on delays, closures, and service changes.
*   **SDUI Integration**: Server-Driven UI layouts for dynamic app screens.
            `,
            contact: {
                name: 'Stationly Limited',
                email: 'support@stationly.co.uk'
            },
            license: {
                name: 'Apache 2.0',
                url: 'http://www.apache.org/licenses/LICENSE-2.0.html'
            }
        },
        servers: [
            {
                url: `${getBaseUrl()}/api/v1`,
                description: 'Current Server'
            },
            {
                url: `http://localhost:${port}/api/v1`,
                description: 'Local Development Server'
            }
        ],
        components: {
            securitySchemes: {
                StationlyKey: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'X-Stationly-Key',
                    description: 'Your Stationly Developer API Key'
                },
                FirebaseToken: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'Firebase ID Token for user-specific data access'
                }
            },
            schemas: {
                TransportMode: {
                    type: 'object',
                    properties: {
                        modeName: { type: 'string', example: 'tube' },
                        displayName: { type: 'string', example: 'Underground' },
                        id: { type: 'string', example: 'tube' },
                        label: { type: 'string', example: 'Underground' },
                        iconUrl: { type: 'string', example: `${getBaseUrl()}/icons/tube.png` }
                    }
                },
                LineInfo: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'victoria' },
                        name: { type: 'string', example: 'Victoria' },
                        modeName: { type: 'string', example: 'tube' },
                        label: { type: 'string', example: 'Victoria' }
                    }
                },
                LineStatus: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'central' },
                        name: { type: 'string', example: 'Central' },
                        statusSeverityDescription: { type: 'string', example: 'Good Service' },
                        reason: { type: 'string', example: 'Service is operating normally.' },
                        mode: { type: 'string', example: 'tube' },
                        lastUpdatedTime: { type: 'string', format: 'date-time' }
                    }
                },
                Station: {
                    type: 'object',
                    properties: {
                        naptanId: { type: 'string', example: '940GZZLUEUS' },
                        commonName: { type: 'string', example: 'Euston Underground Station' },
                        lat: { type: 'number', example: 51.5281 },
                        lon: { type: 'number', example: -0.1331 },
                        stopType: { type: 'string', example: 'NaptanMetroStation' },
                        id: { type: 'string', example: '940GZZLUEUS' },
                        label: { type: 'string', example: 'Euston' }
                    }
                },
                SubscribedStation: {
                    type: 'object',
                    properties: {
                        naptanId: { type: 'string', example: '940GZZLUEUS' },
                        commonName: { type: 'string', example: 'Euston' },
                        lineId: { type: 'string', example: 'victoria' },
                        lineName: { type: 'string', example: 'Victoria' },
                        modeName: { type: 'string', example: 'tube' }
                    }
                },
                UserProfile: {
                    type: 'object',
                    properties: {
                        uid: { type: 'string', example: 'user123' },
                        email: { type: 'string', example: 'user@example.com' },
                        displayName: { type: 'string', example: 'John Doe' },
                        stations: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/SubscribedStation' }
                        }
                    }
                },
                UserSyncRequest: {
                    type: 'object',
                    required: ['uid', 'email'],
                    properties: {
                        uid: { type: 'string' },
                        email: { type: 'string' },
                        displayName: { type: 'string' },
                        photoURL: { type: 'string' },
                        signInProvider: { type: 'string' }
                    }
                },
                StationSyncRequest: {
                    type: 'object',
                    required: ['uid', 'stations'],
                    properties: {
                        uid: { type: 'string' },
                        stations: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/SubscribedStation' }
                        }
                    }
                },
                Layout: {
                    type: 'object',
                    properties: {
                        template: { type: 'string', example: 'selection_flow' },
                        data: { type: 'object' }
                    }
                },
                PredictionItem: {
                    type: 'object',
                    properties: {
                        destId: { type: 'string', example: '940GZZLUEDM' },
                        platform: { type: 'string', example: 'Platform 1' },
                        eta: { type: 'string', format: 'date-time' },
                        displayName: { type: 'string', example: 'Upminster' }
                    }
                },
                LinePredictions: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'district' },
                        name: { type: 'string', example: 'District' },
                        dirs: {
                            type: 'object',
                            additionalProperties: {
                                type: 'object',
                                properties: {
                                    preds: {
                                        type: 'array',
                                        items: { $ref: '#/components/schemas/PredictionItem' }
                                    }
                                }
                            }
                        }
                    }
                },
                StationPredictionResponse: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: '940GZZLUBKG' },
                        name: { type: 'string', example: 'Barking Underground Station' },
                        lut: { type: 'string', format: 'date-time' },
                        lines: {
                            type: 'object',
                            additionalProperties: { $ref: '#/components/schemas/LinePredictions' }
                        }
                    }
                }
            }
        },
        tags: [
            { name: 'Stations', description: 'Access to station metadata, location searching, and line association.' },
            { name: 'Modes', description: 'Transport meta-data for supported London transport modes.' },
            { name: 'Lines', description: 'Live line status, routes, and operational information.' },
            { name: 'Users', description: 'Synchronization of user profiles and personalized station subscriptions.' },
            { name: 'SDUI', description: 'Server-Driven UI layout definitions for dynamic mobile application screens.' },
            { name: 'Auth', description: 'Layout endpoints for authentication flows (Login, Register, Password Reset).' }
        ],
        security: [
            { StationlyKey: [] }
        ]
    },
    apis: [
        path.join(__dirname, './controllers/*.ts'),
        path.join(__dirname, './controllers/*.js')
    ]
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);

// --- PUBLIC DOC FILTER ---------------------------------------------------
// Strips internal / app-only operations out of the spec we *publish*.
// This is a documentation-only transform: it operates on a deep copy of the
// generated spec and is used solely for `/openapi.json` + `/docs`. The live
// API (routes, controllers, middleware, auth) is completely untouched — those
// endpoints still exist and work, they're just not advertised to third-party
// developers browsing the public reference.
//
// Published surface = the transport-data product only (Modes, Lines, Stations).
// Everything else is hidden via INTERNAL_TAGS / INTERNAL_PREFIXES below.
// See docs/API_DOCUMENTATION.md for the full rationale.
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;
function buildPublicSpec(fullSpec: any): any {
    const spec = JSON.parse(JSON.stringify(fullSpec));
    // The public reference is the transport-data product only (Modes, Lines,
    // Stations). Everything else is app/website-internal plumbing with no value
    // to a third-party developer holding an `X-Stationly-Key`:
    //   - Users  : Firebase-auth user-private endpoints
    //   - SDUI   : Server-Driven UI layouts for the Stationly app's renderer
    //   - Auth   : the auth-flow subset of those SDUI layouts
    //   - Theme  : app theming tokens
    //   - Waitlist: the marketing site's launch-waitlist form
    const INTERNAL_TAGS = new Set(['Users', 'SDUI', 'Auth', 'Theme', 'Waitlist']);
    // `/stations/subscribed-ids` is a dev-tier endpoint tagged `Stations`, so
    // it's matched here by path rather than tag.
    const INTERNAL_PREFIXES = ['/user/', '/auth/', '/stations/subscribed-ids'];

    // 1. Drop internal operations; drop the path entirely if nothing's left.
    for (const [route, item] of Object.entries<any>(spec.paths ?? {})) {
        const isInternalPath = INTERNAL_PREFIXES.some((p) => route.startsWith(p));
        for (const method of HTTP_METHODS) {
            const op = item[method];
            if (!op) continue;
            const hasInternalTag = (op.tags ?? []).some((t: string) => INTERNAL_TAGS.has(t));
            if (isInternalPath || hasInternalTag) delete item[method];
        }
        if (!HTTP_METHODS.some((m) => item[m])) delete spec.paths[route];
    }

    // 2. Prune component schemas nothing in the public spec still references
    //    (follows $refs transitively so shared schemas survive).
    const allSchemas: Record<string, any> = spec.components?.schemas ?? {};
    const reachable = new Set<string>();
    const collectRefs = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(collectRefs); return; }
        for (const [key, value] of Object.entries<any>(node)) {
            const match = key === '$ref' && typeof value === 'string'
                ? value.match(/^#\/components\/schemas\/(.+)$/)
                : null;
            if (match && !reachable.has(match[1])) {
                reachable.add(match[1]);
                collectRefs(allSchemas[match[1]]);
            } else {
                collectRefs(value);
            }
        }
    };
    collectRefs(spec.paths);
    if (spec.components?.schemas) {
        spec.components.schemas = Object.fromEntries(
            Object.entries(allSchemas).filter(([name]) => reachable.has(name)),
        );
    }

    // 3. Keep only tags still used by a visible operation (drops empty `Users`).
    const usedTags = new Set<string>();
    for (const item of Object.values<any>(spec.paths ?? {})) {
        for (const method of HTTP_METHODS) {
            (item[method]?.tags ?? []).forEach((t: string) => usedTags.add(t));
        }
    }
    if (Array.isArray(spec.tags)) {
        spec.tags = spec.tags.filter((t: any) => usedTags.has(t.name));
    }

    return spec;
}
const publicSpec = buildPublicSpec(swaggerSpec);

// Serve OpenAPI JSON (public-filtered)
app.get('/openapi.json', (req, res) => {
    res.json(publicSpec);
});

// Scalar API Reference (ESM Dynamic Import Wrapper)
app.use('/docs', async (req, res, next) => {
    try {
        const { apiReference } = await (eval('import("@scalar/express-api-reference")') as Promise<any>);
        apiReference({
            spec: {
                content: publicSpec,
            },
            theme: 'default',
            // Force dark mode always so /docs matches the stationly.co.uk
            // site theme. `forceDarkModeState` pins the scheme regardless of
            // the visitor's OS/browser preference; hiding the toggle stops
            // anyone flipping it back to light.
            darkMode: true,
            forceDarkModeState: 'dark',
            hideDarkModeToggle: true,
        })(req, res, next);
    } catch (error) {
        next(error);
    }
});

// Routes
app.get('/', (req, res) => {
    res.json({ status: "Stationly Unified Backend Online" });
});

// Public — no API key required (website waitlist form)
app.post('/api/v1/waitlist/join', RateLimitMiddleware.strict, WaitlistController.join);

// Admin routes — mounted BEFORE `apiRoutes` so they bypass the
// client `X-Stationly-Key` middleware that apiRoutes installs at
// the top of its router. Guarded instead by a separate
// `X-Stationly-Admin-Key` header (see AdminAuthMiddleware).
//
// Path is `/api/v1/admin/*` (not bare `/admin`) because the staging
// + prod nginx reverse proxy only forwards `/api/v1/*` upstream;
// using a bare `/admin` prefix would 404 at nginx before reaching
// Node. The admin handlers still live in `src/admin/` so the
// swagger spec scanner (which globs `./controllers/*`) doesn't pick
// them up — `/docs` and `/openapi.json` stay clean.
app.use('/api/v1/admin', adminRoutes);

app.use('/api/v1', apiRoutes);

// Start Server
app.listen(port, () => {
    console.log(`\n--- [STATIONLY UNIFIED BACKEND LIVE] ---`);
    DataCacheService.initialize();
    console.log(`Port: ${port}`);
    console.log(`Endpoint: http://localhost:${port}/api/v1`);
    console.log(`Docs: http://localhost:${port}/docs`);
    console.log(`Spec: http://localhost:${port}/openapi.json`);
});
