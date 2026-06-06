import { Router } from 'express';
import { AdminAuthMiddleware } from './adminAuthMiddleware';
import { NotificationController } from './notificationController';
import { AdminUserController } from './adminUserController';
import { AdminDataController } from './adminDataController';

/**
 * Admin-only routes — guarded by [AdminAuthMiddleware] which checks
 * the dedicated `X-Stationly-Admin-Key` header (NOT the client
 * `X-Stationly-Key`). Mounted in server.ts at `/admin/*` so it lives
 * outside `/api/v1/*` and stays off the swagger-generated OpenAPI
 * doc (the spec scanner only walks `apiRoutes.ts`).
 *
 * Important:
 *   - Do NOT register controllers here that have `@swagger` JSDoc
 *     annotations. The spec scanner doesn't walk this file today
 *     but a future scanner change could; better to keep admin
 *     handlers free of swagger comments as a defence-in-depth.
 *   - Do NOT mix this with the public `validateApiKey` middleware.
 *     The admin key is a different trust class.
 *   - Add operations to this router VERY sparingly. Anything here
 *     bypasses normal client auth.
 */
const adminRouter = Router();

// Every admin route gates on the admin key.
adminRouter.use(AdminAuthMiddleware.validate);

// POST /admin/notifications/send
//   Fan out a NotificationPayload to one of: a token, a list of
//   tokens (≤500 — FCM multicast cap), or an FCM topic.
//   See NotificationController + NotificationService for the request
//   shape and response semantics.
adminRouter.post('/notifications/send', NotificationController.send);

// GET /admin/notifications/history
//   Recent admin sends from the LOCAL audit log (SQLite — zero Firestore
//   cost). Raw tokens are never stored, so never returned.
adminRouter.get('/notifications/history', NotificationController.history);

// GET /admin/users/:uid/tokens
//   Registered-device COUNT for a uid (never the raw tokens). Powers the
//   console's audience-lookup screen — "does this uid resolve, and to how
//   many devices?". Cache-first read (UserFcmTokenService); `?fresh=1`
//   forces a live Firestore read.
adminRouter.get('/users/:uid/tokens', AdminUserController.getTokenStats);

// --- Read-only data views (dashboard, users, waitlist, subscribed) -------
// All serve from in-memory caches + SQLite. The only ones that can touch
// Firestore are /users and /waitlist with `?refresh=1` (one read, on demand).
adminRouter.get('/stats', AdminDataController.stats);
adminRouter.get('/users', AdminDataController.users);
adminRouter.get('/waitlist', AdminDataController.waitlist);
adminRouter.get('/subscribed-stations', AdminDataController.subscribedStations);

export default adminRouter;
