import { messaging } from '../config/firebase';
import { LineIconService } from '../services/lineIconService';
import { UserFcmTokenService } from '../services/userFcmTokenService';

/**
 * Server-side fan-out for Stationly user notifications.
 *
 * Mirrors the Android `NotificationPayload` wire format
 * (StationlyUI/core/src/.../model/notification/NotificationPayload.kt).
 * The two sides MUST stay in lockstep — adding a new field on either
 * side without the other is the easiest way to silently drop UX.
 *
 * The service does NOT itself render the notification. It only packs
 * the payload as an FCM `data` message under the key
 * `notification_payload`, which the Android client's
 * `FcmMessagingService.dispatchRemoteNotification` picks up and hands
 * to the central NotificationDispatcher. Same code path the
 * client-side line-status-change auto-notifications use, so any
 * backend-driven push gets the same theming / channel / deep-link
 * treatment for free.
 *
 * Audience model — three shapes:
 *   - `token`  : a single FCM registration token (good for testing
 *                against your own device; admin reads the token from
 *                logcat or a debug screen).
 *   - `topic`  : any FCM topic the app subscribes to. The Syncer
 *                already publishes to `LineStatus_<id>` and `Station_<id>`
 *                topics; admin can target either.
 *   - `tokens` : a list of tokens (capped at 500 — FCM's hard limit
 *                per multicast). Useful for ad-hoc segments.
 *
 * Future audiences:
 *   - `uid`         (Firebase user id → looked up to token list)
 *   - `line`        (all users subscribed to a line)
 *   - `allUsers`    (everyone)
 * These need a Firestore index from `users/{uid}/fcm_tokens` first
 * (not yet built) and are intentionally NOT exposed today.
 */

export interface NotificationAction {
    label: string;
    deepLink: string;
}

/** Mirror of the Kotlin `NotificationPayload` data class. */
export interface NotificationPayload {
    type: string;
    title: string;
    body: string;
    /**
     * Severity bucket — drives the title text colour on the device.
     *   - `"danger"`  → red    (Severe Delays / Service Closed / Suspended)
     *   - `"warning"` → amber  (Minor Delays / Part Closure)
     *   - `"success"` → green  (Good Service / recovery)
     *   - `"info"`    → blue   (announcements, marketing)
     *   - `"neutral"` / omitted → default text colour
     *
     * Admin caller picks this explicitly. For status-change pushes the
     * service auto-derives it from `newStatus` if the caller doesn't
     * supply one — see {@link NotificationService.enrichPayload}.
     */
    severity?: 'danger' | 'warning' | 'success' | 'info' | 'neutral';
    /** Short context line above the body. Maps to NotificationCompat.setSubText. */
    subtitle?: string;
    /** Expanded-view summary text (BigPicture/Inbox styles). */
    summary?: string;
    channel?: string;
    priority?: 'max' | 'high' | 'default' | 'low' | 'min';
    color?: string;
    imageUrl?: string;
    /**
     * Optional override for the notification large-icon (the disc on
     * the right of the chip). When omitted, status-change notifications
     * auto-fill this with the line's roundel PNG so the user sees
     * which line is affected before reading.
     */
    largeIconUrl?: string;
    /**
     * Notification expanded-view style. Drives which NotificationCompat
     * style the dispatcher applies:
     *   - "bigText"     (default) — multi-line body
     *   - "bigPicture"  — large image fills the expanded view (uses imageUrl)
     *   - "inbox"       — multi-row "list" style (uses summary + actions)
     */
    style?: 'bigText' | 'bigPicture' | 'inbox';
    deepLink?: string;
    actions?: NotificationAction[];
    groupKey?: string;
    notificationId?: number;
    // Status-specific extras (used by client-driven status change path;
    // the admin endpoint can pass them through for parity but they're
    // optional for non-status pushes).
    lineId?: string;
    lineName?: string;
    previousStatus?: string;
    newStatus?: string;
}

