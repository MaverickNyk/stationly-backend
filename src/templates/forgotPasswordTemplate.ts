export function forgotPasswordEmailHtml(name: string, resetLink: string): string {
    const displayName = name || 'there';
    return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting"><meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Reset your Stationly password</title>
<!--[if mso]><style>table{border-collapse:collapse;}td,th,div,p,a,h1,h2,h3{font-family:sans-serif!important;}</style><![endif]-->
<style>
@media screen and (max-width:600px){
  .container{width:100%!important;border-radius:0!important;}
  .pad{padding:28px 22px!important;}
  .hero-title{font-size:30px!important;}
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#000000;-webkit-text-size-adjust:100%;">
<div role="article" aria-roledescription="email" lang="en" style="background-color:#000000;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#000000;">
<tr><td align="center" style="padding:24px 0 64px 0;">
<!--[if mso]><table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table class="container" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"
       style="max-width:600px;background-color:#0A0A0A;border:1px solid #1C1C1C;border-radius:28px;overflow:hidden;margin:0 auto;">

  <!-- top bar -->
  <tr><td style="height:3px;background:linear-gradient(90deg,#CC8800,#FFB81C 40%,#FFC819 60%,#CC8800);font-size:0;line-height:0;">&nbsp;</td></tr>

  <!-- logo -->
  <tr><td align="center" style="padding:40px 48px 0 48px;">
    <img src="https://api.stationly.co.uk/assets/stationly_logo_final.png" alt="Stationly" width="52"
         style="display:block;border:0;width:52px;margin:0 auto;">
  </td></tr>

  <!-- hero -->
  <tr><td class="pad" align="center" style="padding:32px 48px 36px 48px;">
    <p style="color:#555555;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
               font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;margin:0 0 18px 0;">
      Password reset
    </p>
    <h1 class="hero-title"
        style="color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
               font-size:34px;font-weight:800;letter-spacing:-1px;line-height:1.15;margin:0 0 20px 0;">
      Hey ${displayName}, let's get<br/>
      <span style="color:#FFB81C;">you back in.</span>
    </h1>
    <p style="color:#777777;font-family:sans-serif;font-size:15px;line-height:1.7;margin:0;">
      Someone (hopefully you) requested a password reset for your Stationly account.
      Click the button below — the link expires in <strong style="color:#AAAAAA;">1 hour</strong>.
    </p>
  </td></tr>

  <!-- CTA -->
  <tr><td align="center" style="padding:0 48px 44px 48px;">
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word"
        href="${resetLink}" style="height:58px;v-text-anchor:middle;width:260px;"
        arcsize="28%" stroke="f" fillcolor="#FFB81C">
    <w:anchorlock/><center style="color:#000000;font-family:sans-serif;font-size:16px;font-weight:900;">Reset My Password</center>
    </v:roundrect>
    <![endif]--><!--[if !mso]><!-->
    <a href="${resetLink}"
       style="background-color:#FFB81C;color:#000000;padding:19px 46px;border-radius:16px;text-decoration:none;
              font-family:sans-serif;font-weight:800;font-size:16px;display:inline-block;letter-spacing:0.2px;">
      Reset My Password →
    </a><!--<![endif]-->
  </td></tr>

  <!-- divider -->
  <tr><td style="padding:0 48px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="height:1px;background-color:#181818;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>

  <!-- security note -->
  <tr><td class="pad" style="padding:32px 48px 36px 48px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
      <td style="padding:22px 26px;background-color:#0D0D0D;border:1px solid #1E1E1E;border-radius:16px;">
        <p style="color:#FFB81C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin:0 0 12px 0;">
          Didn't request this?
        </p>
        <p style="color:#666666;font-family:sans-serif;font-size:13px;line-height:1.7;margin:0;">
          You can safely ignore this email — your password won't change unless you click the button above.
          If you're worried someone else made this request, reply to this email and we'll look into it.
        </p>
      </td>
    </tr></table>
  </td></tr>

  <!-- link fallback -->
  <tr><td class="pad" style="padding:0 48px 40px 48px;">
    <p style="color:#444444;font-family:sans-serif;font-size:12px;line-height:1.7;margin:0;">
      Button not working? Copy and paste this link into your browser:<br/>
      <a href="${resetLink}" style="color:#555555;word-break:break-all;">${resetLink}</a>
    </p>
  </td></tr>

  <!-- divider -->
  <tr><td style="padding:0 48px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="height:1px;background-color:#181818;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>

  <!-- footer -->
  <tr><td align="center" style="padding:28px 48px 40px 48px;">
    <p style="color:#2E2E2E;font-family:sans-serif;font-size:12px;line-height:1.7;margin:0;">
      &copy; 2026 Stationly Ltd &nbsp;·&nbsp; London, UK<br/>
      <a href="https://stationly.co.uk/privacy" style="color:#3A3A3A;text-decoration:none;">Privacy Policy</a>
      &nbsp;·&nbsp;
      <a href="https://stationly.co.uk/terms" style="color:#3A3A3A;text-decoration:none;">Terms</a>
      &nbsp;·&nbsp;
      Questions? <a href="mailto:info@stationly.co.uk" style="color:#3A3A3A;text-decoration:none;">info@stationly.co.uk</a>
    </p>
  </td></tr>

  <!-- bottom bar -->
  <tr><td style="height:3px;background:linear-gradient(90deg,#1C1C1C,#FFB81C 50%,#1C1C1C);font-size:0;line-height:0;">&nbsp;</td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</div>
</body>
</html>`;
}
