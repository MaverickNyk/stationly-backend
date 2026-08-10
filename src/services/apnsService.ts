import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import http2, { ClientHttp2Session } from 'http2';

/**
 * Direct Apple Push Notification service client.
 *
 * ## Why this exists rather than sending through FCM
 * FCM was the transport for iOS, and it is a relay: it holds an APNs
 * connection on our behalf and forwards. That was fine while iOS wanted the
 * same topic-broadcast pushes Android does, and it stopped being fine for two
 * reasons.
 *
 * The first is that iOS no longer uses FCM at all — the client's Firebase
 * Messaging dependency is gone, so there is no FCM registration token on an
 * iPhone to address.
 *
 * The second is the one that actually forced it: **FCM cannot send a WidgetKit
 * push.** The `widgets` push type addresses a token issued to the widget
 * EXTENSION and reloads it without waking the app, on a budget separate from
 * both the timeline quota and the background-push quota. It is the only way to
 * update a widget promptly without spending the thing we are trying to
 * conserve, and reaching it requires talking to APNs ourselves.
 *
 * ## Authentication
 * Token-based (a `.p8` auth key), not certificate-based. One key works for
 * every app under the team and never expires, where certificates are per-app
 * and expire annually — an expiry that would present as pushes silently
 * stopping.
 *
 * The JWT is ES256 over `{iss: teamId, iat: now}` with the key id in the
 * header. Apple accepts one for an hour and rejects a token refreshed more
 * often than every 20 minutes, so it is cached; see [bearer].
 *
 * ## Environment
 * A device's token belongs to exactly ONE environment. A development build
 * (Xcode, or any build signed with a development profile) gets a sandbox token
 * that the production host rejects with `BadDeviceToken`, and vice versa. That
 * is the single most common reason a correct-looking push never arrives, so the
 * environment travels WITH the token in the registry rather than being a global
 * setting.
 */

export type ApnsEnvironment = 'production' | 'sandbox';

/** Which Apple push mechanism to use. */
export type ApnsPushType =
    /** Reloads a widget's timeline directly, WITHOUT launching the app.
     *  iOS 26+, and the token comes from the widget extension. */
    | 'widgets'
    /** Silent wake of the app (`content-available: 1`). Works back to iOS 17,
     *  but is gated on the user's Background App Refresh switch and is
     *  throttled by the system. */
    | 'background'
    /** A user-visible notification. */
    | 'alert';

export interface ApnsSendOptions {
    token: string;
    environment: ApnsEnvironment;
    pushType: ApnsPushType;
    payload: Record<string, unknown>;
    /**
     * Coalescing key, max 64 bytes. Pushes sharing one are collapsed by APNs to
     * the most recent — so a line melting down and emitting a disruption update
     * every few seconds costs a device ONE wake rather than dozens. Strongly
     * recommended for anything triggered by upstream events.
     */
    collapseId?: string;
    /**
     * 10 = immediate, 5 = system-scheduled (power-considerate). Apple REQUIRES
     * 5 for `background`; sending 10 on a background push is rejected outright.
     * Defaults are picked per push type below.
     */
    priority?: 5 | 10;
    /** Seconds. 0 = deliver once or discard. Defaults to 1 hour — a stale
     *  "refresh your board" is worth nothing, so never store-and-forward it far. */
    expirationSeconds?: number;
}

export interface ApnsSendResult {
    token: string;
    ok: boolean;
    status?: number;
    /** Apple's machine-readable reason, e.g. `BadDeviceToken`, `Unregistered`. */
    reason?: string;
    /** True when Apple says this token is dead and should be dropped from the
     *  registry — see [isPermanentFailure]. */
    shouldUnregister?: boolean;
}

const HOSTS: Record<ApnsEnvironment, string> = {
    production: 'https://api.push.apple.com',
    sandbox: 'https://api.sandbox.push.apple.com',
};

/** Refresh well inside Apple's 60-minute validity, and well outside its
 *  20-minute minimum refresh interval. */
const TOKEN_TTL_MS = 45 * 60 * 1000;

/** Reasons that mean "this token will never work again" as opposed to "try
 *  later". Only these prune the registry — treating a transient 503 as a dead
 *  token would quietly unregister a working device. */
const PERMANENT_FAILURES = new Set([
    'BadDeviceToken',
    'Unregistered',
    'DeviceTokenNotForTopic',
    'TopicDisallowed',
    'BadTopic',
]);

export class ApnsService {

