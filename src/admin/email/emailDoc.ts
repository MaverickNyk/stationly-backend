/**
 * The email document the admin console edits: a subject line, a header and a
 * list of blocks. Stored as JSON on the campaign; rendered to HTML + text by
 * `emailRender.ts` (the ONLY place that turns it into markup, so the preview,
 * the test send and the real send can never disagree).
 *
 * Text fields accept a small, safe subset of Markdown (`**bold**`, `*italic*`,
 * `[label](https://…)`, line breaks, blank-line paragraphs) and merge tokens
 * (`{{first_name}}`, `{{first_name|there}}`, `{{email}}`, `{{station}}`).
 * Raw HTML is never accepted: everything is escaped before formatting.
 */

export type EmailCategory = 'service' | 'marketing';
export type Align = 'left' | 'center';

export type EmailBlock =
    | { id: string; type: 'heading'; text: string; eyebrow?: string; size?: 'xl' | 'lg' | 'md'; align?: Align; accent?: string }
    | { id: string; type: 'text'; text: string; size?: 'md' | 'sm'; tone?: 'default' | 'muted'; align?: Align }
    | { id: string; type: 'image'; url: string; alt: string; href?: string; width?: number; rounded?: boolean; caption?: string; align?: Align }
    | { id: string; type: 'button'; label: string; url: string; variant?: 'primary' | 'dark' | 'outline'; align?: Align }
    | { id: string; type: 'storeBadges'; ios: boolean; android: boolean; align?: Align; caption?: string }
    | { id: string; type: 'icons'; items: IconName[]; size?: number; align?: Align; caption?: string }
    | { id: string; type: 'quote'; text: string; cite?: string; citeUrl?: string }
    | { id: string; type: 'callout'; text: string; title?: string; tone?: 'info' | 'warning' | 'success' | 'note' }
    | { id: string; type: 'list'; items: string[]; ordered?: boolean }
    | { id: string; type: 'references'; title?: string; items: Array<{ text: string; url?: string }> }
    | { id: string; type: 'signoff'; name: string; role?: string; text?: string }
    | { id: string; type: 'divider' }
    | { id: string; type: 'spacer'; size?: number };

export type BlockType = EmailBlock['type'];

/** Icons served from the backend's own public folder (`/icons`, `/assets`). */
export const ICONS = {
    logo: { path: '/assets/stationly_logo_final.png', label: 'Stationly' },
    tube: { path: '/icons/tube.png', label: 'Tube' },
    bus: { path: '/icons/bus.png', label: 'Bus' },
    dlr: { path: '/icons/dlr.png', label: 'DLR' },
    elizabeth: { path: '/icons/elizabeth.png', label: 'Elizabeth line' },
    overground: { path: '/icons/overground.png', label: 'Overground' },
    apple: { path: '/assets/apple_logo.png', label: 'Apple' },
    android: { path: '/assets/android_head_3d.png', label: 'Android' },
} as const;
export type IconName = keyof typeof ICONS;

export interface EmailHeader {
    /** Stationly logo above the content. */
    logo: boolean;
    /** The red bars top and bottom of the card. */
    accentBars: boolean;
}

export interface EmailDoc {
    subject: string;
    /** The grey line inboxes show after the subject. */
    preheader?: string;
    fromName: string;
    replyTo?: string;
    category: EmailCategory;
    header: EmailHeader;
    blocks: EmailBlock[];
}

export const MERGE_FIELDS = [
    { token: '{{first_name}}', label: 'First name', note: 'Falls back to "there". Use {{first_name|friend}} for another fallback.', broadcast: true },
    { token: '{{email}}', label: 'Email address', note: '', broadcast: true },
    { token: '{{station}}', label: 'Matched station(s)', note: 'Only with a station filter, and only for direct sends (not broadcasts).', broadcast: false },
];

export const FROM_ADDRESS = 'info@stationly.co.uk';

export function emptyDoc(): EmailDoc {
    return {
        subject: '',
        preheader: '',
        fromName: 'Stationly',
        category: 'service',
        header: { logo: true, accentBars: true },
        blocks: [],
    };
}

const BLOCK_TYPES: BlockType[] = [
    'heading', 'text', 'image', 'button', 'storeBadges', 'icons', 'quote',
    'callout', 'list', 'references', 'signoff', 'divider', 'spacer',
];

const URL_OK = /^(https?:\/\/|mailto:)/i;
const TOKEN_ONLY = /^\{\{[a-z_]+(\|[^}]*)?\}\}$/i;

