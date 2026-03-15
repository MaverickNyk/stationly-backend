import { Router } from 'express';
import { SduiController } from '../controllers/sduiController';
import { UserController } from '../controllers/userController';
import { ModeController } from '../controllers/modeController';
import { LineController } from '../controllers/lineController';
import { StationController } from '../controllers/stationController';

const router = Router();

// --- SDUI Layout Routes ---
router.get('/sdui/app/layout', SduiController.getSelectionLayout);
router.get('/sdui/app/login', SduiController.getLoginLayout);
router.get('/sdui/app/register', SduiController.getRegisterLayout);
router.get('/sdui/app/forgot-password', SduiController.getForgotPasswordLayout);
router.get('/sdui/app/profile/:uid', UserController.getSduiProfile);

// --- Mode Routes ---
router.get('/modes', ModeController.getModes);

// --- Line Routes ---
router.get('/lines/mode/:mode', LineController.getLinesByMode);
router.get('/lines/status', LineController.getLineStatuses);
router.get('/lines/:lineId/route', LineController.getLineRoute);

// --- Station Routes ---
router.get('/stations/line/:lineId', StationController.getStationsByLine);
router.get('/stations/search', StationController.searchStations);
router.get('/stations/predictions/:naptanId', StationController.getStationPredictions);

// --- User Profile & Station Sync Routes ---
router.get('/user/sync/profile', UserController.getUserProfile);
router.post('/user/sync/profile', UserController.syncProfile);
router.post('/user/sync/stations', UserController.syncStations);
router.post('/user/stations/add', UserController.addStation);
router.post('/user/stations/delete', UserController.deleteStation);
router.post('/user/logout', UserController.logOut);

export default router;
