import { getBaseUrl } from '../utils/formatters';

/**
 * Email verification template — light theme, identical visual language to the
 * welcome email. White card on grey, amber accent line at top and bottom, same
 * sender, same footer. The two emails should feel like a pair.
 */
export function verifyEmailHtml(name: string, verifyLink: string): string {
    const displayName = name || 'there';
    const baseUrl = getBaseUrl();
    return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Verify your Stationly email</title>
<!--[if mso]><style>table{border-collapse:collapse;}td,th,div,p,a,h1,h2,h3{font-family:sans-serif!important;}</style><![endif]-->
<style>
body { margin:0!important; padding:0!important; background-color:#f0f0f0!important; }
#bodyTable { background-color:#f0f0f0!important; }
@media screen and (max-width:620px){
  .outer-cell { padding:0!important; }
  .container  { border-radius:0!important; width:100%!important; }
  .col-pad    { padding-left:20px!important; padding-right:20px!important; }
  .hero-title { font-size:28px!important; letter-spacing:-0.5px!important; line-height:1.2!important; }
  .btn-link   { display:block!important; text-align:center!important;
                padding:17px 24px!important; font-size:15px!important; white-space:nowrap!important; }
  .note-pad   { padding:22px 18px!important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#f0f0f0;-webkit-text-size-adjust:100%;">

<table id="bodyTable" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
       bgcolor="#f0f0f0" style="background-color:#f0f0f0;">
<tr>
  <td class="outer-cell" align="center" bgcolor="#f0f0f0"
      style="padding:28px 20px 56px 20px;background-color:#f0f0f0;">

    <!--[if mso]><table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
    <table class="container" role="presentation" width="600" cellspacing="0" cellpadding="0" border="0"
           bgcolor="#ffffff"
           style="max-width:600px;width:100%;background-color:#ffffff;border-radius:22px;
                  overflow:hidden;border:1px solid #E5E5E5;">

      <!-- amber top bar -->
      <tr><td height="4" bgcolor="#FFB81C"
              style="height:4px;background:linear-gradient(90deg,#CC8800,#FFB81C 40%,#FFC819 60%,#CC8800);
                     font-size:0;line-height:0;">&nbsp;</td></tr>

      <!-- logo + hero -->
      <tr><td class="col-pad" align="center" style="padding:40px 40px 26px 40px;">
        <img src="${baseUrl}/assets/stationly_logo_final.png" alt="Stationly" width="52"
             style="display:block;border:0;width:52px;height:auto;margin:0 auto 20px auto;">
        <p style="color:#999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 14px 0;">
          One more step — verify your email
        </p>
        <h1 class="hero-title"
            style="color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:34px;font-weight:800;letter-spacing:-1px;line-height:1.15;margin:0 0 16px 0;">
          Hey ${displayName},<br/>
          <span style="color:#CC8800;">you're almost there.</span>
        </h1>
        <p style="color:#555;font-family:sans-serif;font-size:15px;line-height:1.7;margin:0;">
          Tap the button below to confirm this is really your email — it takes a second,
          and then your Stationly account is fully ready to go.
        </p>
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:0 40px 44px 40px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="${verifyLink}" style="height:56px;v-text-anchor:middle;width:280px;"
            arcsize="28%" stroke="f" fillcolor="#FFB81C">
        <w:anchorlock/>
        <center style="color:#000000;font-family:sans-serif;font-size:16px;font-weight:900;">Verify My Email</center>
        </v:roundrect>
        <![endif]--><!--[if !mso]><!-->
        <a class="btn-link" href="${verifyLink}"
           style="background-color:#FFB81C;color:#000000;padding:18px 44px;border-radius:14px;
                  text-decoration:none;font-family:sans-serif;font-weight:800;font-size:16px;
                  display:inline-block;white-space:nowrap;letter-spacing:0.2px;">
          Verify My Email &#8594;
        </a><!--<![endif]-->
        <p style="color:#AAAAAA;font-family:sans-serif;font-size:12px;margin:12px 0 0 0;">
          Takes a second &nbsp;·&nbsp; One-time link &nbsp;·&nbsp; Expires in 1 hour
        </p>
      </td></tr>

      <!-- divider -->
      <tr><td style="padding:0 36px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr><td height="1" bgcolor="#EEEEEE" style="height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td></tr>

      <!-- security note -->
      <tr><td class="col-pad" style="padding:32px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td class="note-pad"
              style="padding:22px 24px;background-color:#FAFAFA;border:1px solid #EEEEEE;border-radius:14px;">
            <p style="color:#CC8800;font-family:sans-serif;font-size:11px;font-weight:700;
                       letter-spacing:2px;text-transform:uppercase;margin:0 0 10px 0;">
              Didn't sign up?
            </p>
            <p style="color:#666;font-family:sans-serif;font-size:13px;line-height:1.7;margin:0;">
              If you didn't create a Stationly account you can safely ignore this email —
              nothing will be activated until someone taps the button above.
            </p>
          </td>
        </tr></table>
      </td></tr>

      <!-- link fallback -->
      <tr><td class="col-pad" style="padding:0 40px 32px 40px;">
        <p style="color:#999;font-family:sans-serif;font-size:12px;line-height:1.7;margin:0;">
          Button not working? Copy and paste this link into your browser:<br/>
          <a href="${verifyLink}" style="color:#AAAAAA;word-break:break-all;">${verifyLink}</a>
        </p>
      </td></tr>

      <!-- footer -->
      <tr><td align="center" bgcolor="#FAFAFA"
              style="padding:20px 36px 28px 36px;background-color:#FAFAFA;border-top:1px solid #EEEEEE;">
        <p style="color:#AAAAAA;font-family:sans-serif;font-size:12px;line-height:1.7;margin:0;">
          &copy; 2026 Stationly Ltd &nbsp;·&nbsp; London, UK<br/>
          <a href="https://stationly.co.uk/privacy" style="color:#BBBBBB;text-decoration:none;">Privacy Policy</a>
          &nbsp;·&nbsp;
          <a href="https://stationly.co.uk/terms" style="color:#BBBBBB;text-decoration:none;">Terms</a>
          &nbsp;·&nbsp;
          Questions? <a href="mailto:info@stationly.co.uk" style="color:#BBBBBB;text-decoration:none;">info@stationly.co.uk</a>
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
