import { Router } from 'express';
import { AdminAuthMiddleware } from './adminAuthMiddleware';
import { NotificationController } from './notificationController';
import { NOTIFICATION_POLICY_KEYS, NotificationPolicyService } from '../services/notificationPolicyService';
import { FeatureFlagService } from '../services/featureFlagService';
import { StationStatusService } from '../services/stationStatusService';
import { AdminUserController } from './adminUserController';
import { AdminDataController } from './adminDataController';
import { AdminEmailController } from './adminEmailController';
import { DevicePushController } from '../controllers/devicePushController';

/**
 * Admin-only routes — guarded by [AdminAuthMiddleware] which checks
 * the dedicated `X-Stationly-Admin-Key` header (NOT the client
 * `X-Stationly-Key`). Mounted in server.ts at `/api/v1/admin/*` —
 * NOT at a bare `/admin/*`, because staging + prod nginx only forward
 * `/api/v1/*` upstream; see the mount site for the full reason.
 *
 * This file is not walked by the swagger spec scanner, which globs
 * `src/controllers/*`. That is NOT the same as "admin operations
 * cannot reach the public spec" — the scanner follows FILES, not
 * routers, so a handler that lives in `src/controllers/` and is
 * mounted here is scanned like any other. That is exactly what
 * happened: `DevicePushController.send` / `.status` sit in
 * `src/controllers/devicePushController.ts` and carried `@swagger`
 * blocks, which published `/admin/device-push/*` to `/docs`.
 *
 * Important:
 *   - Do NOT register controllers here that have `@swagger` JSDoc
 *     annotations — see above; this has already bitten once. If a
 *     shared controller must be mounted here, its admin handlers get
 *     plain JSDoc, never `@swagger`.
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

// GET /admin/notifications/policy
//   Every notification rule: its value, where that came from (live, env or
//   default), what it does and what it accepts.
adminRouter.get('/notifications/policy', (_req, res) => {
    const effective = NotificationPolicyService.effective();
    const known = NOTIFICATION_POLICY_KEYS.map(p => ({
        key: p.key, ...effective[p.key], default: p.value, env: p.env, spec: p.spec, about: p.about,
    }));
    const extra = Object.keys(effective).filter(key => !NOTIFICATION_POLICY_KEYS.some(p => p.key === key))
        .map(key => ({ key, ...effective[key] }));
    res.json({ keys: [...known, ...extra] });
});

// PUT /admin/notifications/policy
//   { set: { "notify.line.maxPerDay": "2", "notify.quiet.start": null }, reason, by?, push? }
//   Live, no deploy or restart. null removes an override. All or nothing: one
//   bad value refuses the whole edit. `push: true` also tells phones to refetch.
adminRouter.put('/notifications/policy', async (req, res) => {
    const edit = {
        set: (req.body?.set ?? {}) as Record<string, string | null>,
        reason: String(req.body?.reason ?? ''),
        by: String(req.body?.by ?? 'admin').slice(0, 80),
    };
    const errors = NotificationPolicyService.editErrors(edit);
    if (errors.length) return res.status(400).json({ ok: false, errors });
    try {
        await NotificationPolicyService.applyEdit(edit);
        console.log(`NOTIFY_POLICY: ${Object.keys(edit.set).join(', ')} changed by ${edit.by}`);
    } catch (e: any) {
        return res.status(500).json({ ok: false, errors: [e?.message ?? 'save failed'] });
    }
    // Saved is saved, even if the push is not: the two are reported separately.
    let pushed: string | null = null;
    if (req.body?.push === true) {
        try { pushed = await NotificationPolicyService.pushConfigRefresh(edit.reason); }
        catch (e: any) { console.warn('NOTIFY_POLICY: refresh push failed', e?.message); }
    }
    return res.json({ ok: true, pushed });
});

// GET /admin/flags
//   Every feature flag: what it does, where it is on, and what says so.
adminRouter.get('/flags', (_req, res) => res.json({ flags: FeatureFlagService.describe() }));

// PUT /admin/flags
//   { set: { "stationStatus.show": true, "x.show": { "android": false }, "y": null }, reason, by?, push? }
//   Live in seconds, no deploy. null removes the override. All or nothing.
//   `push: true` also tells phones to refetch; app flags only.
adminRouter.put('/flags', async (req, res) => {
    const edit = { set: req.body?.set, reason: req.body?.reason, by: String(req.body?.by ?? 'admin').slice(0, 80) };
    const errors = FeatureFlagService.editErrors(edit);
    if (errors.length) return res.status(400).json({ ok: false, errors });
    try {
        await FeatureFlagService.applyEdit(edit);
        console.log(`FLAGS: ${JSON.stringify(edit.set).slice(0, 300)} by ${edit.by}`);
    } catch (e: any) {
        return res.status(500).json({ ok: false, errors: [e?.message ?? 'save failed'] });
    }
    let pushed: string | null = null;
    if (req.body?.push === true) {
        try { pushed = await NotificationPolicyService.pushConfigRefresh(`flags: ${edit.reason}`); }
        catch (e: any) { console.warn('FLAGS: refresh push failed', e?.message); }
    }
    return res.json({ ok: true, pushed });
});

// GET /admin/station-status           what the Syncer last said
// GET /admin/station-status/report    what its log has learned, ?days=7 (1 to 30)
adminRouter.get('/station-status', async (_req, res) => res.json(await StationStatusService.describe()));
adminRouter.get('/station-status/report', async (req, res) => {
    const days = Math.min(30, Math.max(1, Math.floor(Number(req.query.days)) || 7));
    try { res.json(await StationStatusService.report(days)); }
    catch (e: any) { res.status(500).json({ error: e?.message ?? 'report failed' }); }
});

// POST /admin/config/refresh-push   body: { reason?: string }
//   Silent `config_refresh` push to every install (topic `stationly_all`):
//   phones refetch home-config within ~2 minutes (each waits a random 0-120 s
//   so the fetches are spread). Send it after changing a NOTIFY_* value so a
//   quieter alert policy (or the kill switch) lands in minutes, not on each
//   user's next app open. Shows nothing on the phone.
adminRouter.post('/config/refresh-push', async (req, res) => {
    try {
        const reason = String(req.body?.reason ?? 'admin').slice(0, 80);
        const messageId = await NotificationPolicyService.pushConfigRefresh(reason);
        console.log(`ADMIN_CONFIG: 📤 config_refresh pushed (${reason}) id=${messageId}`);
        res.json({ ok: true, messageId });
    } catch (e: any) {
        console.warn('ADMIN_CONFIG: config_refresh push failed', e?.message);
        res.status(500).json({ ok: false, error: e?.message ?? 'send failed' });
    }
});

// POST /admin/widget-push/send
//   Trigger an immediate iOS widget update over APNs. Four kinds:
//     widget.refresh  — refetch now, optionally scoped to `stations`
//     policy.update   — refetch the refresh SCHEDULE (lands even when the
//                       app is not running)
//     boost.start     — promote to a denser tier for up to the policy ceiling
//     boost.stop      — end a boost early (boosts self-expire regardless)
//   Signals only, never departure data — the client fetches. See
//   DevicePushService for why, and for the delivery guarantees (there are
//   none: this makes boards fresher sooner, it is not the schedule).
adminRouter.post('/device-push/send', DevicePushController.send);

// GET /admin/widget-push/status
//   Whether APNs is configured and how many devices are registered, by token
//   type and environment. Counts only — tokens never leave the backend.
adminRouter.get('/device-push/status', DevicePushController.status);

// POST /admin/email/android-launch
//   Send the Android launch notification email. Supports target: "test" or "all".
adminRouter.post('/email/android-launch', AdminEmailController.sendAndroidLaunch);

// POST /admin/email/ios-launch
//   Send the iOS launch notification email. Supports target: "test" or "all".
adminRouter.post('/email/ios-launch', AdminEmailController.sendIosLaunch);

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

// GET /admin/users/:uid — full user detail (profile, sessions/devices,
// subscribed stations). Cache-first (0 reads); see AdminDataController.
adminRouter.get('/users/:uid/activity', AdminDataController.userActivity);
adminRouter.get('/users/:uid', AdminDataController.userDetail);
adminRouter.get('/analytics/overview', AdminDataController.platformOverview);
adminRouter.get('/analytics/usage', AdminDataController.usage);
adminRouter.post('/analytics/import-activity', AdminDataController.importActivity);
adminRouter.get('/sync-status', AdminDataController.syncStatus);
adminRouter.get('/support/summary', AdminDataController.supportSummary);

// --- Read-only data views (dashboard, users, waitlist, subscribed) -------
// All serve from in-memory caches + SQLite. The only ones that can touch
// Firestore are /users and /waitlist with `?refresh=1` (one read, on demand).
adminRouter.get('/stats', AdminDataController.stats);
adminRouter.get('/users', AdminDataController.users);
adminRouter.get('/waitlist', AdminDataController.waitlist);
adminRouter.get('/subscribed-stations', AdminDataController.subscribedStations);

export default adminRouter;
