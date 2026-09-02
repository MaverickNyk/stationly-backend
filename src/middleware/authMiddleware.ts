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
            // ── `checkRevoked: true` is load-bearing, not belt-and-braces ──
            //
            // Without it this only verifies the SIGNATURE and expiry, so a token
            // minted before its user was deleted keeps working for the rest of
            // its ~1h life. That is not a theoretical window: a second device
            // that had not yet noticed the deletion used it to call
            // `/user/sync/profile`, which re-created the account document, and
            // the "deleted" account came back as an orphan holding real boards.
            //
            // The flag makes Firebase check the user record — deleted, disabled,
            // or tokens revoked — so a deletion takes effect on the very next
            // request from every device, whether or not the push reached them.
            // That costs a lookup per authenticated request, which is the right
            // trade on `/user/*`: these are the routes that mutate the account,
            // they are not on any hot path, and the alternative is trusting a
            // credential whose owner may no longer exist.
            const decodedToken = await auth.verifyIdToken(idToken, true);
            (req as any).user = {
                uid: decodedToken.uid,
                email: decodedToken.email,
                emailVerified: decodedToken.email_verified === true
            };
            
            // Reject any attempt to act on a DIFFERENT user's id than the one
            // proven by the token — covers path param, body, AND query string.
            // GET /user/sync/profile?uid=… reads the query param, which was
            // previously unchecked → an IDOR letting any authenticated user read
            // another user's profile. The authoritative uid is decodedToken.uid.
            const requestedUid = req.params.uid || req.body?.uid || req.query?.uid;
            if (requestedUid && requestedUid !== decodedToken.uid) {
                return res.status(403).json({
                    error: "Forbidden",
                    message: "Access to other user ID denied."
                });
            }

            next();
        } catch (err: any) {
            // Two very different 401s, and a client must be able to tell them
            // apart: an expired token is fixed by refreshing and retrying, while
            // a gone account must end the session on the device. Both used to
            // return the same opaque message, so a client could only guess — and
            // guessing "expired" for a deleted account is what leaves a ghost
            // session running.
            const gone = err?.code === 'auth/id-token-revoked'
                || err?.code === 'auth/user-not-found'
                || err?.code === 'auth/user-disabled';
            return res.status(401).json({
                error: "Unauthorized",
                code: gone ? 'account_gone' : 'token_invalid',
                message: gone
                    ? "This account is no longer active. Sign in again."
                    : "Invalid Firebase ID Token."
            });
        }
    }

    static getIsReady() {
        return this.isInitialized;
    }
}
