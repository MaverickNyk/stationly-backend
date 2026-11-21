import { getBaseUrl, getWebUrl, getGreetingName } from '../utils/formatters';

export interface SupportEmailProps {
    name?: string | null;
    email?: string | null;
    amountMinor: number;
    currency?: string;
    txnId?: string;
}

export function formatCurrencyAmount(amountMinor: number, currency = 'GBP'): string {
    const c = currency.toUpperCase();
    const symbol = c === 'GBP' ? '£' : c === 'USD' ? '$' : c === 'EUR' ? '€' : `${c} `;
    const num = (amountMinor / 100).toFixed(2);
    return `${symbol}${num}`;
}

export function supportThankYouEmailHtml(props: SupportEmailProps): string {
    const greetingName = getGreetingName(props.name, props.email);
    const baseUrl = getBaseUrl();
    const webUrl = getWebUrl();
    const formattedAmount = formatCurrencyAmount(props.amountMinor, props.currency);
    const dateFormatted = new Date().toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });

    return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Thank you for supporting Stationly</title>
<!--[if mso]><style>table{border-collapse:collapse;}td,th,div,p,a,h1,h2,h3{font-family:sans-serif!important;}</style><![endif]-->
<style>
body { margin:0!important; padding:0!important; background-color:#0d1117!important; }
#bodyTable { background-color:#0d1117!important; }
@media screen and (max-width:620px){
  .outer-cell { padding:12px 10px 36px 10px!important; }
  .container  { border-radius:16px!important; width:100%!important; }
  .col-pad    { padding-left:22px!important; padding-right:22px!important; }
  .hero-title { font-size:27px!important; letter-spacing:-0.5px!important; line-height:1.2!important; }
  .receipt-table td { display:block!important; width:100%!important; padding:4px 0!important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#0d1117;-webkit-text-size-adjust:100%;">

<table id="bodyTable" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
       bgcolor="#0d1117" style="background-color:#0d1117;">
<tr>
  <td class="outer-cell" align="center" bgcolor="#0d1117"
      style="padding:32px 20px 56px 20px;background-color:#0d1117;">

    <!--[if mso]><table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
    <table class="container" role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"
           bgcolor="#161b22"
           style="max-width:600px;width:100%;background-color:#161b22;border-radius:24px;
                  overflow:hidden;border:1px solid #30363d;box-shadow:0 16px 40px rgba(0,0,0,0.5);">

      <!-- amber top bar -->
      <tr><td height="4" bgcolor="#FFB81C"
              style="height:4px;background:linear-gradient(90deg,#CC8800,#FFB81C 40%,#FFC819 60%,#CC8800);
                     font-size:0;line-height:0;">&nbsp;</td></tr>

      <!-- logo & badge -->
      <tr><td class="col-pad" align="center" style="padding:40px 40px 20px 40px;">
        <img src="${baseUrl}/assets/stationly_logo_final.png" alt="Stationly" width="56"
             style="display:block;border:0;width:56px;height:auto;margin:0 auto 22px auto;">
        
        <div style="display:inline-block;background-color:rgba(221,44,51,0.15);border:1px solid rgba(221,44,51,0.35);
                    border-radius:100px;padding:6px 14px;margin-bottom:16px;">
          <span style="color:#FF7B7B;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                       font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">
            ❤️ Voluntary Contribution Received
          </span>
        </div>

        <h1 class="hero-title"
            style="color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:32px;font-weight:800;letter-spacing:-0.8px;line-height:1.2;margin:0 0 16px 0;">
          Thank you, ${greetingName}.<br/>
          <span style="color:#FFB81C;">You're keeping Stationly free.</span>
        </h1>
        <p style="color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                  font-size:15px;line-height:1.65;margin:0 0 8px 0;text-align:left;">
          We just received your voluntary contribution of <strong style="color:#ffffff;">${formattedAmount}</strong>.
        </p>
        <p style="color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                  font-size:14px;line-height:1.65;margin:0;text-align:left;">
          Stationly is completely free and 100% ad-free — no tracking, no adverts, and nothing locked away.
          The live TfL API data feeds and servers behind every departure board cost real money every month.
          Your support goes directly into those running costs, keeping Stationly fast and reliable for every London commuter.
        </p>
      </td></tr>

      <!-- Receipt summary box -->
      <tr><td class="col-pad" style="padding:10px 40px 24px 40px;">
        <table class="receipt-table" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
               style="background-color:#0d1117;border:1px solid #30363d;border-radius:14px;padding:18px 22px;">
          <tr>
            <td style="color:#8b949e;font-family:sans-serif;font-size:13px;padding-bottom:10px;">Amount:</td>
            <td align="right" style="color:#58a6ff;font-family:sans-serif;font-size:16px;font-weight:800;padding-bottom:10px;">${formattedAmount}</td>
          </tr>
          <tr>
            <td style="color:#8b949e;font-family:sans-serif;font-size:13px;padding-bottom:10px;">Date:</td>
            <td align="right" style="color:#c9d1d9;font-family:sans-serif;font-size:13px;font-weight:600;padding-bottom:10px;">${dateFormatted}</td>
          </tr>
          ${props.txnId ? `
          <tr>
            <td style="color:#8b949e;font-family:sans-serif;font-size:13px;padding-bottom:10px;">Reference:</td>
            <td align="right" style="color:#8b949e;font-family:monospace;font-size:12px;padding-bottom:10px;">${props.txnId}</td>
          </tr>
          ` : ''}
          <tr>
            <td style="color:#8b949e;font-family:sans-serif;font-size:13px;">Status:</td>
            <td align="right" style="color:#3fb950;font-family:sans-serif;font-size:13px;font-weight:700;">Completed (Paid)</td>
          </tr>
        </table>
      </td></tr>

      <!-- Founder note -->
      <tr><td class="col-pad" style="padding:0 40px 30px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="padding:22px;background-color:#0d1117;border:1px solid #30363d;
                     border-left:4px solid #FFB81C;border-radius:0 14px 14px 0;">
            <p style="color:#c9d1d9;font-family:sans-serif;font-size:14px;line-height:1.7;margin:0 0 12px 0;">
              "I build Stationly solo with a single goal: giving Londoners real-time departures the second they glance at their screens, with zero clutter and zero ads.
              Contributions from people like you make this sustainable."
            </p>
            <p style="color:#8b949e;font-family:sans-serif;font-size:13px;margin:0;">
              Nick &nbsp;&middot;&nbsp; Founder &nbsp;&middot;&nbsp;
              <a href="mailto:info@stationly.co.uk" style="color:#FFB81C;text-decoration:none;font-weight:600;">info@stationly.co.uk</a>
            </p>
          </td>
        </tr></table>
      </td></tr>

      <!-- CTA Back to Stationly -->
      <tr><td align="center" style="padding:0 40px 32px 40px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
                     href="${webUrl}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="28%" stroke="f" fillcolor="#FFB81C">
          <w:anchorlock/>
          <center style="color:#000000;font-family:sans-serif;font-size:15px;font-weight:bold;">Open Stationly</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-->
        <a class="btn-link" href="${webUrl}"
           style="background-color:#FFB81C;color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                  font-size:15px;font-weight:800;letter-spacing:0.3px;text-decoration:none;
                  padding:14px 34px;border-radius:14px;display:inline-block;box-shadow:0 6px 20px rgba(255,184,28,0.25);">
          Open Stationly &rarr;
        </a>
        <!--<![endif]-->
      </td></tr>

      <!-- transport mode icons -->
      <tr><td align="center" style="padding:0 36px 24px 36px;">
        <table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0"><tr>
          <td style="padding:0 6px;">
            <img src="${baseUrl}/icons/tube.png" alt="Tube" width="34" height="34" style="width:34px;height:34px;display:block;border:0;">
          </td>
          <td style="padding:0 6px;">
            <img src="${baseUrl}/icons/overground.png" alt="Overground" width="34" height="34" style="width:34px;height:34px;display:block;border:0;">
          </td>
          <td style="padding:0 6px;">
            <img src="${baseUrl}/icons/dlr.png" alt="DLR" width="34" height="34" style="width:34px;height:34px;display:block;border:0;">
          </td>
          <td style="padding:0 6px;">
            <img src="${baseUrl}/icons/elizabeth.png" alt="Elizabeth line" width="34" height="34" style="width:34px;height:34px;display:block;border:0;">
          </td>
          <td style="padding:0 6px;">
            <img src="${baseUrl}/icons/bus.png" alt="Bus" width="34" height="34" style="width:34px;height:34px;display:block;border:0;">
          </td>
        </tr></table>
        <p style="color:#484f58;font-family:sans-serif;font-size:11px;margin:10px 0 0 0;letter-spacing:1px;">
          ALL MODES &nbsp;&middot;&nbsp; ALL LIVE
        </p>
      </td></tr>

      <!-- footer -->
      <tr><td align="center" bgcolor="#0d1117"
              style="padding:20px 36px 28px 36px;background-color:#0d1117;border-top:1px solid #21262d;">
        <p style="color:#6e7681;font-family:sans-serif;font-size:12px;line-height:1.7;margin:0;">
          &copy; 2026 Stationly Ltd &nbsp;&middot;&nbsp; London, UK<br/>
          This is a receipt for your voluntary contribution to Stationly.<br/>
          <a href="${webUrl}/privacy" style="color:#8b949e;text-decoration:none;">Privacy Policy</a>
          &nbsp;&middot;&nbsp;
          <a href="${webUrl}/terms" style="color:#8b949e;text-decoration:none;">Terms</a>
        </p>
      </td></tr>

      <!-- amber bottom bar -->
      <tr><td height="4" bgcolor="#FFB81C"
              style="height:4px;background:linear-gradient(90deg,#CC8800,#FFB81C 50%,#CC8800);
                     font-size:0;line-height:0;">&nbsp;</td></tr>

    </table>
    <!--[if mso]></td></tr></table><![endif]-->

  </td>
</tr>
</table>
</body>
</html>`;
}
