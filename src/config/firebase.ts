import * as admin from 'firebase-admin';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

let credential;
const serviceAccountPath = process.env.FIREBASE_KEY_PATH || './serviceAccountKey.json';

try {
    const serviceAccount = require(path.resolve(serviceAccountPath));
    credential = admin.credential.cert(serviceAccount);
} catch (error) {
    console.warn(`[Firebase] Service account at ${serviceAccountPath} not found. Falling back to default.`);
    credential = admin.credential.applicationDefault();
}

if (!admin.apps.length) {
    admin.initializeApp({
        credential
    });
}

export const db = admin.firestore();
export const auth = admin.auth();
export const messaging = admin.messaging();
