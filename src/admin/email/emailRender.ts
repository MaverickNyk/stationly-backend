/**
 * EmailDoc → HTML + plain text. Pure (no I/O), so the preview, the test send
 * and every real send produce byte-identical markup for the same recipient.
 *
 * The markup follows the existing Stationly templates (white card, red bars,
 * logo, grey footer) and the usual email-client rules: tables for layout,
 * inline styles, no web fonts, no CSS the big clients drop.
 *
 * Three modes decide what merge tokens become:
 *   - direct    → the recipient's own values (one render per recipient)
 *   - broadcast → Resend's placeholders ({{{contact.first_name|there}}}), one
 *                 render for everyone; Resend fills them per contact
 *   - preview   → the sample recipient's values, or readable placeholders
 */
import { EmailBlock, EmailDoc, FROM_ADDRESS, ICONS, isSafeUrl } from './emailDoc';

export type RenderMode = 'direct' | 'broadcast' | 'preview';

export interface RenderRecipient {
    firstName?: string;
    email?: string;
    /** Station names this recipient matched in the audience filter. */
    stations?: string[];
}

export interface RenderContext {
    mode: RenderMode;
    baseUrl: string;
    webUrl: string;
    recipient?: RenderRecipient;
    /** Direct marketing sends: this recipient's own unsubscribe link. */
    unsubscribeUrl?: string;
    /** Staging marks every subject. */
    subjectPrefix?: string;
}

