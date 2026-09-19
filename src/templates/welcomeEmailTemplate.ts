import { getBaseUrl, getWebUrl, getUrlScheme, getGreetingName } from '../utils/formatters';

export type WelcomePlatform = 'ios' | 'android' | 'web';

export function welcomeEmailHtml(name: string, platform?: WelcomePlatform | string): string {
    const displayName = getGreetingName(name);
    const baseUrl = getBaseUrl();
    const encodedWebUrl = encodeURIComponent(getWebUrl());
    const scheme = getUrlScheme();
    const deepLink = encodeURIComponent(`${scheme}://home`);

    const isIos = (platform ?? '').toLowerCase() === 'ios';
    const isAndroid = (platform ?? '').toLowerCase() === 'android';

    // Tailored standalone widget board screenshot per platform
    // iOS uses the official medium iOS widget asset from the in-app Widget Guide
    // Android uses the classic dot-matrix Stationly departure widget board
    let widgetImageName = 'stationly-demo-widget.jpg';
    let widgetImageAlt = 'Stationly live departure board widget';
    let widgetMaxWidth = '460px';
    let widgetBorderRadius = '20px';
    if (isIos) {
        widgetImageName = 'widget_guide_medium.png';
        widgetImageAlt = 'Stationly iOS Live Departure Board Widget';
        widgetMaxWidth = '440px';
        // Soften top-left (34px), top-right (28px), bottom-right (34px) while keeping bottom-left standard (20px)
        widgetBorderRadius = '34px 28px 34px 20px';
    } else if (isAndroid) {
        widgetImageName = 'stationly-demo-widget.jpg';
        widgetImageAlt = 'Stationly Android Home Screen Widget';
        widgetMaxWidth = '460px';
        widgetBorderRadius = '16px';
    }

    // Platform-tailored accurate widget setup instructions
    let widgetSetupTitle = 'Add your Stationly widget in 15 seconds';
    let widgetSetupSteps = '';

    if (isIos) {
        widgetSetupTitle = 'Add your Stationly widget in 15 seconds';
        widgetSetupSteps = `
          <tr>
            <td width="32" valign="top" style="padding-right:12px;padding-bottom:14px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">1</div>
            </td>
            <td valign="top" style="padding-bottom:14px;">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                <strong>Touch and hold</strong> an empty area on your Home Screen until the icons jiggle.
              </p>
            </td>
          </tr>
          <tr>
            <td width="32" valign="top" style="padding-right:12px;padding-bottom:14px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">2</div>
            </td>
            <td valign="top" style="padding-bottom:14px;">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                Tap <strong>Edit</strong> in the top-left corner, then tap <strong>Add Widget</strong> (or the <strong>+</strong> button).
              </p>
            </td>
          </tr>
          <tr>
            <td width="32" valign="top" style="padding-right:12px;padding-bottom:14px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">3</div>
            </td>
            <td valign="top" style="padding-bottom:14px;">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                Search for <strong>Stationly</strong>, pick your widget size, and tap <strong>Add Widget</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td width="32" valign="top" style="padding-right:12px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">4</div>
            </td>
            <td valign="top">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                Touch and hold the widget, then tap <strong>Edit Widget</strong> to pick your station.
              </p>
            </td>
          </tr>
        `;
    } else if (isAndroid) {
        widgetSetupTitle = 'Add your Stationly widget in 15 seconds';
        widgetSetupSteps = `
          <tr>
            <td width="32" valign="top" style="padding-right:12px;padding-bottom:14px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">1</div>
            </td>
            <td valign="top" style="padding-bottom:14px;">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                <strong>Touch and hold</strong> any empty area on your home screen.
              </p>
            </td>
          </tr>
          <tr>
            <td width="32" valign="top" style="padding-right:12px;padding-bottom:14px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">2</div>
            </td>
            <td valign="top" style="padding-bottom:14px;">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                Tap <strong>Widgets</strong> from the popup menu and scroll to <strong>Stationly</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td width="32" valign="top" style="padding-right:12px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">3</div>
            </td>
            <td valign="top">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                Tap or drag the widget to place it, then select your station to start live countdowns.
              </p>
            </td>
          </tr>
        `;
    } else {
        // Universal / Web fallback
        widgetSetupTitle = 'Add the Stationly widget in 15 seconds';
        widgetSetupSteps = `
          <tr>
            <td width="32" valign="top" style="padding-right:12px;padding-bottom:14px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">iOS</div>
            </td>
            <td valign="top" style="padding-bottom:14px;">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                Hold Home Screen &rarr; tap <strong>Edit</strong> &rarr; <strong>Add Widget</strong> &rarr; search <strong>Stationly</strong> &rarr; hold widget to choose your station.
              </p>
            </td>
          </tr>
          <tr>
            <td width="32" valign="top" style="padding-right:12px;">
              <div style="width:26px;height:26px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:50%;text-align:center;line-height:26px;font-size:13px;font-weight:800;color:#CC8800;">Android</div>
            </td>
            <td valign="top">
              <p style="color:#222;font-family:sans-serif;font-size:13px;line-height:1.5;margin:0;">
                Hold Home Screen &rarr; select <strong>Widgets</strong> &rarr; choose <strong>Stationly</strong> &rarr; place and select your station.
              </p>
            </td>
          </tr>
        `;
    }

    return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Welcome to Stationly</title>
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
  .quote-pad  { padding:16px 16px!important; }
  .note-pad   { padding:22px 18px!important; }
  .guide-pad  { padding:20px 18px!important; }
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
          You're in. Welcome aboard.
        </p>
        <h1 class="hero-title"
            style="color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:34px;font-weight:800;letter-spacing:-1px;line-height:1.15;margin:0 0 16px 0;">
          Hey ${displayName},<br/>
          <span style="color:#CC8800;">no more guessing<br/>if the train's coming.</span>
        </h1>
        <p style="color:#555;font-family:sans-serif;font-size:15px;line-height:1.7;margin:0;">
          You've joined a small crew of Londoners who decided that standing at a bus stop,
          not knowing if the bus is 1 minute or 10 minutes away, is simply not acceptable.
        </p>
      </td></tr>

      <!-- london quote -->
      <tr><td class="col-pad" style="padding:0 40px 30px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td class="quote-pad"
              style="padding:20px 22px;background-color:#FAFAFA;border:1px solid #EEEEEE;
                     border-left:3px solid #FFB81C;border-radius:0 12px 12px 0;">
            <p style="color:#666;font-family:sans-serif;font-size:14px;font-style:italic;line-height:1.75;margin:0;">
              "Do I have to run for the bus, or can I sip my morning coffee peacefully?
              <em style="color:#333;">Squints at the bus stop sign. No signal. Can't load anything.</em>
              Abandons coffee. Sprints. Watches the doors close. Next one: 8 minutes."
            </p>
            <p style="color:#AAAAAA;font-family:sans-serif;font-size:12px;margin:10px 0 0 0;">
              Every Londoner, every morning, since 2003
            </p>
          </td>
        </tr></table>
      </td></tr>

      <!-- platform-tailored widget screenshot -->
      <tr><td class="col-pad" align="center" style="padding:0 24px 34px 24px;">
        <div style="max-width:${widgetMaxWidth};margin:0 auto;border-radius:${widgetBorderRadius};overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.12);border:1px solid #222222;">
          <img src="${baseUrl}/assets/${widgetImageName}"
               alt="${widgetImageAlt}"
               style="width:100%;max-width:${widgetMaxWidth};height:auto;display:block;margin:0 auto;border-radius:${widgetBorderRadius};">
        </div>
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:0 40px 36px 40px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="${baseUrl}/open?deep=${deepLink}&web=${encodedWebUrl}"
            style="height:56px;v-text-anchor:middle;width:280px;" arcsize="28%" stroke="f" fillcolor="#FFB81C">
        <w:anchorlock/>
        <center style="color:#000000;font-family:sans-serif;font-size:16px;font-weight:900;">Open My Live Board</center>
        </v:roundrect>
        <![endif]--><!--[if !mso]><!-->
        <a class="btn-link"
           href="${baseUrl}/open?deep=${deepLink}&web=${encodedWebUrl}"
           style="background-color:#FFB81C;color:#000000;padding:18px 44px;border-radius:14px;
                  text-decoration:none;font-family:sans-serif;font-weight:800;font-size:16px;
                  display:inline-block;white-space:nowrap;letter-spacing:0.2px;">
          Open My Live Board &#8594;
        </a><!--<![endif]-->
        <p style="color:#AAAAAA;font-family:sans-serif;font-size:12px;margin:12px 0 0 0;">
          Real-time &nbsp;&middot;&nbsp; No searching &nbsp;&middot;&nbsp; Always up to date
        </p>
      </td></tr>

      <!-- divider -->
      <tr><td style="padding:0 36px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr><td height="1" bgcolor="#EEEEEE" style="height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td></tr>

      <!-- what it does -->
      <tr><td class="col-pad" style="padding:34px 40px;">
        <p style="color:#CC8800;font-family:sans-serif;font-size:11px;font-weight:700;
                   letter-spacing:2.5px;text-transform:uppercase;margin:0 0 22px 0;">
          What it does for you
        </p>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td width="48" valign="top" style="padding-right:14px;padding-bottom:20px;">
              <div style="width:40px;height:40px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:11px;text-align:center;line-height:40px;font-size:18px;">🚇</div>
            </td>
            <td valign="top" style="padding-bottom:20px;">
              <p style="color:#111;font-family:sans-serif;font-size:14px;font-weight:700;margin:0 0 4px 0;">
                Opens straight to your board
              </p>
              <p style="color:#777;font-family:sans-serif;font-size:13px;line-height:1.65;margin:0;">
                Tube, Overground, DLR, Elizabeth line, and bus. Live arrivals the second you open the app.
              </p>
            </td>
          </tr>
          <tr>
            <td width="48" valign="top" style="padding-right:14px;padding-bottom:20px;">
              <div style="width:40px;height:40px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:11px;text-align:center;line-height:40px;font-size:18px;">📲</div>
            </td>
            <td valign="top" style="padding-bottom:20px;">
              <p style="color:#111;font-family:sans-serif;font-size:14px;font-weight:700;margin:0 0 4px 0;">
                Home screen widget (glance and go)
              </p>
              <p style="color:#777;font-family:sans-serif;font-size:13px;line-height:1.65;margin:0;">
                Glance at your widget and walk out the door. No unlocking, no searching, and no spinner.
              </p>
            </td>
          </tr>
          <tr>
            <td width="48" valign="top" style="padding-right:14px;">
              <div style="width:40px;height:40px;background-color:#FFF8E6;border:1px solid #FFE8A0;
                          border-radius:11px;text-align:center;line-height:40px;font-size:18px;">🔔</div>
            </td>
            <td valign="top">
              <p style="color:#111;font-family:sans-serif;font-size:14px;font-weight:700;margin:0 0 4px 0;">
                Updates while the app is closed
              </p>
              <p style="color:#777;font-family:sans-serif;font-size:13px;line-height:1.65;margin:0;">
                Push-powered refresh in the background, so whenever you glance at the board it is already fresh.
              </p>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- widget accurate setup guide -->
      <tr><td class="col-pad" style="padding:0 40px 34px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td class="guide-pad"
              style="padding:22px 24px;background-color:#FFFDF8;border:1px solid #FFE8A0;border-radius:16px;">
            <p style="color:#CC8800;font-family:sans-serif;font-size:13px;font-weight:700;
                       letter-spacing:0.2px;margin:0 0 16px 0;">
              ${widgetSetupTitle}
            </p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              ${widgetSetupSteps}
            </table>
          </td>
        </tr></table>
      </td></tr>

      <!-- divider -->
      <tr><td style="padding:0 36px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr><td height="1" bgcolor="#EEEEEE" style="height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
      </td></tr>

      <!-- nick's note (NO em-dashes) -->
      <tr><td class="col-pad" style="padding:34px 40px 38px 40px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td class="note-pad"
              style="padding:26px 28px;background-color:#FAFAFA;border:1px solid #EEEEEE;border-radius:18px;">
            <p style="color:#CC8800;font-family:sans-serif;font-size:11px;font-weight:700;
                       letter-spacing:2.5px;text-transform:uppercase;margin:0 0 16px 0;">
              Why I built this
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:18px;">
              <tr>
                <td style="padding-right:12px;">
                  <div style="width:42px;height:42px;background:linear-gradient(135deg,#FFB81C,#CC7700);
                              border-radius:50%;text-align:center;line-height:42px;
                              font-family:sans-serif;font-size:17px;font-weight:800;color:#000;">N</div>
                </td>
                <td>
                  <p style="color:#111;font-family:sans-serif;font-size:14px;font-weight:700;margin:0 0 2px 0;">Nick</p>
                  <p style="color:#999;font-family:sans-serif;font-size:12px;margin:0;">Founder, Stationly &nbsp;&middot;&nbsp; London</p>
                </td>
              </tr>
            </table>
            <div style="color:#444444;font-family:sans-serif;font-size:14px;line-height:1.75;margin:0;">
              <p style="margin:0 0 12px 0;">
                I started Stationly out of a very personal frustration. I commute the same route every single day: home to office, office to home. Every morning I had the same question before leaving home:
                <em style="color:#111;">"Is my train coming or do I have a few minutes?"</em>
              </p>
              <p style="margin:0 0 12px 0;">
                The answer should be visible the second you look at your phone, with no searching and no loading screens. I needed a live signal board, right there on my home screen. So I built one.
              </p>
              <p style="margin:0 0 12px 0;">
                Stationly is the app I always wanted to exist. You tell it your station once, and from that moment it just works. Live departures on your home screen, with zero friction.
              </p>
              <p style="margin:0 0 12px 0;">
                I am building this solo, so your feedback genuinely shapes what I work on next. If something does not work or there is a feature you would love, just reply directly to this email. I read every single message.
              </p>
              <p style="margin:0;font-weight:600;color:#222222;">
                Hope Stationly earns a permanent spot on your home screen.
              </p>
            </div>
            <p style="color:#888888;font-family:sans-serif;font-size:13px;margin:16px 0 0 0;">
              Nick &nbsp;&middot;&nbsp;
              <a href="mailto:info@stationly.co.uk" style="color:#CC8800;text-decoration:none;font-weight:600;">info@stationly.co.uk</a>
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
          ALL MODES &nbsp;&middot;&nbsp; ALL LIVE
        </p>
      </td></tr>

      <!-- footer -->
      <tr><td align="center" bgcolor="#FAFAFA"
              style="padding:20px 36px 28px 36px;background-color:#FAFAFA;border-top:1px solid #EEEEEE;">
        <p style="color:#AAAAAA;font-family:sans-serif;font-size:12px;line-height:1.7;margin:0;">
          &copy; 2026 Stationly Ltd &nbsp;&middot;&nbsp; London, UK<br/>
          <a href="https://stationly.co.uk/privacy" style="color:#BBBBBB;text-decoration:none;">Privacy Policy</a>
          &nbsp;&middot;&nbsp;
          <a href="https://stationly.co.uk/terms" style="color:#BBBBBB;text-decoration:none;">Terms</a>
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
