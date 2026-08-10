import { db } from '../config/firebase';
import { ApnsEnvironment } from './apnsService';

/**
 * Registry of the APNs tokens an iOS device exposes.
 *
 * ## Two tokens per device, and they are not interchangeable
 * A phone running Stationly can be addressed two ways, and both are stored:
 *
 *  - **`widgetToken`** — issued by WidgetKit to the widget EXTENSION (iOS 26+).
 *    A push here reloads the widget's timeline without launching the app, on a
 *    budget separate from everything else. This is the good path: it is the
 *    only way to make a widget current promptly without spending the quota the
 *    whole adaptive schedule exists to protect.
 *  - **`appToken`** — the ordinary APNs device token. A `background` push here
 *    wakes the app, which then refreshes and reloads. Works back to iOS 17, so
 *    it is the fallback for devices below 26 — but it is gated on the user's
 *    Background App Refresh switch and throttled by the system, so it is
 *    best-effort and never the schedule.
 *
 * A device may have either, both, or (before it has ever registered) neither.
 *
 * ## Why the environment is stored per token
 * An APNs token belongs to exactly one environment: a development build's
 * token is rejected by the production host and vice versa, with
 * `BadDeviceToken`. Storing it alongside the token is what lets a TestFlight
 * device and a debug device coexist in one registry — the single most common
 * cause of "the push was accepted and never arrived".
 *
 * ## Layout
 *   devices/{deviceId}
 *     { deviceId, uid?, widgetToken?, appToken?, environment,
 *       iosVersion?, appVersion?, stations: string[], updatedAt }
 *
 * Keyed by the app's own stable device id rather than by token, because the
 * TOKENS rotate and the device does not — keying by token would accumulate a
 * new document on every rotation and leave the old ones to be pushed at
 * forever. `stations` is what a station-scoped disruption push filters on.
 */

export interface RegisteredDevice {
    deviceId: string;
    uid?: string;
    widgetToken?: string;
    appToken?: string;
    environment: ApnsEnvironment;
    iosVersion?: string;
    appVersion?: string;
    /** Grouping ids of the stations this device's widgets show. */
    stations: string[];
    /**
     * Line ids those stations are tracked on.
     *
     * Stored alongside `stations` because disruption is reported BY LINE — TfL
     * says "Victoria: Severe Delays", not "these forty stations are in trouble".
     * Without this, scoping a disruption push would need a line→stations join
     * on every trigger, and would still be wrong: a user tracking Green Park
     * only for the Jubilee should not be woken by a Piccadilly closure.
     */
    lines: string[];
    updatedAt: number;
}

export interface RegisterDeviceInput {
    deviceId: string;
    uid?: string;
    widgetToken?: string;
    appToken?: string;
    environment?: ApnsEnvironment;
    iosVersion?: string;
    appVersion?: string;
    stations?: string[];
    lines?: string[];
}

const COLLECTION = 'devices';

export class DeviceRegistryService {

    /**
     * Idempotent upsert. Called on cold launch, whenever WidgetKit hands over a
     * new widget push token, and whenever the user's station list changes.
     *
     * `set(merge: true)` so a client that knows only one of the two tokens does
     * not erase the other — the widget token arrives from the extension via the
     * App Group and may simply not be there yet on a first run.
     */
    static async register(input: RegisterDeviceInput): Promise<void> {
        if (!input.deviceId) throw new Error('deviceId is required');
        if (!input.widgetToken && !input.appToken) {
            throw new Error('at least one of widgetToken or appToken is required');
        }

        const doc: Record<string, unknown> = {
            deviceId: input.deviceId,
            environment: input.environment ?? 'production',
            stations: input.stations ?? [],
            // Lowercased on the way in so a scoped send never has to care how a
            // client spelled it. TfL line ids are lowercase by convention but
            // clients have been known to pass display names.
            lines: (input.lines ?? []).map(l => l.trim().toLowerCase()).filter(Boolean),
            updatedAt: Date.now(),
        };
        // Only write the fields we were actually given. Assigning `undefined`
        // to a Firestore field is an error, and writing null would clear a
        // token the client still holds.
        if (input.uid) doc.uid = input.uid;
        if (input.widgetToken) doc.widgetToken = input.widgetToken;
        if (input.appToken) doc.appToken = input.appToken;
        if (input.iosVersion) doc.iosVersion = input.iosVersion;
        if (input.appVersion) doc.appVersion = input.appVersion;

        await db.collection(COLLECTION).doc(input.deviceId).set(doc, { merge: true });
    }

