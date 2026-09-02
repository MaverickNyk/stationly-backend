import { Router } from 'express';
import { SduiController } from '../controllers/sduiController';
import { SupportMoneyController } from '../controllers/supportMoneyController';
import { ThemeController } from '../controllers/themeController';
import { UserController } from '../controllers/userController';
import { AuthController } from '../controllers/authController';
import { ModeController } from '../controllers/modeController';
import { LineController } from '../controllers/lineController';
import { StationController } from '../controllers/stationController';
import { DevicePushController } from '../controllers/devicePushController';
import { AuthMiddleware } from '../middleware/authMiddleware';
import { RateLimitMiddleware } from '../middleware/rateLimitMiddleware';
import { VersionGateMiddleware } from '../middleware/versionGateMiddleware';

const router = Router();

// --- GLOBAL SECURITY ---
// Every single request to Stationly API now requires a valid X-Stationly-Key
router.use(AuthMiddleware.validateApiKey);

// --- CLIENT VERSION GATE ---
// After the API-key check so "who are you" is answered before "how old are
// you", and before every data route so a client the backend can no longer
// serve is refused on ALL of them rather than on the one screen that happens to
// read config. Exempts /auth/*, the release policy itself, and the two SDUI
// documents the blocking screen is drawn from — see versionGateMiddleware.
// Dormant unless VERSION_GATE_ENABLED=true.
router.use(VersionGateMiddleware.enforce);

// --- AUTH ROUTES (public — no Firebase token required) ---
// Dedicated forgot-password limiter (3/15min per email) — tighter than the generic
// strict limiter so a single email can't be spammed even if the attacker rotates
// API keys / IPs across calls.
router.post('/auth/forgot-password', RateLimitMiddleware.forgotPassword, AuthController.sendPasswordReset);

// --- PUBLIC DATA ROUTES (Per-client rate limits after API Key check) ---
router.use('/modes', RateLimitMiddleware.modes);
router.use('/lines', RateLimitMiddleware.lines);
router.use('/stations', RateLimitMiddleware.stations);
router.use('/sdui', RateLimitMiddleware.sdui);

// Layouts
router.get('/sdui/app/layout', SduiController.getSelectionLayout);
router.get('/sdui/app/login', SduiController.getLoginLayout);
router.get('/sdui/app/register', SduiController.getRegisterLayout);
router.get('/sdui/app/forgot-password', SduiController.getForgotPasswordLayout);
router.get('/sdui/app/about', SduiController.getAboutLayout);
// The widget guide. Cached client-side with a compiled fallback beneath it, so
// this being unreachable degrades to the built-in copy rather than a blank
// screen. See docs/IOS_WIDGET_GUIDE.md in the app repo.
router.get('/sdui/app/widget-guide', SduiController.getWidgetGuideLayout);
router.get('/sdui/app/home-announcement', SduiController.getHomeAnnouncement);
router.get('/sdui/app/home-config', SduiController.getHomeConfig);
router.get('/sdui/app/theme-tokens', ThemeController.getAppThemeTokens);
// Structured support / contributions card config. Same content is also folded
// into /sdui/app/home-config (key `support_money.card.json` + `home.promo.support_money.*`);
// this endpoint serves it as a clean object for platforms that prefer that.
router.get('/sdui/app/support-money-config', SupportMoneyController.getConfig);
// Refresh cadence schedule. Clients cache this and evaluate it locally, so it
// is read on a cold launch and after a `policy.update` push — not per refresh.
router.get('/sdui/app/refresh-policy', SduiController.getRefreshPolicy);
// Version floors + store links, per platform. Exempt from the version gate on
// purpose: a blocked client must still be able to fetch the document that tells
// it why it is blocked and where to go.
router.get('/sdui/app/release-policy', SduiController.getReleasePolicy);

// Metadata
router.get('/modes', ModeController.getModes);
router.get('/lines/mode/:mode', LineController.getLinesByMode);
router.get('/lines/status', LineController.getLineStatuses);
router.get('/lines/:lineId/route', LineController.getLineRoute);
router.get('/stations/line/:lineId', StationController.getStationsByLine);
router.get('/stations/search', StationController.searchStations);
router.get('/stations/nearby', StationController.searchStations);
router.get('/stations/resolve', StationController.resolveStation);
router.get('/stations/predictions/:naptanId', StationController.getStationPredictions);