    private static cachedToken: { jwt: string; at: number } | null = null;
    /** One HTTP/2 session per environment, kept open. APNs explicitly asks
     *  senders to reuse connections; a fresh TLS handshake per push is both
     *  slow and, at volume, something Apple will throttle. */
    private static sessions = new Map<ApnsEnvironment, ClientHttp2Session>();

    /** Whether the service is configured at all. Everything below no-ops
     *  cleanly when it is not, so a deploy without the key still boots and
     *  every other endpoint keeps working. */
    static isConfigured(): boolean {
        return Boolean(this.keyId() && this.teamId() && this.privateKey());
    }

    private static keyId(): string { return process.env.APNS_KEY_ID ?? ''; }
    private static teamId(): string { return process.env.APNS_TEAM_ID ?? ''; }
    /** The app's bundle id — the base for every `apns-topic`. */
    static bundleId(): string {
        return process.env.APNS_BUNDLE_ID ?? 'com.stationly.mobile';
    }

    /**
     * The `.p8` private key.
     *
     * ## Path first, and that is not just a preference
     * `APNS_P8_PATH` points at a file deployed out of band, exactly as
     * `FIREBASE_KEY_PATH` already does. That convention exists because the
     * deploy script ECHOES every env override it writes — so an inline key
     * would print the whole private key into the deploy log, and from there
     * into terminal scrollback and CI output. A path prints a path.
     *
     * The key also has no expiry and works for every app under the team, so a
     * leak is not something that ages out on its own: it would have to be
     * revoked in the developer console and rotated everywhere.
     *
     * `APNS_P8` inline is still honoured as a fallback for environments with no
     * writable filesystem. Newlines in env vars are routinely mangled by
     * shells and process managers, so a `\n`-escaped single line is accepted
     * and un-escaped here — that mangling otherwise surfaces as an opaque
     * "error:0909006C: PEM routines" at the first send.
     */
    private static privateKey(): string {
        if (this.cachedKey !== null) return this.cachedKey;

        const path = process.env.APNS_P8_PATH;
        if (path) {
            try {
                this.cachedKey = readFileSync(path, 'utf8');
                return this.cachedKey;
            } catch (error) {
                // Logged rather than thrown: a missing key must degrade to
                // "push not configured" (every caller already handles that),
                // not take down a process that serves boards perfectly well
                // without it.
                console.error(`APNS: ❌ could not read APNS_P8_PATH (${path})`, error);
            }
        }
        this.cachedKey = (process.env.APNS_P8 ?? '').replace(/\\n/g, '\n');
        return this.cachedKey;
    }

    /** Read once. The file does not change under a running process, and the
     *  JWT signer asks for this on every token refresh. */
    private static cachedKey: string | null = null;

    /**
     * A cached, signed ES256 bearer token.
     *
     * `dsaEncoding: 'ieee-p1363'` is load-bearing: Node signs ECDSA as DER by
     * default, and JWS requires the raw r‖s pair. With DER, every push comes
     * back `403 InvalidProviderToken` and nothing in the message points at the
     * encoding.
     */
    private static bearer(): string {
        const now = Date.now();
        if (this.cachedToken && now - this.cachedToken.at < TOKEN_TTL_MS) {
            return this.cachedToken.jwt;
        }
        const header = { alg: 'ES256', kid: this.keyId(), typ: 'JWT' };
        const claims = { iss: this.teamId(), iat: Math.floor(now / 1000) };
        const encode = (o: unknown) =>
            Buffer.from(JSON.stringify(o)).toString('base64url');
        const signingInput = `${encode(header)}.${encode(claims)}`;

        const signer = createSign('SHA256');
        signer.update(signingInput);
        const signature = signer.sign(
            { key: this.privateKey(), dsaEncoding: 'ieee-p1363' },
            'base64url',
        );

        const jwt = `${signingInput}.${signature}`;
        this.cachedToken = { jwt, at: now };
        return jwt;
    }

    /**
     * The `apns-topic` for a push type.
     *
     * A WidgetKit push is addressed to `<bundle>.push-type.widgets`, NOT the
     * bare bundle id. Getting this wrong returns `TopicDisallowed`, which reads
     * like an entitlement problem and is not one.
     */
    private static topic(pushType: ApnsPushType): string {
        return pushType === 'widgets'
            ? `${this.bundleId()}.push-type.widgets`
            : this.bundleId();
    }

