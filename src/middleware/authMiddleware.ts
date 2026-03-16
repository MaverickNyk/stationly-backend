import { Request, Response, NextFunction } from 'express';
import { db, auth } from '../config/firebase';

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
     * ZERO reads per request after initial sync.
     */
    static initializeKeyRegistryListener() {
        if (this.isInitialized) return;

        console.log("AUTH: 🔄 Initializing real-time API Key registry...");
        
        db.collection('api_keys').onSnapshot(snapshot => {
            const newCache = new Map<string, any>();
            
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.status === 'active' && data.key) {
                    newCache.set(data.key, {
                        id: data.clientId || doc.id,
                        tier: data.tier || 'free',
                        name: data.clientName || 'Unknown Client'
                    });
                }
            });

            this.keyCache = newCache;
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
