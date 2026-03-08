import { db } from '../config/firebase';

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

    static async createOrUpdateUser(uid: string, email: string, data: Partial<UserProfile>) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        const timestamp = new Date().toISOString();

        if (!snapshot.exists) {
            const newUser: UserProfile = {
                uid,
                email,
                displayName: data.displayName || 'Stationly User',
                photoURL: data.photoURL || '',
                address: data.address || '',
                phoneNumber: data.phoneNumber || '',
                signInProvider: data.signInProvider || 'email',
                createdAt: timestamp,
                updatedAt: timestamp,
                loggedIn: true,
                lastLoggedInTime: timestamp,
                stations: []
            };
            await userRef.set(newUser);
            return newUser;
        } else {
            // Strip undefined values from data so Firestore doesn't crash
            const cleanedData = Object.fromEntries(
                Object.entries(data).filter(([_, v]) => v !== undefined)
            );
            
            const updateData = {
                ...cleanedData,
                updatedAt: timestamp,
                loggedIn: true,
                lastLoggedInTime: timestamp
            };
            await userRef.update(updateData);
            
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
        const timestamp = new Date().toISOString();
        await userRef.update({
            stations,
            updatedAt: timestamp
        });
        return { success: true, count: stations.length };
    }

    static async addStation(uid: string, station: SubscribedStation) {
        const userRef = this.collection.doc(uid);
        const snapshot = await userRef.get();
        if (!snapshot.exists) throw new Error('User not found');

        const userData = snapshot.data() as UserProfile;

        // As requested by user: For now we are only allowing user to have one board 
        // so when a user updates the board you need to delete the last board from the array 
        // and update it with the new board.
        const updatedStations = [station];

        await userRef.update({
            stations: updatedStations,
            updatedAt: new Date().toISOString()
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
        return { ...userData, stations: updatedStations };
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