/** True for a link target we are willing to put in an email. */
export function isSafeUrl(u: string | undefined): boolean {
    if (!u) return false;
    const s = u.trim();
    return URL_OK.test(s) || TOKEN_ONLY.test(s);
}

/**
 * Structural validation. Returns problems as readable strings (empty = fine).
 * `mode` adds the rules that only apply to one way of sending.
 */
export function validateDoc(doc: EmailDoc, opts?: { mode?: 'direct' | 'broadcast' }): string[] {
    const problems: string[] = [];
    if (!doc || typeof doc !== 'object') return ['The email is empty.'];
    if (!doc.subject || !doc.subject.trim()) problems.push('Add a subject line.');
    if (doc.subject && doc.subject.length > 150) problems.push('The subject is longer than 150 characters.');
    if (!doc.fromName || !doc.fromName.trim()) problems.push('Add a sender name.');
    if (/[<>"@]/.test(doc.fromName || '')) problems.push('The sender name cannot contain < > " or @.');
    if (doc.replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.replyTo)) problems.push('The reply-to address is not a valid email.');
    if (doc.category !== 'service' && doc.category !== 'marketing') problems.push('Pick a category: service or marketing.');
    if (!Array.isArray(doc.blocks) || doc.blocks.length === 0) problems.push('Add at least one block of content.');

    for (const [i, b] of (doc.blocks || []).entries()) {
        const at = `Block ${i + 1} (${(b as any)?.type ?? '?'})`;
        if (!b || !BLOCK_TYPES.includes(b.type)) { problems.push(`${at}: unknown block.`); continue; }
        switch (b.type) {
            case 'heading': if (!b.text?.trim()) problems.push(`${at}: empty heading.`); break;
            case 'text': if (!b.text?.trim()) problems.push(`${at}: empty text.`); break;
            case 'image':
                if (!isSafeUrl(b.url)) problems.push(`${at}: image needs an https URL (upload one, or paste a link).`);
                if (!b.alt?.trim()) problems.push(`${at}: add alt text (shown when images are blocked).`);
                if (b.href && !isSafeUrl(b.href)) problems.push(`${at}: the image link must start with https:// or mailto:.`);
                break;
            case 'button':
                if (!b.label?.trim()) problems.push(`${at}: button needs a label.`);
                if (!isSafeUrl(b.url)) problems.push(`${at}: button link must start with https:// or mailto:.`);
                break;
            case 'storeBadges': if (!b.ios && !b.android) problems.push(`${at}: pick at least one store.`); break;
            case 'icons': if (!b.items?.length || b.items.some((n) => !(n in ICONS))) problems.push(`${at}: pick icons from the list.`); break;
            case 'quote':
                if (!b.text?.trim()) problems.push(`${at}: empty quote.`);
                if (b.citeUrl && !isSafeUrl(b.citeUrl)) problems.push(`${at}: the source link must start with https://.`);
                break;
            case 'callout': if (!b.text?.trim()) problems.push(`${at}: empty callout.`); break;
            case 'list': if (!b.items?.some((x) => x?.trim())) problems.push(`${at}: the list has no items.`); break;
            case 'references':
                if (!b.items?.length) problems.push(`${at}: add at least one reference.`);
                for (const r of b.items || []) if (r.url && !isSafeUrl(r.url)) problems.push(`${at}: reference links must start with https://.`);
                break;
            case 'signoff': if (!b.name?.trim()) problems.push(`${at}: add a name.`); break;
        }
    }

    if (opts?.mode === 'broadcast') {
        const all = JSON.stringify(doc);
        const bad = [...new Set((all.match(/\{\{\s*([a-z_]+)/gi) || []).map((m) => m.replace(/[{\s]/g, '').toLowerCase()))]
            .filter((t) => !['first_name', 'email'].includes(t));
        if (bad.length) problems.push(`Broadcasts can only personalise {{first_name}} and {{email}}. Remove: ${bad.map((t) => `{{${t}}}`).join(', ')}, or send directly.`);
        // Resend documents contact placeholders for the BODY; keep the subject
        // and preview text plain so they can't arrive with raw braces.
        if (/\{\{/.test(`${doc.subject || ''} ${doc.preheader || ''}`)) problems.push('In a broadcast, keep personal fields like {{first_name}} out of the subject and preview text.');
    }
    return problems;
}