// --- DEVELOPER/INTERNAL ROUTES ---
router.get(
    '/stations/subscribed-ids', 
    RateLimitMiddleware.developer, 
    StationController.getSubscribedStationIds
);

// --- DEVICE PUSH REGISTRY (API key + Firebase bearer, gated in the handler) ---
//
// ⚠️ These routes REQUIRE a bearer as of P2, and the comment that used to sit
// here said the opposite. It described the pre-P2 rule — API-key-only, because a
// signed-out device still runs widgets and still wants disruption pushes — which
// stopped being true when the device row moved to `users/{uid}/devices/{deviceId}`
// and its existence became the session. There is nowhere to file a registration
// that names no account, so `DevicePushController` answers 401 `no_session`.
//
// Still mounted BEFORE the `/user` prefix below, and that is deliberate: the gate
// is inlined in the handler rather than applied as middleware, so the route can
// tell "no session" (a client-side SKIP, not a retry) apart from the generic
// rejection `validateUserToken` would produce. The client half is the matching
// rule in DevicePushCoordinator: signed out is a skip, never a failure to retry.
//
// The uid is always taken from the verified bearer, never from the body.
router.post('/device/register',   DevicePushController.register);
router.post('/device/unregister', DevicePushController.unregister);

// --- USER PRIVATE ROUTES (Key + Firebase Auth Required) ---
router.use('/user', AuthMiddleware.validateUserToken);
router.use('/user', RateLimitMiddleware.strict);

router.get('/user/sync/profile', UserController.getUserProfile);
// The rev gate's server half. Answered from SQLite, so an app open on an
// unchanged account costs zero Firestore reads — which is the single largest
// item in the read budget (§7 of DESIGN_SESSIONS_AND_SYNC.md). Deliberately
// takes no `?uid=`: the account is whichever one the bearer names.
router.get('/user/state/rev', UserController.getStateRev);
// Returns a user's profile rendered as SDUI — must be user-auth gated (and the
// :uid is checked against the token by validateUserToken) so it can't leak one
// user's profile to anyone holding the shared app key.
router.get('/sdui/app/profile/:uid', AuthMiddleware.validateUserToken, UserController.getSduiProfile);
router.post('/user/sync/profile', UserController.syncProfile);
// LEGACY board list (Android). Kept exactly as it was — see UserService.syncBoards
// for why the v2 list below is a SEPARATE array rather than a wider schema on
// this one.
router.post('/user/sync/stations', UserController.syncStations);
// v2 board list (iOS today, Android later) + the account's settings blob. Both
// are last-write-wins on a client clock and both fan out `user.sync`.
router.post('/user/sync/boards', UserController.syncBoards);
// Activity trail. Its own limiter, mounted AFTER the /user/* strict one above:
// a batch upload is one request carrying a day of events, so it needs far fewer
// calls than the strict limiter allows but must not be able to spend that
// budget and lock a user out of the endpoints that matter.
router.post('/user/activity/batch', RateLimitMiddleware.activity, UserController.recordActivity);
router.post('/user/stations/add', UserController.addStation);
router.post('/user/stations/delete', UserController.deleteStation);
router.post('/user/logout', UserController.logOut);
router.post('/user/delete-account', UserController.deleteAccount);
// FCM token registry — used to make `uid`-targeted admin notifications
// possible. Both routes are user-auth gated (UID comes from the bearer
// token, never from the body) and rate-limited by the /user/* strict
// limiter already installed above.
router.post('/user/fcm/register',   UserController.registerFcmToken);
router.post('/user/fcm/unregister', UserController.unregisterFcmToken);
// (The device push registry does NOT live here. It was first mounted under
// /user/*, which put it behind validateUserToken and 401'd every registration
// from a client carrying only the API key — precisely the signed-out-devices-
// still-register case its own comment promised. See /device/* below.)
// Send Stationly-branded verification email for the authenticated user. Lives
// under /user/* (not /auth/*) so StationlyAuth on the client automatically
// attaches the Bearer token — /auth/* endpoints are public-by-default.
// Dedicated 5/15min-per-uid limiter applied AFTER the generic /user/* strict
// limiter that the router.use() above already installs — so this endpoint is
// effectively limited by whichever fires first.
router.post('/user/send-verification-email', RateLimitMiddleware.verifyEmail, AuthController.sendVerification);

export default router;
