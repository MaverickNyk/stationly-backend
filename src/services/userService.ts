import { db, auth } from '../config/firebase';
import { SubscriptionService } from './subscriptionService';
import { EmailService } from './emailService';
import { UserSyncNotifier } from './userSyncNotifier';

export interface UserProfile {
    uid: string;
    email: string;
    displayName: string;
    photoURL?: string;
    address?: string;
    phoneNumber?: string;
    signInProvider?: string;
    createdAt?: string;
    updatedAt?: string;
    // `loggedIn` now strictly means "≥1 active device session" (derived from
    // `sessions`). Kept because it's queryable (Firestore can't query map
    // emptiness) and gates deleteAccount.
    loggedIn?: boolean;
    // Aggregate "last sign-in on ANY device" — handy top-level field for
    // analytics/queries. Per-device timestamps live inside `sessions`.
    lastLoggedInTime?: string;
    // Active device sessions, keyed by a stable per-install device id. A user is
    // "logged in" while this map is non-empty. Subscription counts increment on
    // the 0→1 transition (first device in) and decrement on 1→0 (last device
    // out) — so 5 devices on one account still contribute exactly +1 to each
    // saved station's count.
    sessions?: Record<string, DeviceSession>;
    // Authoritative copy of Firebase Auth's email_verified claim, mirrored on every
    // sync so callers can gate on the user doc instead of hitting Admin SDK each time.
    emailVerified?: boolean;
    // True the first time we send the welcome email — prevents duplicates if the user
    // signs in again after verifying. Set together with the welcome email send.
    welcomeSent?: boolean;
    // Subscribed stations list
    stations: SubscribedStation[];
}

export interface SubscribedStation {
    id: string; // stationId (naptanId)
    name: string;
    line: string;
    mode: string;
    direction: string;
}

/** Client-supplied device metadata for a session (all optional). */
export interface DeviceInfo {
    platform?: string;    // "android" | "ios" | "web"
    osVersion?: string;   // e.g. "Android 14 (SDK 34)"
    model?: string;       // e.g. "Google Pixel 8"
    appVersion?: string;  // e.g. "1.0-staging"
}

/** A single active device session stored under users/{uid}.sessions[deviceId]. */
export interface DeviceSession extends DeviceInfo {
    firstSeen: string;    // ISO — when this device first started a session
    lastSeen: string;     // ISO — last login/refresh from this device
}

export class UserService {
    private static collection = db.collection('users');

    // A device idle this long (no login/refresh) is treated as gone and pruned.
    // Matches the FCM-token dormancy threshold. A device logged in but unopened
    // for longer than this loses its session; it re-establishes on next launch.
    private static readonly SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

    /** Build/refresh a device-session entry, preserving firstSeen if it exists. */
    private static buildSessionEntry(
        existing: DeviceSession | undefined,
        info: DeviceInfo | undefined,
        timestamp: string
    ): DeviceSession {
        return {
            platform: info?.platform ?? existing?.platform,
            osVersion: info?.osVersion ?? existing?.osVersion,
            model: info?.model ?? existing?.model,
            appVersion: info?.appVersion ?? existing?.appVersion,
            firstSeen: existing?.firstSeen ?? timestamp,
            lastSeen: timestamp,
        };
    }

    /** Drop sessions whose lastSeen is older than the TTL (uninstalled / abandoned devices). */
    private static pruneStaleSessions(sessions: Record<string, DeviceSession>): Record<string, DeviceSession> {
        const cutoff = Date.now() - this.SESSION_TTL_MS;
        const out: Record<string, DeviceSession> = {};
        for (const [id, s] of Object.entries(sessions)) {
            const seen = Date.parse(s?.lastSeen ?? '');
            if (!Number.isNaN(seen) && seen >= cutoff) out[id] = s;
        }
        return out;
    }

