import { getBaseUrl, getWebUrl } from '../utils/formatters';

export function androidLaunchNotificationHtml(): string {
  const baseUrl = getBaseUrl();
  const webUrl = getWebUrl();
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Stationly is Live on Android</title>
<!--[if mso]><style>table{border-collapse:collapse;}td,th,div,p,a,h1,h2,h3{font-family:sans-serif!important;}</style><![endif]-->
<style>
body { margin:0!important; padding:0!important; background-color:#f0f0f0!important; }
#bodyTable { background-color:#f0f0f0!important; }
@media screen and (max-width:620px){
  .outer-cell { padding:0 0 0 0!important; }
  .container  { border-radius:0!important; width:100%!important; }
  .col-pad    { padding-left:20px!important; padding-right:20px!important; }
  .hero-title { font-size:28px!important; letter-spacing:-0.5px!important; line-height:1.2!important; }
  .btn-link   { display:block!important; text-align:center!important;
                padding:17px 24px!important; font-size:15px!important; white-space:nowrap!important; }
  .note-pad   { padding:22px 18px!important; }
  .mode-icon  { width:28px!important; height:28px!important; }
  .mode-cell  { padding:0 4px!important; }
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

      <!-- red top bar -->
      <tr><td height="4" style="height:4px;background:linear-gradient(90deg,#B91C22,#DD2C33 40%,#FF3E46 60%,#B91C22);font-size:0;line-height:0;">&nbsp;</td></tr>

      <tr><td class="col-pad" align="center" style="padding:44px 40px 16px 40px;">
        <!-- Stationly x Android Logo Combo -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 24px auto;">
          <tr>
            <td valign="middle" style="padding-right:0px;line-height:44px;padding-top:2px;">
              <img src="${baseUrl}/assets/stationly_logo_final.png" alt="Stationly" width="44" height="44" style="display:block;border:0;width:44px;height:44px;">
            </td>
            <td valign="middle" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:20px;font-weight:300;color:#CCCCCC;padding:0 8px;line-height:44px;">&times;</td>
            <td valign="middle" style="padding-left:0px;line-height:44px;">
              <img src="${baseUrl}/assets/android_head_3d.png" alt="Android" width="40" height="40" style="display:block;border:0;width:40px;height:40px;">
            </td>
          </tr>
        </table>
        <p style="color:#DD2C33;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:11px;font-weight:700;letter-spacing:2.5px;margin:0 0 14px 0;">
          LAUNCH UPDATE
        </p>
        <h1 class="hero-title"
            style="color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:32px;font-weight:800;letter-spacing:-1px;line-height:1.2;margin:0 0 18px 0;">
          Stationly is live<br/>
          <span style="color:#DD2C33;">on Android.</span>
        </h1>
        <p style="color:#555;font-family:sans-serif;font-size:15px;line-height:1.7;margin:0;">
          A few months ago, you joined our waitlist to get live TfL departure boards on your home screen. Today, we are excited to announce that Stationly is officially live on Android!
        </p>
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:0 40px 40px 40px;">
        <a href="${baseUrl}/open?deep=${encodeURIComponent('https://play.google.com/store/apps/details?id=com.stationly.mobile')}&web=${encodeURIComponent(webUrl + '/mobile/app/android/')}" target="_blank" style="display:inline-block;text-decoration:none;">
          <img src="${baseUrl}/assets/google_play_badge.png" 
               alt="Get it on Google Play" 
               height="58" 
               style="height:58px;display:block;border:0;margin:0 auto;">
        </a>
        <p style="color:#AAAAAA;font-family:sans-serif;font-size:12px;margin:8px 0 0 0;">
          Live Departures &nbsp;·&nbsp; Home Screen Widget &nbsp;·&nbsp; Always Ready
        </p>
      </td></tr>

      <!-- divider -->
      <tr><td style="padding:0 36px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr><td height="1" bgcolor="#EEEEEE" style="height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td></tr>

      <!-- nick's note -->
      <tr><td class="col-pad" style="padding:34px 40px 38px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td class="note-pad"
              style="padding:26px 28px;background-color:#FAFAFA;border:1px solid #EEEEEE;border-radius:18px;">

            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:18px;">
              <tr>
                <td style="padding-right:12px;">
                  <div style="width:42px;height:42px;background:linear-gradient(135deg,#DD2C33,#B91C22);
                              border-radius:50%;text-align:center;line-height:42px;
                              font-family:sans-serif;font-size:17px;font-weight:800;color:#fff;">N</div>
                </td>
                <td>
                  <p style="color:#111;font-family:sans-serif;font-size:14px;font-weight:700;margin:0 0 2px 0;">Nick</p>
                  <p style="color:#999;font-family:sans-serif;font-size:12px;margin:0;">Founder, Stationly &nbsp;·&nbsp; London</p>
                </td>
              </tr>
            </table>
            <p style="color:#555;font-family:sans-serif;font-size:14px;line-height:1.85;margin:0 0 14px 0;">
              First, a huge thank you for waiting. It genuinely means a lot to have you on our waitlist.
            </p>
            <p style="color:#555;font-family:sans-serif;font-size:14px;line-height:1.85;margin:0 0 14px 0;">
              Stationly for Android is finally out in the wild! We have worked incredibly hard and passionately to bring live departure boards to Android.
            </p>
            <p style="color:#555;font-family:sans-serif;font-size:14px;line-height:1.85;margin:0 0 14px 0;">
              If you use an Android device, you can download it today. The most valuable thing we ask for in return is your feedback. We will take every piece of feedback, listen, and improvise. If there is anything else you need or want to see in the app, I'd be happy to address it and build it for you.
            </p>
            <p style="color:#555;font-family:sans-serif;font-size:14px;line-height:1.85;margin:0 0 14px 0;">
              <strong>If you are an iOS user:</strong> don't worry, we are currently putting the finishing touches on the iOS version. Your spot on the waitlist is secured, and we will email you the absolute second it lands on the App Store.
            </p>
            <p style="color:#555;font-family:sans-serif;font-size:14px;line-height:1.85;margin:0 0 14px 0;">
              If you have any questions, feedback, or just want to chat, reply directly to this email — I read and answer every one.
            </p>
            <p style="color:#555;font-family:sans-serif;font-size:14px;line-height:1.85;margin:0;">
              Hope to see you on board soon! 🚇
            </p>
            <p style="color:#999;font-family:sans-serif;font-size:13px;margin:20px 0 0 0;">
              — Nick &nbsp;·&nbsp;
              <a href="mailto:info@stationly.co.uk" style="color:#DD2C33;text-decoration:none;">info@stationly.co.uk</a>
            </p>
          </td>
        </tr></table>
      </td></tr>

      <!-- transport mode icons -->
      <tr><td align="center" style="padding:0 36px 26px 36px;">
        <table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0"><tr>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="${baseUrl}/icons/tube.png"
                 alt="Tube" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="${baseUrl}/icons/overground.png"
                 alt="Overground" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="${baseUrl}/icons/dlr.png"
                 alt="DLR" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="${baseUrl}/icons/elizabeth.png"
                 alt="Elizabeth line" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="${baseUrl}/icons/bus.png"
                 alt="Bus" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
        </tr></table>
        <p style="color:#CCCCCC;font-family:sans-serif;font-size:11px;margin:10px 0 0 0;letter-spacing:1px;">
          ALL MODES &nbsp;·&nbsp; ALL LIVE
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
        </p>
      </td></tr>

      <!-- red bottom bar -->
      <tr><td height="4" style="height:4px;background:linear-gradient(90deg,#B91C22,#DD2C33 50%,#B91C22);font-size:0;line-height:0;">&nbsp;</td></tr>

    </table>
    <!--[if mso]></td></tr></table><![endif]-->

  </td>
</tr>
</table>
</body>
</html>`;
}