    static async unregister(deviceId: string): Promise<void> {
        if (!deviceId) return;
        await db.collection(COLLECTION).doc(deviceId)
            .delete()
            .catch(() => { /* already gone */ });
    }

    /** Every registered iOS device. The audience for a broadcast. */
    static async listAll(): Promise<RegisteredDevice[]> {
        const snap = await db.collection(COLLECTION).get();
        return snap.docs.map(d => d.data() as RegisteredDevice).filter(Boolean);
    }

    /**
     * Every device one account is signed in on — the audience for `user.sync`.
     *
     * This is what makes cross-device consistency work on iOS. Android reaches
     * the same devices through `users/{uid}/fcm_tokens`; both are keyed by uid,
     * so a profile edit or a station change fans out to everything the user is
     * signed into regardless of platform.
     */
    static async listForUid(uid: string): Promise<RegisteredDevice[]> {
        if (!uid) return [];
        const snap = await db.collection(COLLECTION).where('uid', '==', uid).get();
        return snap.docs.map(d => d.data() as RegisteredDevice).filter(Boolean);
    }

    /**
     * Devices whose widgets show any of [stations] — the audience for a
     * disruption push.
     *
     * `array-contains-any` caps at 30 values per query, so longer lists are
     * chunked and deduplicated. Scoping this way is the difference between
     * waking every device in the city for a Victoria-line closure and waking
     * the ones that asked about it.
     */
    static async listForStations(stations: string[]): Promise<RegisteredDevice[]> {
        if (!stations?.length) return [];
        const chunks: string[][] = [];
        for (let i = 0; i < stations.length; i += 30) chunks.push(stations.slice(i, i + 30));

        const seen = new Map<string, RegisteredDevice>();
        for (const chunk of chunks) {
            const snap = await db.collection(COLLECTION)
                .where('stations', 'array-contains-any', chunk)
                .get();
            snap.docs.forEach(d => {
                const device = d.data() as RegisteredDevice;
                if (device?.deviceId) seen.set(device.deviceId, device);
            });
        }
        return Array.from(seen.values());
    }

    /**
     * Devices tracking any of [lines] — the audience for a disruption push.
     *
     * Same 30-value chunking as [listForStations]: `array-contains-any` caps
     * there, and a mode-wide incident can name more lines than that.
     */
    static async listForLines(lines: string[]): Promise<RegisteredDevice[]> {
        const wanted = (lines ?? []).map(l => l.trim().toLowerCase()).filter(Boolean);
        if (!wanted.length) return [];

        const chunks: string[][] = [];
        for (let i = 0; i < wanted.length; i += 30) chunks.push(wanted.slice(i, i + 30));

        const seen = new Map<string, RegisteredDevice>();
        for (const chunk of chunks) {
            const snap = await db.collection(COLLECTION)
                .where('lines', 'array-contains-any', chunk)
                .get();
            snap.docs.forEach(d => {
                const device = d.data() as RegisteredDevice;
                if (device?.deviceId) seen.set(device.deviceId, device);
            });
        }
        return Array.from(seen.values());
    }

    /**
     * Drop a token Apple has told us is dead.
     *
     * Removes the offending FIELD rather than the document — a device whose
     * widget token has been reissued still has a working app token, and
     * deleting the row would lose its station list and its registration
     * altogether.
     */
    static async pruneToken(token: string): Promise<void> {
        if (!token) return;
        for (const field of ['widgetToken', 'appToken'] as const) {
            const snap = await db.collection(COLLECTION).where(field, '==', token).get();
            await Promise.all(snap.docs.map(d =>
                d.ref.update({ [field]: null, updatedAt: Date.now() }).catch(() => { /* raced */ }),
            ));
        }
    }
}
