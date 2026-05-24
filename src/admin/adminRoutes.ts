import { Router } from 'express';
import { AdminAuthMiddleware } from './adminAuthMiddleware';
import { NotificationController } from './notificationController';

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

export default adminRouter;
