import axios from 'axios';
import * as crypto from 'crypto';

/**
 * Cloudflare Access JWT verification — defence-in-depth layer that runs
 * AFTER the admin-key check in {@link AdminAuthMiddleware}.
 *
 * When the admin app sits behind Cloudflare Access, every request that
 * passes the Access login wall (or a Service Token) arrives at the origin
 * carrying a signed assertion in the `Cf-Access-Jwt-Assertion` header.
 * Verifying it here means the backend trusts ONLY requests that Cloudflare
 * itself authenticated — so even someone who finds the raw origin IP and
 * holds a leaked `STATIONLY_ADMIN_KEY` still can't call admin endpoints:
 * they can't forge a Cloudflare-signed JWT.
 *
 * This is OPT-IN. It only kicks in when both env vars are set:
 *   - `CF_ACCESS_TEAM_DOMAIN`  e.g. `stationly.cloudflareaccess.com`
 *     (or the bare team name `stationly` — we normalise either form)
 *   - `CF_ACCESS_AUD`          the Application Audience (AUD) tag from the
 *                              Access application's settings
 * If either is unset, verification is skipped and only the admin key
 * gates the route (keeps existing/local deploys working unchanged).
 *
 * No new dependency: we fetch the JWKS with axios (already used elsewhere)
 * and verify the RS256 signature with Node's built-in `crypto`, importing
 * each JWK directly via `createPublicKey({ format: 'jwk' })`.
 */

interface Jwk {
    kid: string;
    kty: string;
    alg?: string;
    use?: string;
    n: string;
    e: string;
}

interface JwksCacheEntry {
    keys: Jwk[];
    fetchedAt: number;
}

// Cache the team's signing keys — Cloudflare rotates them rarely. 10 min
// TTL keeps us fresh without hammering the certs endpoint on every request.
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: JwksCacheEntry | null = null;

/** Returns the configured issuer base (https://<team>.cloudflareaccess.com) or null. */
export function cfAccessIssuer(): string | null {
    const raw = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
    if (!raw) return null;
    // Accept "stationly", "stationly.cloudflareaccess.com", or a full URL.
    let host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!host.includes('.')) host = `${host}.cloudflareaccess.com`;
    return `https://${host}`;
}

/** True when both team domain and AUD are configured — i.e. CF Access enforcement is on. */
export function cfAccessEnabled(): boolean {
    return !!cfAccessIssuer() && !!process.env.CF_ACCESS_AUD?.trim();
}

function base64UrlDecode(input: string): Buffer {
    return Buffer.from(input, 'base64url');
}

async function getJwks(issuer: string): Promise<Jwk[]> {
    const now = Date.now();
    if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
        return jwksCache.keys;
    }
    const url = `${issuer}/cdn-cgi/access/certs`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const keys: Jwk[] = Array.isArray(data?.keys) ? data.keys : [];
    if (keys.length === 0) throw new Error('CF Access JWKS returned no keys');
    jwksCache = { keys, fetchedAt: now };
    return keys;
}

export interface AccessIdentity {
    email?: string;
    sub?: string;
    /** Present for Service Token auth (machine-to-machine, e.g. the admin app proxy). */
    common_name?: string;
}

/**
 * Verify a Cloudflare Access JWT. Throws on any failure (bad signature,
 * wrong audience/issuer, expired). Returns the decoded identity on success.
 */
export async function verifyAccessJwt(token: string): Promise<AccessIdentity> {
    const issuer = cfAccessIssuer();
    const aud = process.env.CF_ACCESS_AUD?.trim();
    if (!issuer || !aud) throw new Error('CF Access not configured');

    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed JWT');
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(base64UrlDecode(headerB64).toString('utf-8'));
    if (header.alg !== 'RS256') throw new Error(`Unexpected JWT alg: ${header.alg}`);
    if (!header.kid) throw new Error('JWT missing kid');

    const keys = await getJwks(issuer);
    const jwk = keys.find(k => k.kid === header.kid);
    if (!jwk) throw new Error('No matching JWKS key for kid');

    // Import the JWK directly and verify the RS256 signature over
    // `<header>.<payload>` (the standard JWS signing input).
    const pubKey = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
    const signingInput = `${headerB64}.${payloadB64}`;
    const ok = crypto.verify(
        'RSA-SHA256',
        Buffer.from(signingInput),
        pubKey,
        base64UrlDecode(sigB64),
    );
    if (!ok) throw new Error('JWT signature verification failed');

    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf-8'));

    // Issuer must match exactly.
    if (payload.iss !== issuer) throw new Error('JWT issuer mismatch');

    // AUD can be a string or array; the configured tag must be present.
    const audClaim = payload.aud;
    const audMatch = Array.isArray(audClaim) ? audClaim.includes(aud) : audClaim === aud;
    if (!audMatch) throw new Error('JWT audience mismatch');

    // Expiry (exp) is seconds since epoch. Allow 30s clock skew.
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp + 30 < nowSec) {
        throw new Error('JWT expired');
    }

    return {
        email: payload.email,
        sub: payload.sub,
        common_name: payload.common_name,
    };
}