    private static session(environment: ApnsEnvironment): ClientHttp2Session {
        const existing = this.sessions.get(environment);
        if (existing && !existing.closed && !existing.destroyed) return existing;

        const session = http2.connect(HOSTS[environment]);
        // Without handlers, a dropped session raises an unhandled 'error' and
        // takes the process down — a push failure must never do that.
        session.on('error', () => this.sessions.delete(environment));
        session.on('close', () => this.sessions.delete(environment));
        session.on('goaway', () => this.sessions.delete(environment));
        this.sessions.set(environment, session);
        return session;
    }

    static isPermanentFailure(reason?: string): boolean {
        return Boolean(reason && PERMANENT_FAILURES.has(reason));
    }

    /** One push to one device. Never throws — every failure is reported in the
     *  result so a fan-out can keep going and prune what deserves pruning. */
    static async send(options: ApnsSendOptions): Promise<ApnsSendResult> {
        if (!this.isConfigured()) {
            return { token: options.token, ok: false, reason: 'ApnsNotConfigured' };
        }
        if (!options.token || options.token.length < 32) {
            return { token: options.token, ok: false, reason: 'BadDeviceToken', shouldUnregister: true };
        }

        // Background pushes MUST be priority 5 — Apple rejects 10 outright.
        // Widget pushes are also scheduled rather than immediate; 5 lets the
        // system batch them with other work, which is the considerate default
        // for something the user did not ask for in the moment.
        const priority = options.priority
            ?? (options.pushType === 'alert' ? 10 : 5);
        const expiration = Math.floor(Date.now() / 1000)
            + (options.expirationSeconds ?? 3600);

        const headers: Record<string, string | number> = {
            ':method': 'POST',
            ':path': `/3/device/${options.token}`,
            'authorization': `bearer ${this.bearer()}`,
            'apns-topic': this.topic(options.pushType),
            'apns-push-type': options.pushType,
            'apns-priority': priority,
            'apns-expiration': expiration,
        };
        if (options.collapseId) {
            // Apple's limit is 64 BYTES; truncating by characters would still
            // be rejected for a multi-byte id, so measure in bytes.
            headers['apns-collapse-id'] =
                Buffer.from(options.collapseId).subarray(0, 64).toString();
        }

        const body = JSON.stringify(options.payload);

        return new Promise<ApnsSendResult>((resolve) => {
            let settled = false;
            const finish = (result: ApnsSendResult) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            try {
                const request = this.session(options.environment).request(headers);
                let status = 0;
                let raw = '';

                request.setEncoding('utf8');
                request.on('response', (h) => { status = Number(h[':status'] ?? 0); });
                request.on('data', (chunk) => { raw += chunk; });
                request.on('end', () => {
                    // 200 carries no body; anything else carries {"reason": "..."}.
                    const reason = raw
                        ? (() => { try { return JSON.parse(raw).reason as string; } catch { return raw; } })()
                        : undefined;
                    finish({
                        token: options.token,
                        ok: status === 200,
                        status,
                        reason,
                        shouldUnregister: this.isPermanentFailure(reason),
                    });
                });
                request.on('error', (error) => {
                    finish({ token: options.token, ok: false, reason: error.message });
                });
                // A hung stream must not hold a fan-out open forever.
                request.setTimeout(10_000, () => {
                    request.close();
                    finish({ token: options.token, ok: false, reason: 'Timeout' });
                });

                request.end(body);
            } catch (error) {
                finish({
                    token: options.token,
                    ok: false,
                    reason: error instanceof Error ? error.message : 'UnknownError',
                });
            }
        });
    }

    /**
     * Fan out to many devices.
     *
     * Bounded concurrency rather than `Promise.all` over the whole list: every
     * push is a stream on a shared HTTP/2 session, and opening thousands at
     * once exceeds the peer's `SETTINGS_MAX_CONCURRENT_STREAMS` and gets the
     * excess refused — which would look exactly like a delivery failure.
     */
    static async sendMany(
        targets: Array<{ token: string; environment: ApnsEnvironment }>,
        options: Omit<ApnsSendOptions, 'token' | 'environment'>,
        concurrency = 32,
    ): Promise<ApnsSendResult[]> {
        const results: ApnsSendResult[] = [];
        for (let i = 0; i < targets.length; i += concurrency) {
            const batch = targets.slice(i, i + concurrency);
            results.push(...await Promise.all(
                batch.map(t => this.send({ ...options, token: t.token, environment: t.environment })),
            ));
        }
        return results;
    }

    /** Close pooled sessions — for tests and graceful shutdown. */
    static shutdown(): void {
        this.sessions.forEach(s => s.close());
        this.sessions.clear();
    }
}
