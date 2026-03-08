import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import * as dotenv from 'dotenv';
import apiRoutes from './routes/apiRoutes';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
    res.json({ status: "Stationly Unified Backend Online" });
});

app.use('/api/v1', apiRoutes);

// Start Server
app.listen(port, () => {
    console.log(`--- [STATIONLY UNIFIED BACKEND LIVE] ---`);
    console.log(`Port: ${port}`);
    console.log(`Endpoint: http://localhost:${port}/api/v1`);
});