export interface Rendered {
    subject: string;
    preheader: string;
    from: string;
    html: string;
    text: string;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const RED = '#DD2C33';
/**
 * Version stamp on built-in image links (logo, badges, icons). Bump it when
 * those files or their headers change: Cloudflare caches them for hours, and a
 * new query string is a new cache entry, so emails never get a stale copy.
 * v2: Cross-Origin-Resource-Policy became cross-origin (images were blocked
 * when an email was shown on another site).
 */
const ASSET_V = 'v=2';
const asset = (base: string, p: string) => `${base}${p}${p.includes('?') ? '&' : '?'}${ASSET_V}`;
const INK = '#111111';
const BODY = '#444444';
const MUTED = '#888888';

// ── merge tokens ─────────────────────────────────────────────────────────

const TOKEN = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi;

function joinNames(names: string[]): string {
    if (names.length <= 1) return names[0] || '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Replace merge tokens. `html` = the result goes into HTML (escape values). */
function mergeTokens(s: string, ctx: RenderContext, html: boolean): string {
    const r = ctx.recipient || {};
    return s.replace(TOKEN, (_m, rawKey: string, fallback?: string) => {
        const key = rawKey.toLowerCase();
        const fb = (fallback ?? '').trim();
        if (ctx.mode === 'broadcast') {
            if (key === 'first_name') return `{{{contact.first_name|${fb || 'there'}}}}`;
            if (key === 'email') return '{{{contact.email}}}';
            return fb; // validated away before a real broadcast; keeps previews sane
        }
        let v = '';
        if (key === 'first_name') v = r.firstName || fb || 'there';
        else if (key === 'email') v = r.email || fb || (ctx.mode === 'preview' ? 'name@example.com' : '');
        else if (key === 'station') v = joinNames(r.stations || []) || fb || (ctx.mode === 'preview' ? '[station]' : '');
        else v = fb;
        return html ? esc(v) : v;
    });
}

// ── inline formatting ────────────────────────────────────────────────────

function esc(s: string): string {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function attrUrl(u: string, ctx: RenderContext): string {
    const merged = mergeTokens(u.trim(), ctx, false);
    if (ctx.mode === 'broadcast' && merged.startsWith('{{{')) return merged; // Resend placeholder
    return isSafeUrl(merged) ? esc(merged) : '#';
}

/**
 * Safe Markdown subset → HTML. Escapes first, so no input can inject markup.
 * Supports **bold**, *italic*, [label](url) and single line breaks.
 */
function inline(s: string, ctx: RenderContext, linkColor = RED): string {
    // Tokens are merged AFTER escaping so a name can't smuggle markup in.
    let out = esc(s);
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
        const raw = url.replace(/&amp;/g, '&');
        const href = attrUrl(raw, ctx);
        return `<a href="${href}" target="_blank" style="color:${linkColor};text-decoration:underline;">${label}</a>`;
    });
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    out = mergeTokens(out, ctx, true);
    return out.replace(/\n/g, '<br>');
}

function paragraphs(s: string): string[] {
    return String(s || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

/** Plain-text version of the inline subset. */
function plain(s: string, ctx: RenderContext): string {
    let out = String(s || '').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, l: string, u: string) => `${l} (${mergeTokens(u, ctx, false)})`);
    out = out.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2');
    return mergeTokens(out, ctx, false);
}

// ── blocks ───────────────────────────────────────────────────────────────

const row = (inner: string, pad = '0 40px 20px 40px', align = 'left') =>
    `<tr><td class="col-pad" align="${align}" style="padding:${pad};text-align:${align};">${inner}</td></tr>`;

function blockHtml(b: EmailBlock, ctx: RenderContext, refStart: { n: number }): string {
    const align = (b as any).align === 'center' ? 'center' : 'left';
    switch (b.type) {
        case 'heading': {
            const size = b.size === 'md' ? 20 : b.size === 'lg' ? 26 : 32;
            const eyebrow = b.eyebrow
                ? `<p style="color:${RED};font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:2.5px;margin:0 0 12px 0;text-transform:uppercase;">${inline(b.eyebrow, ctx)}</p>`
                : '';
            const accent = b.accent ? `<br><span style="color:${RED};">${inline(b.accent, ctx)}</span>` : '';
            return row(`${eyebrow}<h1 class="${b.size === 'md' ? '' : 'hero-title'}" style="color:${INK};font-family:${FONT};font-size:${size}px;font-weight:800;letter-spacing:${size > 24 ? '-1px' : '-0.3px'};line-height:1.2;margin:0;">${inline(b.text, ctx)}${accent}</h1>`, '8px 40px 18px 40px', align);
        }
        case 'text': {
            const size = b.size === 'sm' ? 13 : 15;
            const color = b.tone === 'muted' ? MUTED : BODY;
            const ps = paragraphs(b.text).map((p, i, a) => `<p style="color:${color};font-family:${FONT};font-size:${size}px;line-height:1.7;margin:0 0 ${i === a.length - 1 ? 0 : 14}px 0;">${inline(p, ctx)}</p>`).join('');
            return row(ps, '0 40px 20px 40px', align);
        }
        case 'image': {
            const w = Math.max(80, Math.min(520, Number(b.width) || 520));
            const img = `<img src="${attrUrl(b.url, ctx)}" alt="${esc(b.alt)}" width="${w}" style="display:block;border:0;width:100%;max-width:${w}px;height:auto;${b.rounded === false ? '' : 'border-radius:14px;'}${align === 'center' ? 'margin:0 auto;' : ''}">`;
            const linked = b.href ? `<a href="${attrUrl(b.href, ctx)}" target="_blank" style="text-decoration:none;">${img}</a>` : img;
            const cap = b.caption ? `<p style="color:${MUTED};font-family:${FONT};font-size:12px;line-height:1.5;margin:8px 0 0 0;text-align:${align};">${inline(b.caption, ctx)}</p>` : '';
            return row(linked + cap, '4px 40px 22px 40px', align);
        }
        case 'button': {
            const v = b.variant || 'primary';
            const bg = v === 'primary' ? RED : v === 'dark' ? INK : '#FFFFFF';
            const fg = v === 'outline' ? INK : '#FFFFFF';
            const border = v === 'outline' ? `border:1.5px solid ${INK};` : `border:1.5px solid ${bg};`;
            const btn = `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${attrUrl(b.url, ctx)}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="25%" fillcolor="${bg}" strokecolor="${v === 'outline' ? INK : bg}"><center style="color:${fg};font-family:sans-serif;font-size:15px;font-weight:bold;">${esc(mergeTokens(b.label, ctx, false))}</center></v:roundrect><![endif]--><!--[if !mso]><!-- --><a class="btn-link" href="${attrUrl(b.url, ctx)}" target="_blank" style="display:inline-block;background-color:${bg};${border}color:${fg};font-family:${FONT};font-size:15px;font-weight:700;line-height:1;text-decoration:none;padding:15px 28px;border-radius:12px;">${esc(mergeTokens(b.label, ctx, false))}</a><!--<![endif]-->`;
            return row(btn, '6px 40px 26px 40px', align);
        }
        case 'storeBadges': {
            const ios = `${ctx.baseUrl}/open?deep=${encodeURIComponent('https://apps.apple.com/app/id6799715716')}&web=${encodeURIComponent(ctx.webUrl + '/mobile/app/ios/')}`;
            const android = `${ctx.baseUrl}/open?deep=${encodeURIComponent('https://play.google.com/store/apps/details?id=com.stationly.mobile')}&web=${encodeURIComponent(ctx.webUrl + '/mobile/app/android/')}`;
            const cells: string[] = [];
            if (b.ios) cells.push(`<td style="padding:4px 6px;"><a href="${esc(ios)}" target="_blank" style="text-decoration:none;"><img src="${esc(asset(ctx.baseUrl, '/assets/app_store_badge.png'))}" alt="Download on the App Store" width="150" height="50" style="display:block;border:0;width:150px;height:50px;"></a></td>`);
            if (b.android) cells.push(`<td style="padding:4px 6px;"><a href="${esc(android)}" target="_blank" style="text-decoration:none;"><img src="${esc(asset(ctx.baseUrl, '/assets/google_play_badge.png'))}" alt="Get it on Google Play" width="169" height="50" style="display:block;border:0;width:169px;height:50px;"></a></td>`);
            const cap = b.caption ? `<p style="color:#AAAAAA;font-family:${FONT};font-size:12px;margin:10px 0 0 0;text-align:${align};">${inline(b.caption, ctx)}</p>` : '';
            return row(`<table role="presentation" cellspacing="0" cellpadding="0" border="0" ${align === 'center' ? 'align="center" style="margin:0 auto;"' : ''}><tr>${cells.join('')}</tr></table>${cap}`, '4px 34px 24px 34px', align);
        }
        case 'icons': {
            const size = Math.max(20, Math.min(64, Number(b.size) || 36));
            const cells = (b.items || []).filter((n) => n in ICONS).map((n) =>
                `<td style="padding:0 8px;"><img src="${esc(asset(ctx.baseUrl, ICONS[n].path))}" alt="${esc(ICONS[n].label)}" width="${size}" height="${size}" style="display:block;border:0;width:${size}px;height:${size}px;"></td>`).join('');
            const cap = b.caption ? `<p style="color:#AAAAAA;font-family:${FONT};font-size:11px;letter-spacing:1px;margin:10px 0 0 0;text-align:${align};">${inline(b.caption, ctx)}</p>` : '';
            return row(`<table role="presentation" cellspacing="0" cellpadding="0" border="0" ${align === 'center' ? 'align="center" style="margin:0 auto;"' : ''}><tr>${cells}</tr></table>${cap}`, '4px 40px 22px 40px', align);
        }
        case 'quote': {
            const cite = b.cite
                ? `<p style="color:${MUTED};font-family:${FONT};font-size:12px;line-height:1.5;margin:10px 0 0 0;">${b.citeUrl ? `<a href="${attrUrl(b.citeUrl, ctx)}" target="_blank" style="color:${MUTED};text-decoration:underline;">${inline(b.cite, ctx, MUTED)}</a>` : inline(b.cite, ctx)}</p>`
                : '';
            return row(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-left:3px solid ${RED};padding:4px 0 4px 18px;"><p style="color:${INK};font-family:Georgia,'Times New Roman',serif;font-size:17px;font-style:italic;line-height:1.6;margin:0;">${inline(b.text, ctx)}</p>${cite}</td></tr></table>`);
        }
        case 'callout': {
            const tones = {
                info: ['#EFF6FF', '#BFDBFE', '#1D4ED8'],
                warning: ['#FFF8E6', '#FFE8A0', '#A16207'],
                success: ['#ECFDF3', '#BBF7D0', '#15803D'],
                note: ['#FAFAFA', '#EEEEEE', '#444444'],
            } as const;
            const [bg, bd, tc] = tones[b.tone || 'note'];
            const title = b.title ? `<p style="color:${tc};font-family:${FONT};font-size:13px;font-weight:800;margin:0 0 6px 0;">${inline(b.title, ctx, tc)}</p>` : '';
            const body = paragraphs(b.text).map((p) => `<p style="color:#333333;font-family:${FONT};font-size:14px;line-height:1.65;margin:0 0 8px 0;">${inline(p, ctx)}</p>`).join('');
            return row(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="note-pad" style="background-color:${bg};border:1px solid ${bd};border-radius:14px;padding:18px 20px 10px 20px;">${title}${body}</td></tr></table>`);
        }
        case 'list': {
            const items = (b.items || []).filter((x) => x?.trim());
            const rows = items.map((it, i) => `<tr><td width="26" valign="top" style="color:${RED};font-family:${FONT};font-size:15px;font-weight:800;line-height:1.7;padding:0 0 8px 0;">${b.ordered ? `${i + 1}.` : '&bull;'}</td><td valign="top" style="color:${BODY};font-family:${FONT};font-size:15px;line-height:1.7;padding:0 0 8px 0;">${inline(it, ctx)}</td></tr>`).join('');
            return row(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>`, '0 40px 14px 40px');
        }
        case 'references': {
            const title = `<p style="color:${INK};font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 10px 0;">${esc(b.title || 'References')}</p>`;
            const rows = (b.items || []).map((r) => {
                const n = refStart.n++;
                const link = r.url ? ` <a href="${attrUrl(r.url, ctx)}" target="_blank" style="color:${MUTED};text-decoration:underline;word-break:break-all;">${esc(r.url)}</a>` : '';
                return `<tr><td width="28" valign="top" style="color:${MUTED};font-family:${FONT};font-size:12px;line-height:1.6;padding:0 0 8px 0;">[${n}]</td><td valign="top" style="color:${MUTED};font-family:${FONT};font-size:12px;line-height:1.6;padding:0 0 8px 0;">${inline(r.text, ctx, MUTED)}${link}</td></tr>`;
            }).join('');
            return row(`${title}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>`, '6px 40px 18px 40px');
        }
        case 'signoff': {
            const lead = b.text ? `<p style="color:${BODY};font-family:${FONT};font-size:15px;line-height:1.7;margin:0 0 10px 0;">${inline(b.text, ctx)}</p>` : '';
            const role = b.role ? `<br><span style="color:${MUTED};font-weight:400;font-size:13px;">${inline(b.role, ctx)}</span>` : '';
            return row(`${lead}<p style="color:${INK};font-family:${FONT};font-size:15px;font-weight:700;line-height:1.5;margin:0;">${inline(b.name, ctx)}${role}</p>`, '4px 40px 26px 40px');
        }
        case 'divider':
            return `<tr><td style="padding:6px 40px 24px 40px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td height="1" bgcolor="#EEEEEE" style="height:1px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`;
        case 'spacer': {
            const h = Math.max(4, Math.min(80, Number(b.size) || 16));
            return `<tr><td height="${h}" style="height:${h}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;
        }
    }
    return '';
}

function blockText(b: EmailBlock, ctx: RenderContext, refStart: { n: number }): string {
    switch (b.type) {
        case 'heading': return [b.eyebrow ? plain(b.eyebrow, ctx).toUpperCase() : '', plain(b.text, ctx) + (b.accent ? ` ${plain(b.accent, ctx)}` : '')].filter(Boolean).join('\n');
        case 'text': return paragraphs(b.text).map((p) => plain(p, ctx)).join('\n\n');
        case 'image': return b.caption ? `[${plain(b.alt, ctx)}] ${plain(b.caption, ctx)}` : `[${plain(b.alt, ctx)}]`;
        case 'button': return `${plain(b.label, ctx)}: ${mergeTokens(b.url, ctx, false)}`;
        case 'storeBadges': return [b.ios ? `App Store: ${ctx.webUrl}/mobile/app/ios/` : '', b.android ? `Google Play: ${ctx.webUrl}/mobile/app/android/` : ''].filter(Boolean).join('\n');
        case 'icons': return b.caption ? plain(b.caption, ctx) : '';
        case 'quote': return `"${plain(b.text, ctx)}"${b.cite ? `\n  ${plain(b.cite, ctx)}${b.citeUrl ? ` (${b.citeUrl})` : ''}` : ''}`;
        case 'callout': return [b.title ? plain(b.title, ctx) : '', plain(b.text, ctx)].filter(Boolean).join('\n');
        case 'list': return (b.items || []).filter((x) => x?.trim()).map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${plain(it, ctx)}`).join('\n');
        case 'references': return [(b.title || 'References').toUpperCase(), ...(b.items || []).map((r) => `[${refStart.n++}] ${plain(r.text, ctx)}${r.url ? ` ${r.url}` : ''}`)].join('\n');
        case 'signoff': return [b.text ? plain(b.text, ctx) : '', plain(b.name, ctx) + (b.role ? `\n${plain(b.role, ctx)}` : '')].filter(Boolean).join('\n\n');
        case 'divider': return '---';
        case 'spacer': return '';
    }
    return '';
}

// ── document ─────────────────────────────────────────────────────────────

export function fromHeader(doc: EmailDoc): string {
    const name = (doc.fromName || 'Stationly').replace(/[<>"@]/g, '').trim() || 'Stationly';
    return `${name} <${FROM_ADDRESS}>`;
}

export function renderEmail(doc: EmailDoc, ctx: RenderContext): Rendered {
    const subject = `${ctx.subjectPrefix || ''}${plain(doc.subject || '', ctx)}`.trim();
    const preheader = plain(doc.preheader || '', ctx).trim();
    const isMarketing = doc.category === 'marketing';
    // Broadcasts always carry Resend's unsubscribe link (Resend manages the
    // list per contact), service ones included; direct service mail doesn't.
    const withUnsubscribe = isMarketing || ctx.mode === 'broadcast';

    const htmlRefs = { n: 1 };
    const body = (doc.blocks || []).map((b) => blockHtml(b, ctx, htmlRefs)).join('\n');
    const txtRefs = { n: 1 };
    const textBody = (doc.blocks || []).map((b) => blockText(b, ctx, txtRefs)).filter(Boolean).join('\n\n');

    const unsubscribe =
        !withUnsubscribe ? '' :
            ctx.mode === 'broadcast' ? '{{{RESEND_UNSUBSCRIBE_URL}}}' :
                ctx.unsubscribeUrl || '#unsubscribe-preview';

    const reason = withUnsubscribe
        ? `You're receiving this because you have a Stationly account. <a href="${unsubscribe === '{{{RESEND_UNSUBSCRIBE_URL}}}' ? unsubscribe : esc(unsubscribe)}" target="_blank" style="color:#999999;text-decoration:underline;">Unsubscribe</a> from Stationly news.`
        : `You're receiving this service update because you use Stationly.`;

    const bar = (g: string) => doc.header?.accentBars === false ? '' : `<tr><td height="4" style="height:4px;background-color:${RED};background:${g};font-size:0;line-height:0;">&nbsp;</td></tr>`;
    const logo = doc.header?.logo === false ? '' :
        `<tr><td class="col-pad" align="left" style="padding:34px 40px 18px 40px;"><img src="${esc(asset(ctx.baseUrl, '/assets/stationly_logo_final.png'))}" alt="Stationly" width="40" height="40" style="display:block;border:0;width:40px;height:40px;border-radius:10px;"></td></tr>`;
    const topPad = doc.header?.logo === false ? `<tr><td height="30" style="height:30px;font-size:0;line-height:0;">&nbsp;</td></tr>` : '';
    // Preheader text, padded so clients don't pull body text into the snippet.
    const pre = preheader
        ? `<div style="display:none;font-size:1px;color:#f0f0f0;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${esc(subject)}</title>
<!--[if mso]><style>table{border-collapse:collapse;}td,th,div,p,a,h1,h2,h3{font-family:sans-serif!important;}</style><![endif]-->
<style>
body { margin:0!important; padding:0!important; background-color:#f0f0f0!important; }
#bodyTable { background-color:#f0f0f0!important; }
a { color:${RED}; }
@media screen and (max-width:620px){
  .outer-cell { padding:0!important; }
  .container  { border-radius:0!important; width:100%!important; border-left:0!important; border-right:0!important; }
  .col-pad    { padding-left:22px!important; padding-right:22px!important; }
  .hero-title { font-size:26px!important; letter-spacing:-0.5px!important; }
  .btn-link   { display:block!important; text-align:center!important; }
  .note-pad   { padding:16px 16px 8px 16px!important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:#f0f0f0;-webkit-text-size-adjust:100%;">
${pre}
<table id="bodyTable" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f0f0f0" style="background-color:#f0f0f0;">
<tr><td class="outer-cell" align="center" style="padding:28px 16px 48px 16px;">
<!--[if mso]><table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table class="container" role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:22px;overflow:hidden;border:1px solid #E5E5E5;">
${bar('linear-gradient(90deg,#B91C22,#DD2C33 40%,#FF3E46 60%,#B91C22)')}
${logo}${topPad}
${body}
<tr><td height="12" style="height:12px;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td align="center" bgcolor="#FAFAFA" style="padding:20px 36px 26px 36px;background-color:#FAFAFA;border-top:1px solid #EEEEEE;">
<p style="color:#999999;font-family:${FONT};font-size:12px;line-height:1.7;margin:0 0 8px 0;">${reason}</p>
<p style="color:#AAAAAA;font-family:${FONT};font-size:12px;line-height:1.7;margin:0;">&copy; ${new Date().getUTCFullYear()} Stationly Ltd &nbsp;&middot;&nbsp; London, UK<br><a href="${esc(ctx.webUrl)}/privacy" target="_blank" style="color:#BBBBBB;text-decoration:none;">Privacy Policy</a> &nbsp;&middot;&nbsp; <a href="${esc(ctx.webUrl)}/terms" target="_blank" style="color:#BBBBBB;text-decoration:none;">Terms</a></p>
</td></tr>
${bar('linear-gradient(90deg,#B91C22,#DD2C33 50%,#B91C22)')}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;

    const footerText = withUnsubscribe
        ? `You're receiving this because you have a Stationly account. Unsubscribe: ${unsubscribe}`
        : `You're receiving this service update because you use Stationly.`;
    const text = `${textBody}\n\n--\n${footerText}\nStationly Ltd, London, UK\n${ctx.webUrl}/privacy`;

    return { subject, preheader, from: fromHeader(doc), html, text };
}

/**
 * A first name fit to greet someone with, or '' when the account has none
 * worth using (placeholder names, an email typed as a name, Apple's
 * hidden-email accounts without a name).
 */
export function firstNameOf(displayName: string | undefined, email?: string): string {
    const name = String(displayName || '').trim();
    if (!name || /^stationly user$/i.test(name) || name.includes('@')) return '';
    const first = name.split(/\s+/)[0];
    if (!first || first.length > 30 || /\d/.test(first)) return '';
    if (email && first.toLowerCase() === email.split('@')[0].toLowerCase()) return '';
    return first.charAt(0).toUpperCase() + first.slice(1);
}