    /**
     * Register/refresh a device session ATOMICALLY (Firestore transaction so
     * concurrent multi-device logins can't lose a session or double-count).
     * Increments the user's saved-station subscriptions only on the
     * logged-out → logged-in transition. Gating on the stored `loggedIn` flag
     * (not map emptiness) keeps it correct even when stale sessions are pruned.
     */
    static async startSession(uid: string, deviceId: string, deviceInfo?: DeviceInfo): Promise<void> {
        const ref = this.collection.doc(uid);
        let didActivate = false;
        let stations: SubscribedStation[] = [];
        await db.runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (!doc.exists) return;
            const data = doc.data() || {};
            const ts = new Date().toISOString();
            const prevLoggedIn = data.loggedIn === true;
            const sessions = this.pruneStaleSessions({ ...(data.sessions || {}) });
            sessions[deviceId] = this.buildSessionEntry(sessions[deviceId], deviceInfo, ts);
            tx.update(ref, { sessions, loggedIn: true, lastLoggedInTime: ts, updatedAt: ts });
            if (!prevLoggedIn) { didActivate = true; stations = data.stations || []; }
        });
        if (didActivate && stations.length > 0) {
            setImmediate(async () => {
                for (const s of stations) await SubscriptionService.incrementSubscription(s.id);
            });
        }
    }

    /**
     * End a device session ATOMICALLY. Removes only `deviceId` (or all sessions
     * if omitted — "sign out everywhere"). Decrements the user's saved-station
     * subscriptions only on the logged-in → logged-out transition (last device
     * out). Prunes stale sessions in the same pass.
     */
    static async endSession(uid: string, deviceId?: string): Promise<void> {
        const ref = this.collection.doc(uid);
        let didDeactivate = false;
        let stations: SubscribedStation[] = [];
        await db.runTransaction(async (tx) => {
            const doc = await tx.get(ref);
            if (!doc.exists) return;
            const data = doc.data() || {};
            const ts = new Date().toISOString();
            const prevLoggedIn = data.loggedIn === true;
            let sessions = this.pruneStaleSessions({ ...(data.sessions || {}) });
            if (deviceId) delete sessions[deviceId]; else sessions = {};
            const nowLoggedIn = Object.keys(sessions).length > 0;
            tx.update(ref, { sessions, loggedIn: nowLoggedIn, updatedAt: ts });
            if (prevLoggedIn && !nowLoggedIn) { didDeactivate = true; stations = data.stations || []; }
        });
        if (didDeactivate && stations.length > 0) {
            setImmediate(async () => {
                for (const s of stations) await SubscriptionService.decrementSubscription(s.id);
            });
        }
    }

    static async createOrUpdateUser(
        uid: string,
        email: string,
        data: Partial<UserProfile>,
        emailVerified: boolean = false,
        deviceId?: string,
        deviceInfo?: DeviceInfo
    ) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        const timestamp = new Date().toISOString();

        // Welcome email fires once per user, the moment we observe emailVerified flip
        // to true. For Google signups this happens at first sync (Google emails are
        // pre-verified); for email signups it happens on the post-verify sync. Either
        // way the welcome lands AFTER the user has proven their address.
        const shouldSendWelcome = (snap: typeof snapshot): boolean => {
            if (!emailVerified) return false;
            if (!snap.exists) return true;
            return snap.data()?.welcomeSent !== true;
        };

        if (!snapshot.exists) {
            const sendWelcome = shouldSendWelcome(snapshot);
            const displayName = data.displayName || 'Stationly User';
            const newUser: UserProfile = {
                uid,
                email,
                displayName,
                photoURL: data.photoURL || '',
                address: data.address || '',
                phoneNumber: data.phoneNumber || '',
                signInProvider: data.signInProvider || 'email',
                createdAt: timestamp,
                updatedAt: timestamp,
                loggedIn: true,
                lastLoggedInTime: timestamp,
                // Seed the device-session map with this first device. New users
                // have no saved stations yet, so there's nothing to increment.
                sessions: deviceId
                    ? { [deviceId]: this.buildSessionEntry(undefined, deviceInfo, timestamp) }
                    : {},
                emailVerified,
                welcomeSent: sendWelcome,
                stations: []
            };
            await userRef.set(newUser);
            if (sendWelcome) {
                // Fire-and-forget — never block signup on email delivery
                EmailService.sendWelcomeEmail(email, displayName);
            }
            return newUser;
        } else {
            const sendWelcome = shouldSendWelcome(snapshot);

            // Strip undefined values from data so Firestore doesn't crash
            const cleanedData = Object.fromEntries(
                Object.entries(data).filter(([_, v]) => v !== undefined)
            );

            const existingData = snapshot.data();

            // Profile fields only — last-write-wins is fine here. Session state
            // (sessions/loggedIn/lastLoggedInTime) and the subscription ref-count
            // are handled atomically by startSession() below so concurrent
            // multi-device logins can't race.
            const updateData: Record<string, any> = {
                ...cleanedData,
                emailVerified,
                updatedAt: timestamp
            };
            if (sendWelcome) updateData.welcomeSent = true;

            // Notify the user's other devices if the display name actually changed.
            const nameChanged =
                typeof data.displayName === 'string' &&
                data.displayName.trim().length > 0 &&
                data.displayName !== existingData?.displayName;
            if (nameChanged) {
                setImmediate(() => UserSyncNotifier.notify(uid, 'profile'));
            }

            await userRef.update(updateData);

            // Register this device's session (atomic; increments saved-station
            // subscriptions only on this user's first active device).
            if (deviceId) {
                await this.startSession(uid, deviceId, deviceInfo);
            }

            if (sendWelcome) {
                const displayName = (data.displayName || existingData?.displayName || 'Stationly User');
                EmailService.sendWelcomeEmail(email, displayName);
            }

            return {
                stations: [], // Default fallback
                ...existingData,
                ...updateData
            } as unknown as UserProfile;
        }
    }

    static async getUserProfile(uid: string): Promise<UserProfile> {
        const doc = await this.collection.doc(uid).get();
        if (!doc.exists) {
            throw new Error('User not found');
        }
        return doc.data() as UserProfile;
    }

    static async syncStations(uid: string, stations: SubscribedStation[]) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        const oldStations = snapshot.exists ? (snapshot.data()?.stations || []) : [];
        
        await userRef.update({
            stations,
            updatedAt: new Date().toISOString()
        });

        // Delegate to SubscriptionService
        setImmediate(async () => {
            const oldIds = oldStations.map((s: any) => s.id as string);
            const newIds = stations.map(s => s.id);

            for (const id of oldIds.filter((id: string) => !newIds.includes(id))) {
                await SubscriptionService.decrementSubscription(id);
            }
            for (const id of newIds.filter((id: string) => !oldIds.includes(id))) {
                await SubscriptionService.incrementSubscription(id);
            }
        });

        setImmediate(() => UserSyncNotifier.notify(uid, 'stations'));

        return { success: true, count: stations.length };
    }

    static async addStation(uid: string, station: SubscribedStation) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        if (!snapshot.exists) throw new Error('User not found');

        const userData = snapshot.data() as UserProfile;
        const oldStations = userData.stations || [];

        // As requested by user: For now we are only allowing user to have one board 
        const updatedStations = [station];

        await userRef.update({
            stations: updatedStations,
            updatedAt: new Date().toISOString()
        });

        setImmediate(async () => {
            for (const s of oldStations) await SubscriptionService.decrementSubscription(s.id);
            await SubscriptionService.incrementSubscription(station.id);
        });

        setImmediate(() => UserSyncNotifier.notify(uid, 'stations'));

        return { ...userData, stations: updatedStations };
    }

    static async removeStation(uid: string, stationId: string, lineId: string) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        if (!snapshot.exists) throw new Error('User not found');

        const userData = snapshot.data() as UserProfile;
        const updatedStations = userData.stations.filter(s => !(s.id === stationId && s.line === lineId));
        
        await userRef.update({
            stations: updatedStations,
            updatedAt: new Date().toISOString()
        });

        setImmediate(async () => {
            await SubscriptionService.decrementSubscription(stationId);
        });

        setImmediate(() => UserSyncNotifier.notify(uid, 'stations'));

        return { ...userData, stations: updatedStations };
    }

    static async deleteAccount(uid: string) {
        const userRef = this.collection.doc(uid);

        // Notify the user's other devices BEFORE we delete the doc + tokens,
        // so they can force-log-out instead of showing a ghost session.
        await UserSyncNotifier.notify(uid, 'deleted');

        // Release this user's subscription hold ATOMICALLY via endSession: it
        // clears all sessions, flips loggedIn=false, and decrements each saved
        // station EXACTLY ONCE — and only if still logged in. Routing through the
        // same transactional, loggedIn-gated path as logout (instead of a plain
        // decrement loop) prevents a double-decrement if a logout on another
        // device races this deletion, which could otherwise push a station's
        // count below what OTHER users contribute and cut them off. The decrement
        // captures the station ids inside the transaction, so deleting the doc
        // immediately after is safe.
        await this.endSession(uid);

        // Delete Firestore document
        await userRef.delete();

        // Delete Firebase Auth user via Admin SDK
        try {
            await auth.deleteUser(uid);
        } catch (err: any) {
            // If user is already deleted from Auth, that's fine — still return success
            if (err.code !== 'auth/user-not-found') throw err;
        }

        return { success: true };
    }

    /**
     * Sign a single device out. Multi-device aware: removes only THIS device's
     * session. The user stays "logged in" (and keeps their subscription hold)
     * until the LAST device signs out, at which point we decrement their saved
     * stations. The `stations` array is always preserved for re-login restore.
     *
     * If no deviceId is supplied (legacy clients / "sign out everywhere"), all
     * sessions are cleared and the decrement runs.
     */
    static async logOut(uid: string, deviceId?: string) {
        // endSession atomically removes this device's session and, only when the
        // LAST device signs out, flips loggedIn=false and releases the user's +1
        // hold on each saved station. SubscriptionService.updateCount floors at 0
        // and deletes a station from the registry only when the TOTAL across all
        // users hits 0 — so a station any other user/device still watches is
        // never removed.
        await this.endSession(uid, deviceId);
        return { success: true };
    }
}
