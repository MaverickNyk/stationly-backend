import { db, auth } from '../config/firebase';
import { SubscriptionService } from './subscriptionService';
import { EmailService } from './emailService';

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
    loggedIn?: boolean;
    lastLoggedInTime?: string;
    lastLogoutTime?: string;
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

export class UserService {
    private static collection = db.collection('users');

    static async createOrUpdateUser(
        uid: string,
        email: string,
        data: Partial<UserProfile>,
        emailVerified: boolean = false
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

            const updateData: Record<string, any> = {
                ...cleanedData,
                emailVerified,
                updatedAt: timestamp,
                loggedIn: true,
                lastLoggedInTime: timestamp
            };
            if (sendWelcome) updateData.welcomeSent = true;

            await userRef.update(updateData);

            if (sendWelcome) {
                const existing = snapshot.data();
                const displayName = (data.displayName || existing?.displayName || 'Stationly User');
                EmailService.sendWelcomeEmail(email, displayName);
            }

            const existingData = snapshot.data();
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

        return { ...userData, stations: updatedStations };
    }

    static async deleteAccount(uid: string) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();

        // Decrement subscription counts for all stations before deleting
        if (snapshot.exists) {
            const stations: SubscribedStation[] = snapshot.data()?.stations || [];
            for (const s of stations) {
                await SubscriptionService.decrementSubscription(s.id);
            }
        }

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

    static async logOut(uid: string) {
        const userRef = this.collection.doc(uid);
        const timestamp = new Date().toISOString();
        await userRef.update({
            loggedIn: false,
            lastLogoutTime: timestamp,
            updatedAt: timestamp
        });
        return { success: true };
    }
}
