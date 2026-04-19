import { Router } from 'express';
import { SduiController } from '../controllers/sduiController';
import { UserController } from '../controllers/userController';
import { ModeController } from '../controllers/modeController';
import { LineController } from '../controllers/lineController';
import { StationController } from '../controllers/stationController';
import { AuthMiddleware } from '../middleware/authMiddleware';
import { RateLimitMiddleware } from '../middleware/rateLimitMiddleware';

const router = Router();

// --- GLOBAL SECURITY ---
// Every single request to Stationly API now requires a valid X-Stationly-Key
router.use(AuthMiddleware.validateApiKey);

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
router.get('/sdui/app/profile/:uid', UserController.getSduiProfile);
router.post('/user/sync/profile', UserController.syncProfile);
router.post('/user/sync/stations', UserController.syncStations);
router.post('/user/stations/add', UserController.addStation);
router.post('/user/stations/delete', UserController.deleteStation);
router.post('/user/logout', UserController.logOut);
router.post('/user/delete-account', UserController.deleteAccount);

export default router;
