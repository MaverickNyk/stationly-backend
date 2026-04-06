import { Request, Response, NextFunction } from 'express';
import { db, auth } from '../config/firebase';
import { LocalDbService } from '../services/localDbService';

/**
 * StationlyAuth Middleware
 * Handles multi-tenant API Key verification and Firebase User Auth.
 */
export class AuthMiddleware {
    private static keyCache = new Map<string, any>();
    private static isInitialized = false;

    /**
     * Real-time Key Registry Listener
     * Keeps a local RAM cache of active API keys in sync with Firestore.
     * Persisted to SQLite for zero-failure boot.
     */
    static async initializeKeyRegistryListener() {
        if (this.isInitialized) return;

        console.log("AUTH: 🔄 Initializing real-time API Key registry...");

        // 1. Load from SQLite first
        try {
            const savedKeys = await LocalDbService.all<any>('SELECT * FROM api_keys WHERE status = "active"');
            savedKeys.forEach(data => {
                this.keyCache.set(data.key, {
                    id: data.clientId,
                    tier: data.tier,
                    name: data.clientName
                });
            });
            console.log(`AUTH: 📁 Loaded ${this.keyCache.size} keys from SQLite.`);
        } catch (err) {
            console.error("AUTH: ❌ Failed to load from SQLite", err);
        }
        
        // 2. Setup Firestore listener
        db.collection('api_keys').onSnapshot(async snapshot => {
            snapshot.docChanges().forEach(async change => {
                const data = change.doc.data();
                const id = change.doc.id;
                
                if (change.type === 'removed' || (data.status !== 'active')) {
                    if (data.key) {
                        this.keyCache.delete(data.key);
                        await LocalDbService.run('DELETE FROM api_keys WHERE key = ?', [data.key]);
                    }
                } else if (data.key && data.status === 'active') {
                    const client = {
                        clientId: data.clientId || id,
                        tier: data.tier || 'free',
                        clientName: data.clientName || 'Unknown Client',
                        status: data.status
                    };
                    
                    this.keyCache.set(data.key, {
                        id: client.clientId,
                        tier: client.tier,
                        name: client.clientName
                    });

                    // Persist to SQLite
                    await LocalDbService.upsertApiKey(data.key, client);
                }
            });

            this.isInitialized = true;
            console.log(`AUTH: ✅ Key registry updated. ${this.keyCache.size} active keys in RAM cache.`);
        }, err => {
            console.error("AUTH: ❌ Failed to listen to API Key registry", err);
        });
    }

    /**
     * Protects routes using X-Stationly-Key.
     * Serves instantly from RAM with ZERO Firestore reads.
     */
    static async validateApiKey(req: Request, res: Response, next: NextFunction) {
        const apiKey = req.header('X-Stationly-Key');

        if (!apiKey) {
            return res.status(401).json({
                error: "Unauthorized",
                message: "Missing 'X-Stationly-Key' header."
            });
        }

        // 🕵️ Check RAM Cache
        const clientInfo = AuthMiddleware.keyCache.get(apiKey);

        if (!clientInfo) {
            console.log(`AUTH: ❌ Invalid or inactive API Key attempted: ${apiKey.substring(0, 8)}...`);
            return res.status(403).json({
                error: "Forbidden",
                message: "Invalid or inactive 'X-Stationly-Key'."
            });
        }

        // Attach client info for rate-limiting
        (req as any).stationlyClient = clientInfo;
        next();
    }

    /**
     * Firebase User Auth Middleware
     * used for protecting personal user data routes.
     */
    static async validateUserToken(req: Request, res: Response, next: NextFunction) {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                error: "Unauthorized",
                message: "Missing or invalid Authorization header. Expected 'Bearer <token>'."
            });
        }

        const idToken = authHeader.split('Bearer ')[1];

        try {
            const decodedToken = await auth.verifyIdToken(idToken);
            (req as any).user = {
                uid: decodedToken.uid,
                email: decodedToken.email
            };
            
            const requestedUid = req.params.uid || req.body.uid;
            if (requestedUid && requestedUid !== decodedToken.uid) {
                return res.status(403).json({
                    error: "Forbidden",
                    message: "Access to other user ID denied."
                });
            }

            next();
        } catch (err: any) {
            return res.status(401).json({ 
                error: "Unauthorized", 
                message: "Invalid Firebase ID Token." 
            });
        }
    }

    static getIsReady() {
        return this.isInitialized;
    }
}