export type Audience =
    | { type: 'token';  value: string }
    | { type: 'tokens'; value: string[] }
    | { type: 'topic';  value: string }
    /**
     * Single Firebase user id. Resolves to every FCM token registered
     * for that user (via {@link UserFcmTokenService}). User must have
     * called `/api/v1/user/fcm/register` at least once for any tokens
     * to exist — fresh installs that haven't registered yet are
     * silently a no-op (successCount=0, failureCount=0).
     */
    | { type: 'uid';  value: string }
    /** Batch of UIDs. Fans out reads per-UID then dedups + multicasts. */
    | { type: 'uids'; value: string[] }
    /**
     * Everyone who runs the app. Delivered via the FCM topic
     * `stationly_all`, which every install auto-subscribes to on
     * cold launch. Zero Firestore reads/writes — FCM handles the
     * fan-out at delivery time.
     */
    | { type: 'all' }
    /**
     * Everyone subscribed to a specific TfL line. Delivered via the
     * existing `LineStatus_<lineId>` FCM topic that the app already
     * subscribes to for the Syncer's status pushes. Zero Firestore
     * reads — admin shares the same topic, only the payload differs
     * (notification_payload only; no `payload` field so the client's
     * handleLineStatusUpdate early-returns and only the notification
     * dispatcher fires).
     *
     * `value` is the TfL line id (e.g. "piccadilly", "circle").
     */
    | { type: 'line'; value: string };

export interface SendResult {
    successCount: number;
    failureCount: number;
    /** Per-token failure details when multicasting. Token strings are
     *  intentionally NOT echoed back — only the FCM error codes — to
     *  avoid logging sensitive identifiers. */
    failures?: { code?: string; message?: string }[];
    /** FCM's message ID for single-send / topic paths. */
    messageId?: string;
}

export class NotificationService {

    /**
     * Send a notification to the chosen audience. Throws on
     * malformed input (bad audience type, oversized token list);
     * returns counts for delivery results so the admin caller can
     * inspect what hit and what didn't.
     */
    static async send(audience: Audience, payload: NotificationPayload): Promise<SendResult> {
        this.validatePayload(payload);
        const enriched = this.enrichPayload(payload);
        const data = this.encodeData(enriched);

        switch (audience.type) {
            case 'token':
                return this.sendToToken(audience.value, data);
            case 'tokens':
                return this.sendToTokens(audience.value, data);
            case 'topic':
                return this.sendToTopic(audience.value, data);
            case 'uid': {
                const tokens = await UserFcmTokenService.listForUid(audience.value);
                if (tokens.length === 0) {
                    return { successCount: 0, failureCount: 0, failures: [{ message: 'No registered tokens for uid' }] };
                }
                return this.sendToTokens(tokens, data);
            }
            case 'uids': {
                const tokens = await UserFcmTokenService.listForUids(audience.value);
                if (tokens.length === 0) {
                    return { successCount: 0, failureCount: 0, failures: [{ message: 'No registered tokens for uids' }] };
                }
                // sendToTokens already chunks at 500 — for now we expect
                // admin segments to be well below that; if not, chunk here.
                return this.sendToTokens(tokens, data);
            }
            case 'all':
                // Broadcast via the universal app topic. FCM handles the
                // fan-out internally — no Firestore reads, single API call.
                return this.sendToTopic('stationly_all', data);
            case 'line': {
                // Lowercase line id matches the topic naming the Syncer +
                // app use everywhere (LineStatus_piccadilly, not _Piccadilly).
                const topic = `LineStatus_${audience.value.toLowerCase()}`;
                return this.sendToTopic(topic, data);
            }
            default:
                throw new Error(`Unsupported audience type: ${(audience as any).type}`);
        }
    }

