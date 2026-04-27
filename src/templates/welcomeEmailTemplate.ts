export function welcomeEmailHtml(name: string): string {
    const displayName = name || 'there';
    return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
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
        <img src="https://api.stationly.co.uk/assets/stationly_logo_final.png" alt="Stationly" width="52"
             style="display:block;border:0;width:52px;height:auto;margin:0 auto 20px auto;">
        <p style="color:#999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 14px 0;">
          You're in. Welcome aboard.
        </p>
        <h1 class="hero-title"
            style="color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
                   font-size:34px;font-weight:800;letter-spacing:-1px;line-height:1.15;margin:0 0 16px 0;">
          Hey ${displayName}<br/>
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
              — Every Londoner, every morning, since 2003
            </p>
          </td>
        </tr></table>
      </td></tr>

      <!-- app screenshot -->
      <tr><td class="col-pad" align="center" style="padding:0 24px 34px 24px;">
        <img src="https://api.stationly.co.uk/assets/stationly-demo-widget.jpg"
             alt="Stationly live departure board" width="552"
             style="width:100%;max-width:552px;height:auto;display:block;border-radius:14px;
                    border:1px solid #E5E5E5;">
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:0 40px 44px 40px;">
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
            href="https://api.stationly.co.uk/open?deep=stationly%3A%2F%2Fhome&web=https%3A%2F%2Fstationly.co.uk"
            style="height:56px;v-text-anchor:middle;width:280px;" arcsize="28%" stroke="f" fillcolor="#FFB81C">
        <w:anchorlock/>
        <center style="color:#000000;font-family:sans-serif;font-size:16px;font-weight:900;">Open My Live Board</center>
        </v:roundrect>
        <![endif]--><!--[if !mso]><!-->
        <a class="btn-link"
           href="https://api.stationly.co.uk/open?deep=stationly%3A%2F%2Fhome&web=https%3A%2F%2Fstationly.co.uk"
           style="background-color:#FFB81C;color:#000000;padding:18px 44px;border-radius:14px;
                  text-decoration:none;font-family:sans-serif;font-weight:800;font-size:16px;
                  display:inline-block;white-space:nowrap;letter-spacing:0.2px;">
          Open My Live Board &#8594;
        </a><!--<![endif]-->
        <p style="color:#AAAAAA;font-family:sans-serif;font-size:12px;margin:12px 0 0 0;">
          Real-time &nbsp;·&nbsp; No searching &nbsp;·&nbsp; Always up to date
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
                Tube, Overground, DLR, Elizabeth line, bus — live arrivals the second you open it.
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
                Home screen widget — no unlock needed
              </p>
              <p style="color:#777;font-family:sans-serif;font-size:13px;line-height:1.65;margin:0;">
                Glance at your widget and walk out. No unlocking, no searching, no spinner.
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
                Push-powered refresh in the background — open it and the board is already live.
              </p>
            </td>
          </tr>
        </table>
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
            <p style="color:#CC8800;font-family:sans-serif;font-size:11px;font-weight:700;
                       letter-spacing:2.5px;text-transform:uppercase;margin:0 0 16px 0;">
              Why I built this
            </p>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:18px;">
              <tr>
                <td style="padding-right:12px;">
                  <div style="width:42px;height:42px;background:linear-gradient(135deg,#FFB81C,#CC7700);
                              border-radius:50%;text-align:center;line-height:42px;
                              font-family:sans-serif;font-size:17px;font-weight:800;color:#000;">M</div>
                </td>
                <td>
                  <p style="color:#111;font-family:sans-serif;font-size:14px;font-weight:700;margin:0 0 2px 0;">Mave</p>
                  <p style="color:#999;font-family:sans-serif;font-size:12px;margin:0;">Founder, Stationly &nbsp;·&nbsp; London</p>
                </td>
              </tr>
            </table>
            <p style="color:#555;font-family:sans-serif;font-size:14px;line-height:1.85;margin:0;">
              I started Stationly out of a very personal frustration.
              <br/><br/>
              I commute the same route every single day — home to office, office to home.
              Every morning I had the same question before leaving home:
              <em style="color:#111;">"Is my train coming or do I have a few minutes?"</em>
              <br/><br/>
              The answer should be visible the second you look at your phone — no searching, no loading screens.
              I needed a live signal board, right there on my home screen.
              <br/><br/>
              So I built one.
              <br/><br/>
              Stationly is the app I always wanted to exist. You tell it your station once, and from that moment it just works —
              live departures on your home screen, no friction whatsoever.
              <br/><br/>
              I'm building this solo, so your feedback genuinely shapes what I work on next.
              If something doesn't work or there's a feature you'd love — just reply to this email. I read every one.
              <br/><br/>
              Hope Stationly earns a permanent spot on your home screen. 🚇
            </p>
            <p style="color:#999;font-family:sans-serif;font-size:13px;margin:20px 0 0 0;">
              — Mave &nbsp;·&nbsp;
              <a href="mailto:info@stationly.co.uk" style="color:#CC8800;text-decoration:none;">info@stationly.co.uk</a>
            </p>
          </td>
        </tr></table>
      </td></tr>

      <!-- transport mode icons -->
      <tr><td align="center" style="padding:0 36px 26px 36px;">
        <table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0"><tr>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="https://api.stationly.co.uk/icons/tube.png"
                 alt="Tube" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="https://api.stationly.co.uk/icons/overground.png"
                 alt="Overground" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="https://api.stationly.co.uk/icons/dlr.png"
                 alt="DLR" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="https://api.stationly.co.uk/icons/elizabeth.png"
                 alt="Elizabeth line" width="38" height="38" style="width:38px;height:38px;display:block;border:0;">
          </td>
          <td class="mode-cell" style="padding:0 6px;">
            <img class="mode-icon" src="https://api.stationly.co.uk/icons/bus.png"
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
