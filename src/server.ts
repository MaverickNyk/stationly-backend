import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import * as dotenv from 'dotenv';
import apiRoutes from './routes/apiRoutes';
import { LiveUpdateService } from './services/liveUpdateService';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// Serving icons from the public directory
app.use('/icons', express.static(path.join(process.cwd(), 'public', 'icons')));

// Routes
app.get('/', (req, res) => {
    res.json({ status: "Stationly Unified Backend Online" });
});

app.use('/api/v1', apiRoutes);

// Start Server & Background Services
app.listen(port, () => {
    console.log(`\n--- [STATIONLY UNIFIED BACKEND LIVE] ---`);
    console.log(`Port: ${port}`);
    console.log(`Endpoint: http://localhost:${port}/api/v1`);
    
    // Start background FCM engine for live board simulation
    LiveUpdateService.start();
});
