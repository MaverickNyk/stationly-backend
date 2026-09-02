import crypto from 'crypto';

/**
 * Stripe webhook signature verification — dependency-free.
 *
 * ## Why hand-rolled and not the `stripe` SDK
 * The rest of this backend verifies its own credentials the same way — the
 * Cloudflare-Access JWT check (`verifyAccessJwt`), the internal-ingest secret
 * (`constantTimeEquals` in `internalRoutes.ts`), the admin key. Stripe's scheme
 * is small, stable, and fully specified, and keeping it in-tree means the
 * signature path is auditable in one screen and testable with `assert` and no
 * mocking. Adding the SDK (a large transitive tree) to gate one route was the
 * worse trade.
 *
 * ## The scheme (Stripe docs: "Verify webhook signatures manually")
 *   Header `Stripe-Signature: t=<unix-seconds>,v1=<hex>,v1=<hex>,v0=<hex>`
 *   signed_payload = `${t}.${raw_request_body}`
 *   expected       = HMAC-SHA256(signed_payload, webhook_signing_secret) as hex
 *   accept iff a constant-time compare matches ANY `v1` entry
 *   AND |now - t| <= tolerance  (replay protection)
 *
 * `v0` is Stripe's older test-mode scheme and is intentionally NOT accepted —
 * only `v1`.
 *
 * ## Failure posture
 * Every rejection returns `{ ok: false, reason }`. The `reason` is for the
 * server log only; the route answers the caller a bare `400` with no detail, so
 * a probe cannot learn which check it tripped.
 */

export type StripeSigResult =
    | { ok: true; timestamp: number }
    | { ok: false; reason: string };

export interface StripeSigOptions {
    /** Max seconds of clock skew between `t` and now, either direction. Default 300 (Stripe's own default). */
    toleranceSec?: number;
    /** Injectable clock for tests. Milliseconds since epoch. */
    nowMs?: number;
}

const DEFAULT_TOLERANCE_SEC = 300;

interface ParsedHeader {
    t?: string;
    v1: string[];
}

/**
 * Parse `t=...,v1=...,v1=...` into its parts. Unknown schemes (`v0`, future
 * `vN`) are ignored rather than rejected, so a scheme addition on Stripe's side
 * cannot break a verifier that already has a valid `v1` to check.
 */
function parseSignatureHeader(header: string): ParsedHeader {
    const out: ParsedHeader = { v1: [] };
    for (const part of header.split(',')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (key === 't') out.t = val;
        else if (key === 'v1' && val) out.v1.push(val);
    }
    return out;
}

/**
 * Compare two hex strings in constant time. A length mismatch is an immediate
 * `false` — `timingSafeEqual` throws on unequal lengths, and the length of a
 * SHA-256 hex digest is not a secret anyway.
 */
function hexEqualsConstantTime(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let ab: Buffer;
    let bb: Buffer;
    try {
        ab = Buffer.from(a, 'hex');
        bb = Buffer.from(b, 'hex');
    } catch {
        return false;
    }
    if (ab.length === 0 || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a Stripe webhook signature.
 *
 * @param rawBody  The EXACT bytes Stripe POSTed. Must be the raw request body,
 *                 not a re-serialised parse — `express.raw()` on the route is
 *                 what makes this available (a `JSON.parse` → `JSON.stringify`
 *                 round-trip reorders keys and the HMAC no longer matches).
 * @param sigHeader The `Stripe-Signature` request header, verbatim.
 * @param secret   The webhook endpoint's signing secret (`whsec_...`).
 */
export function verifyStripeSignature(
    rawBody: Buffer | string,
    sigHeader: string | undefined | null,
    secret: string | undefined | null,
    opts: StripeSigOptions = {},
): StripeSigResult {
    if (!secret) return { ok: false, reason: 'signing secret not configured' };
    if (!sigHeader) return { ok: false, reason: 'missing Stripe-Signature header' };

    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    if (bodyBuf.length === 0) return { ok: false, reason: 'empty request body' };

    const parsed = parseSignatureHeader(sigHeader);
    if (!parsed.t) return { ok: false, reason: 'no timestamp (t=) in signature header' };
    if (parsed.v1.length === 0) return { ok: false, reason: 'no v1 signature in header' };

    const t = Number(parsed.t);
    if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: 'non-numeric timestamp' };

    const toleranceSec = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSec - t) > toleranceSec) {
        // Covers both a replay of an old event and a spoofed future timestamp.
        return { ok: false, reason: `timestamp outside tolerance (|${nowSec - t}s| > ${toleranceSec}s)` };
    }

    // signed_payload = "<t>.<raw body>". Build it as bytes so a multibyte body
    // hashes identically to how Stripe hashed it.
    const signedPayload = Buffer.concat([
        Buffer.from(`${parsed.t}.`, 'utf8'),
        bodyBuf,
    ]);
    const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

    for (const candidate of parsed.v1) {
        if (hexEqualsConstantTime(candidate, expected)) {
            return { ok: true, timestamp: t };
        }
    }
    return { ok: false, reason: 'no v1 signature matched' };
}

/**
 * Build a `Stripe-Signature` header for a body + secret. TEST HELPER ONLY —
 * exported so the regression suite can exercise `verifyStripeSignature` without
 * a live Stripe endpoint. Never called by production code.
 */
export function signPayloadForTest(
    rawBody: Buffer | string,
    secret: string,
    timestampSec: number,
    scheme: 'v1' | 'v0' = 'v1',
): string {
    const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const signedPayload = Buffer.concat([Buffer.from(`${timestampSec}.`, 'utf8'), bodyBuf]);
    const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return `t=${timestampSec},${scheme}=${sig}`;
}
