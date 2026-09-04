import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getBaseUrl } from '../utils/formatters';

/**
 * Versioned URLs for the files under `public/assets`.
 *
 * ## The problem this solves
 * Clients cache these on the device so a help screen does not re-download a
 * 1.5 MB video every time somebody opens it. That caching has to invalidate
 * when the file changes and at no other time, and the only honest signal for
 * "changed" is the bytes.
 *
 * ## Why the version is a content hash and not a number in a constant
 * A hand-bumped constant is a step somebody forgets, and the failure is silent:
 * a new recording deploys, every device keeps playing the old one, and nothing
 * anywhere reports a problem. Hashing the file means the URL changes exactly
 * when the content does. Replace the file, deploy, and every client picks it up
 * on its next fetch with no other edit.
 *
 * ## Why the version rides in the query string
 * `.../widget_stack.mp4?v=6a1f9c2b` keeps one canonical path on disk, so the
 * asset can be replaced in place. The client caches on the FULL url, so a new
 * version is simply a cache miss. It also makes any CDN or browser cache in
 * between do the right thing for free.
 *
 * Hashes are memoised on the file's mtime and size, so a request costs a `stat`
 * rather than a read. A file replaced in place changes both.
 */

const ASSET_DIR = path.join(process.cwd(), 'public', 'assets');

interface CacheEntry {
    version: string;
    mtimeMs: number;
    size: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Short content hash for one asset, or `dev` when the file cannot be read.
 *
 * A missing file is NOT fatal here. This runs while building a layout response,
 * and an asset that has not been deployed yet should degrade to a URL that 404s
 * (which the client already renders as an empty media box) rather than take the
 * whole screen down with it.
 */
export function assetVersion(name: string): string {
    const file = path.join(ASSET_DIR, name);
    try {
        const stat = fs.statSync(file);
        const hit = cache.get(name);
        if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
            return hit.version;
        }
        const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
        const version = hash.slice(0, 8);
        cache.set(name, { version, mtimeMs: stat.mtimeMs, size: stat.size });
        return version;
    } catch {
        return 'dev';
    }
}

/** Absolute, versioned URL for an asset under `public/assets`. */
export function assetUrl(name: string): string {
    return `${getBaseUrl()}/assets/${name}?v=${assetVersion(name)}`;
}
