import { Router } from 'express';
import { SduiController } from '../controllers/sduiController';
import { ThemeController } from '../controllers/themeController';
import { UserController } from '../controllers/userController';
import { AuthController } from '../controllers/authController';
import { ModeController } from '../controllers/modeController';
import { LineController } from '../controllers/lineController';
import { StationController } from '../controllers/stationController';
import { AuthMiddleware } from '../middleware/authMiddleware';
import { RateLimitMiddleware } from '../middleware/rateLimitMiddleware';

const router = Router();

// --- GLOBAL SECURITY ---
// Every single request to Stationly API now requires a valid X-Stationly-Key
router.use(AuthMiddleware.validateApiKey);

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
router.get('/sdui/app/home-announcement', SduiController.getHomeAnnouncement);
router.get('/sdui/app/home-config', SduiController.getHomeConfig);
router.get('/sdui/app/theme-tokens', ThemeController.getAppThemeTokens);

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

// --- USER PRIVATE ROUTES (Key + Firebase Auth Required) ---
router.use('/user', AuthMiddleware.validateUserToken);
router.use('/user', RateLimitMiddleware.strict);

router.get('/user/sync/profile', UserController.getUserProfile);
// Returns a user's profile rendered as SDUI — must be user-auth gated (and the
// :uid is checked against the token by validateUserToken) so it can't leak one
// user's profile to anyone holding the shared app key.
router.get('/sdui/app/profile/:uid', AuthMiddleware.validateUserToken, UserController.getSduiProfile);
router.post('/user/sync/profile', UserController.syncProfile);
router.post('/user/sync/stations', UserController.syncStations);
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
// Send Stationly-branded verification email for the authenticated user. Lives
// under /user/* (not /auth/*) so StationlyAuth on the client automatically
// attaches the Bearer token — /auth/* endpoints are public-by-default.
// Dedicated 5/15min-per-uid limiter applied AFTER the generic /user/* strict
// limiter that the router.use() above already installs — so this endpoint is
// effectively limited by whichever fires first.
router.post('/user/send-verification-email', RateLimitMiddleware.verifyEmail, AuthController.sendVerification);

export default router;
