/**
 * Tiny stateless session: a signed, httpOnly cookie. The value is
 * `<expiry-ms>.<hmac>` where the HMAC is over the expiry using
 * `SESSION_SECRET`. No server-side store needed.
 *
 * Uses Web Crypto (`crypto.subtle`) so the SAME verify path runs in both
 * the Edge middleware and Node route handlers.
 *
 * This is the app-level login gate — a second factor on top of Cloudflare
 * Access (the real perimeter). It is NOT where the admin key lives.
 */

const COOKIE_NAME = 'stationly_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function encode(s: string): BufferSource {
  return new TextEncoder().encode(s) as unknown as BufferSource;
}

async function hmac(message: string): Promise<string> {
  const secret = process.env.SESSION_SECRET || '';
  const key = await crypto.subtle.importKey(
    'raw',
    encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encode(message));
  return Buffer.from(new Uint8Array(sig)).toString('base64url');
}

export async function createSessionValue(): Promise<string> {
  const expiry = (Date.now() + SESSION_TTL_MS).toString();
  const sig = await hmac(expiry);
  return `${expiry}.${sig}`;
}

export async function isValidSessionValue(value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const dot = value.lastIndexOf('.');
  if (dot < 0) return false;
  const expiry = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expiryNum = Number(expiry);
  if (!Number.isFinite(expiryNum) || expiryNum < Date.now()) return false;

  const expected = await hmac(expiry);
  // Constant-time-ish compare (lengths equal for same algo output).
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_MAX_AGE_S = Math.floor(SESSION_TTL_MS / 1000);