    /**
     * Apply server-side defaults that make a notification feel
     * "intelligently put together" without requiring the admin caller
     * to spell out every field:
     *   - If a `lineId` is set and `largeIconUrl` isn't, auto-fill with
     *     the line's roundel PNG (or mode icon for buses).
     *   - If a `lineId` is set and `color` isn't, auto-fill with the
     *     TfL line colour.
     *
     * Caller-supplied values always win.
     */
    private static enrichPayload(p: NotificationPayload): NotificationPayload {
        const out: NotificationPayload = { ...p };

        // Auto-derive severity from newStatus when admin didn't pick
        // one. This means the same /admin/notify call that backend
        // services already make (with lineId + newStatus) gets the
        // right title colour for free.
        if (!out.severity && out.newStatus) {
            out.severity = severityFromStatus(out.newStatus);
        }

        const lineId = p.lineId?.toLowerCase();
        if (!lineId) return out;

        // We do NOT auto-fill `largeIconUrl` from `lineId` anymore. The
        // notification chip already has the Stationly small icon on the
        // left and the line colour tinting the chrome, plus the line
        // name in the title; an extra coloured roundel was visual noise.
        // Admin callers can still set largeIconUrl EXPLICITLY when they
        // want a hero image (e.g. promo with product photo).

        if (!out.color) {
            // Single source of truth for the TfL brand palette — see
            // LineIconService.colorFor. Adding a new line / retuning a
            // hex needs one edit, not two.
            const hex = LineIconService.colorFor(lineId);
            if (hex) out.color = hex;
        }

        return out;
    }

    private static validatePayload(p: NotificationPayload) {
        if (!p.type || !p.type.trim()) throw new Error('payload.type is required');
        if (!p.title || !p.title.trim()) throw new Error('payload.title is required');
        if (!p.body || !p.body.trim()) throw new Error('payload.body is required');
        if (p.color && !/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(p.color)) {
            throw new Error('payload.color must be hex (#RRGGBB or #AARRGGBB)');
        }
        if (p.imageUrl && !p.imageUrl.startsWith('https://')) {
            throw new Error('payload.imageUrl must be HTTPS');
        }
        if (p.actions && p.actions.length > 3) {
            throw new Error('payload.actions is capped at 3 by Android');
        }
    }

    /**
     * FCM `data` field values must be strings. We serialise the whole
     * payload as one JSON string under `notification_payload`; the
     * Android dispatcher pulls it back out and deserialises. Single
     * field == single source of truth, no field-spreading mismatches.
     */
    private static encodeData(payload: NotificationPayload): Record<string, string> {
        return { notification_payload: JSON.stringify(payload) };
    }

    private static async sendToToken(token: string, data: Record<string, string>): Promise<SendResult> {
        if (!token || token.length < 20) throw new Error('Invalid FCM token');
        const messageId = await messaging.send({
            token,
            data,
            android: { priority: 'high' },
        });
        return { successCount: 1, failureCount: 0, messageId };
    }

    private static async sendToTokens(tokens: string[], data: Record<string, string>): Promise<SendResult> {
        if (!Array.isArray(tokens) || tokens.length === 0) throw new Error('tokens list is empty');
        if (tokens.length > 500) throw new Error('FCM caps multicast at 500 tokens per call');
        const response = await messaging.sendEachForMulticast({
            tokens,
            data,
            android: { priority: 'high' },
        });
        return {
            successCount: response.successCount,
            failureCount: response.failureCount,
            failures: response.responses
                .map(r => r.error ? { code: r.error.code, message: r.error.message } : null)
                .filter((x): x is { code: string; message: string } => !!x),
        };
    }

    private static async sendToTopic(topic: string, data: Record<string, string>): Promise<SendResult> {
        if (!topic || !/^[a-zA-Z0-9_\-.~%]+$/.test(topic)) {
            throw new Error('Invalid topic name (FCM allows [a-zA-Z0-9-_.~%])');
        }
        const messageId = await messaging.send({
            topic,
            data,
            android: { priority: 'high' },
        });
        return { successCount: 1, failureCount: 0, messageId };
    }
}

/**
 * Map a TfL statusSeverityDescription string to a notification severity
 * bucket. Kept as a free function (not a class method) so the same
 * mapping is trivially callable from any future producer — e.g. a
 * background Syncer-side enricher — without dragging the rest of the
 * NotificationService into that module.
 */
function severityFromStatus(status: string): NotificationPayload['severity'] {
    const s = status.trim().toLowerCase();
    if (!s) return 'neutral';
    if (s === 'good service') return 'success';
    const danger = new Set([
        'severe delays', 'service closed', 'part suspended',
        'suspended', 'planned closure',
    ]);
    if (danger.has(s)) return 'danger';
    const warning = new Set([
        'minor delays', 'part closure', 'reduced service',
    ]);
    if (warning.has(s)) return 'warning';
    return 'neutral';
}
