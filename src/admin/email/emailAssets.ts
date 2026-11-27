/**
 * Images for emails, uploaded from the admin console.
 *
 * Same master/slave idea as the rest of the backend:
 *   - Firestore `email_assets/<id>` is the master (image bytes ≤ ~900 KB, so a
 *     doc never nears the 1 MiB limit), so an image survives deploys and is
 *     shared by every server.
 *   - `data/email-assets/<id>.<ext>` on disk is the cache. A request is served
 *     from disk; only the first request after a deploy reads Firestore (1 read).
 *   - Served at `/api/v1/email-assets/<id>.<ext>` (nginx only forwards
 *     /api/v1), immutable, so Cloudflare and Gmail's image proxy cache it and
 *     opens cost nothing.
 *
 * Uploads are re-encoded with sharp: rotated by EXIF, at most 1200 px wide,
 * metadata stripped, JPEG (or PNG when transparent).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type sharpType from 'sharp';
import * as admin from 'firebase-admin';
import { db } from '../../config/firebase';
import { getBaseUrl } from '../../utils/formatters';

const DIR = path.resolve(process.cwd(), 'data', 'email-assets');
const MAX_INPUT = 10 * 1024 * 1024;
const MAX_STORED = 900 * 1024;
const ID_RE = /^[a-f0-9]{24}$/;

export interface EmailAsset {
    id: string;
    url: string;
    name: string;
    mime: string;
    width: number;
    height: number;
    bytes: number;
    createdAt?: number;
}

function ext(mime: string) { return mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : 'jpg'; }
function urlFor(id: string, mime: string) { return `${getBaseUrl()}/api/v1/email-assets/${id}.${ext(mime)}`; }

function writeDisk(id: string, mime: string, buf: Buffer) {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(path.join(DIR, `${id}.${ext(mime)}`), buf);
    } catch (e: any) {
        console.warn('[EmailAssets] disk cache write failed', e?.message || e);
    }
}

export class EmailAssets {
    /** `dataUrl` = "data:image/png;base64,…". */
    static async upload(dataUrl: string, name: string): Promise<EmailAsset> {
        // Loaded here, not at the top: a native module failing to load must
        // only break image uploads, never the server's startup.
        const sharp: typeof sharpType = (await import('sharp')).default;
        const m = /^data:(image\/(png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(String(dataUrl || ''));
        if (!m) throw Object.assign(new Error('Upload a PNG, JPEG, WebP or GIF image.'), { status: 400 });
        const input = Buffer.from(m[3], 'base64');
        if (input.length > MAX_INPUT) throw Object.assign(new Error('Images must be under 10 MB.'), { status: 413 });

        let out: Buffer;
        let mime: string;
        let info: sharpType.OutputInfo;
        const isGif = /gif/i.test(m[2]);
        if (isGif) {
            // Animated GIFs are kept as they are (sharp would flatten them).
            if (input.length > MAX_STORED) throw Object.assign(new Error('GIFs must be under 900 KB.'), { status: 413 });
            const meta = await sharp(input).metadata();
            out = input; mime = 'image/gif';
            info = { width: meta.width || 0, height: meta.pageHeight || meta.height || 0, size: input.length } as sharpType.OutputInfo;
        } else {
            const meta = await sharp(input).metadata();
            const transparent = !!meta.hasAlpha;
            let width = Math.min(1200, meta.width || 1200);
            let quality = 84;
            for (;;) {
                const pipe = sharp(input).rotate().resize({ width, withoutEnlargement: true });
                const r = transparent
                    ? await pipe.png({ compressionLevel: 9, palette: quality < 84 }).toBuffer({ resolveWithObject: true })
                    : await pipe.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
                out = r.data; info = r.info;
                mime = transparent ? 'image/png' : 'image/jpeg';
                if (out.length <= MAX_STORED || width <= 400) break;
                width = Math.round(width * 0.8); quality = Math.max(60, quality - 8);
            }
            if (out.length > MAX_STORED) throw Object.assign(new Error('That image is too large even after resizing.'), { status: 413 });
        }

        const id = crypto.createHash('sha256').update(out).digest('hex').slice(0, 24);
        const clean = String(name || 'image').replace(/[^\w .-]/g, '').slice(0, 80) || 'image';
        await db.collection('email_assets').doc(id).set({
            name: clean, mime, width: info.width, height: info.height, bytes: out.length,
            data: out, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        writeDisk(id, mime, out);
        return { id, url: urlFor(id, mime), name: clean, mime, width: info.width, height: info.height, bytes: out.length };
    }

    /** Recent uploads, without the bytes. */
    static async list(limit = 60): Promise<EmailAsset[]> {
        const snap = await db.collection('email_assets').orderBy('createdAt', 'desc').limit(limit)
            .select('name', 'mime', 'width', 'height', 'bytes', 'createdAt').get();
        return snap.docs.map((d) => ({
            id: d.id, url: urlFor(d.id, d.get('mime')), name: d.get('name'), mime: d.get('mime'),
            width: d.get('width'), height: d.get('height'), bytes: d.get('bytes'),
            createdAt: d.get('createdAt')?.toMillis?.() ?? 0,
        }));
    }

    /** For the public route: disk first, then Firestore (and refill the disk). */
    static async read(file: string): Promise<{ buf: Buffer; mime: string } | null> {
        const m = /^([a-f0-9]{24})\.(png|jpg|gif)$/.exec(file);
        if (!m || !ID_RE.test(m[1])) return null;
        const mime = m[2] === 'png' ? 'image/png' : m[2] === 'gif' ? 'image/gif' : 'image/jpeg';
        const p = path.join(DIR, file);
        try { return { buf: fs.readFileSync(p), mime }; } catch { /* not cached yet */ }
        const doc = await db.collection('email_assets').doc(m[1]).get();
        if (!doc.exists) return null;
        const data = doc.get('data');
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data?.toUint8Array?.() ?? data ?? []);
        if (!buf.length) return null;
        writeDisk(m[1], doc.get('mime') || mime, buf);
        return { buf, mime: doc.get('mime') || mime };
    }
}
