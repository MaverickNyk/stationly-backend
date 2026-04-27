import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import * as dotenv from 'dotenv';
import swaggerJsdoc from 'swagger-jsdoc';
import apiRoutes from './routes/apiRoutes';
import { AuthMiddleware } from './middleware/authMiddleware';
import { DataCacheService } from './services/dataCacheService';
import { WaitlistController } from './controllers/waitlistController';
import { RateLimitMiddleware } from './middleware/rateLimitMiddleware';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Trust Nginx reverse proxy so req.ip reflects the real client IP (X-Forwarded-For)
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: false, // Scalar needs this for its assets
}));
app.use(morgan('dev'));
app.use(express.json());

// Serving icons from the public directory
app.use('/icons', express.static(path.join(process.cwd(), 'public', 'icons')));
app.use('/assets', express.static(path.join(process.cwd(), 'public', 'assets')));

// Smart deep link redirect — used in email CTAs
// ?deep=stationly%3A%2F%2Fauth  &web=https%3A%2F%2Fstationly.co.uk
// Tries to open the app; falls back to web URL after 1.5s if app isn't installed
app.get('/open', (req, res) => {
    const deep = typeof req.query.deep === 'string' ? decodeURIComponent(req.query.deep) : 'stationly://';
    const web  = typeof req.query.web  === 'string' ? decodeURIComponent(req.query.web)  : 'https://stationly.co.uk';
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Stationly…</title>
<style>
  body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,sans-serif;}
  .card{text-align:center;padding:40px 32px;}
  .logo{font-size:32px;font-weight:900;color:#FFB81C;letter-spacing:-1px;margin-bottom:12px;}
  p{color:#666;font-size:14px;margin:0 0 24px;}
  a{color:#FFB81C;font-size:13px;}
</style>
</head><body>
<div class="card">
  <div class="logo">STATIONLY</div>
  <p>Opening the app…</p>
  <a href="${web}">Open in browser instead</a>
</div>
<script>
  var tried = false;
  function tryOpen() {
    if (tried) return;
    tried = true;
    window.location = ${JSON.stringify(deep)};
    setTimeout(function() { window.location = ${JSON.stringify(web)}; }, 1500);
  }
  tryOpen();
</script>
</body></html>`);
});

// OpenAPI Configuration
const swaggerOptions = {
    definition: {
        openapi: '3.1.0',
        info: {
            title: 'Stationly API documentation',
            version: 'v1.0.0',
            description: `
Welcome to the Stationly API Documentation. 

Stationly provides a high-performance middleware for transport data, specializing in TfL (Transport for London) integration. Our API offers real-time arrival predictions, station metadata, and live line status updates.

### Key Features
*   **Real-time Predictions**: Accurate arrival times for Tube, Overground, DLR, and more.
*   **Station Metadata**: Detailed information about stations including coordinates and available modes.
*   **Line Status**: Live updates on delays, closures, and service changes.
*   **SDUI Integration**: Server-Driven UI layouts for dynamic app screens.
            `,
            contact: {
                name: 'Stationly Limited',
                email: 'support@stationly.co.uk'
            },
            license: {
                name: 'Apache 2.0',
                url: 'http://www.apache.org/licenses/LICENSE-2.0.html'
            }
        },
        servers: [
            {
                url: 'https://api.stationly.co.uk/api/v1',
                description: 'Production Server'
            },
            {
                url: `http://localhost:${port}/api/v1`,
                description: 'Local Development Server'
            }
        ],
        components: {
            securitySchemes: {
                StationlyKey: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'X-Stationly-Key',
                    description: 'Your Stationly Developer API Key'
                },
                FirebaseToken: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'Firebase ID Token for user-specific data access'
                }
            },
            schemas: {
                TransportMode: {
                    type: 'object',
                    properties: {
                        modeName: { type: 'string', example: 'tube' },
                        displayName: { type: 'string', example: 'Underground' },
                        id: { type: 'string', example: 'tube' },
                        label: { type: 'string', example: 'Underground' },
                        iconUrl: { type: 'string', example: 'https://api.stationly.co.uk/icons/tube.png' }
                    }
                },
                LineInfo: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'victoria' },
                        name: { type: 'string', example: 'Victoria' },
                        modeName: { type: 'string', example: 'tube' },
                        label: { type: 'string', example: 'Victoria' }
                    }
                },
                LineStatus: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'central' },
                        name: { type: 'string', example: 'Central' },
                        statusSeverityDescription: { type: 'string', example: 'Good Service' },
                        reason: { type: 'string', example: 'Service is operating normally.' },
                        mode: { type: 'string', example: 'tube' },
                        lastUpdatedTime: { type: 'string', format: 'date-time' }
                    }
                },
                Station: {
                    type: 'object',
                    properties: {
                        naptanId: { type: 'string', example: '940GZZLUEUS' },
                        commonName: { type: 'string', example: 'Euston Underground Station' },
                        lat: { type: 'number', example: 51.5281 },
                        lon: { type: 'number', example: -0.1331 },
                        stopType: { type: 'string', example: 'NaptanMetroStation' },
                        id: { type: 'string', example: '940GZZLUEUS' },
                        label: { type: 'string', example: 'Euston' }
                    }
                },
                SubscribedStation: {
                    type: 'object',
                    properties: {
                        naptanId: { type: 'string', example: '940GZZLUEUS' },
                        commonName: { type: 'string', example: 'Euston' },
                        lineId: { type: 'string', example: 'victoria' },
                        lineName: { type: 'string', example: 'Victoria' },
                        modeName: { type: 'string', example: 'tube' }
                    }
                },
                UserProfile: {
                    type: 'object',
                    properties: {
                        uid: { type: 'string', example: 'user123' },
                        email: { type: 'string', example: 'user@example.com' },
                        displayName: { type: 'string', example: 'John Doe' },
                        stations: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/SubscribedStation' }
                        }
                    }
                },
                UserSyncRequest: {
                    type: 'object',
                    required: ['uid', 'email'],
                    properties: {
                        uid: { type: 'string' },
                        email: { type: 'string' },
                        displayName: { type: 'string' },
                        photoURL: { type: 'string' },
                        signInProvider: { type: 'string' }
                    }
                },
                StationSyncRequest: {
                    type: 'object',
                    required: ['uid', 'stations'],
                    properties: {
                        uid: { type: 'string' },
                        stations: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/SubscribedStation' }
                        }
                    }
                },
                Layout: {
                    type: 'object',
                    properties: {
                        template: { type: 'string', example: 'selection_flow' },
                        data: { type: 'object' }
                    }
                },
                PredictionItem: {
                    type: 'object',
                    properties: {
                        destId: { type: 'string', example: '940GZZLUEDM' },
                        platform: { type: 'string', example: 'Platform 1' },
                        eta: { type: 'string', format: 'date-time' },
                        displayName: { type: 'string', example: 'Upminster' }
                    }
                },
                LinePredictions: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: 'district' },
                        name: { type: 'string', example: 'District' },
                        dirs: {
                            type: 'object',
                            additionalProperties: {
                                type: 'object',
                                properties: {
                                    preds: {
                                        type: 'array',
                                        items: { $ref: '#/components/schemas/PredictionItem' }
                                    }
                                }
                            }
                        }
                    }
                },
                StationPredictionResponse: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', example: '940GZZLUBKG' },
                        name: { type: 'string', example: 'Barking Underground Station' },
                        lut: { type: 'string', format: 'date-time' },
                        lines: {
                            type: 'object',
                            additionalProperties: { $ref: '#/components/schemas/LinePredictions' }
                        }
                    }
                }
            }
        },
        tags: [
            { name: 'Stations', description: 'Access to station metadata, location searching, and line association.' },
            { name: 'Modes', description: 'Transport meta-data for supported London transport modes.' },
            { name: 'Lines', description: 'Live line status, routes, and operational information.' },
            { name: 'Users', description: 'Synchronization of user profiles and personalized station subscriptions.' },
            { name: 'SDUI', description: 'Server-Driven UI layout definitions for dynamic mobile application screens.' },
            { name: 'Auth', description: 'Layout endpoints for authentication flows (Login, Register, Password Reset).' }
        ],
        security: [
            { StationlyKey: [] }
        ]
    },
    apis: [
        path.join(__dirname, './controllers/*.ts'),
        path.join(__dirname, './controllers/*.js')
    ]
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Serve OpenAPI JSON
app.get('/openapi.json', (req, res) => {
    res.json(swaggerSpec);
});

// Scalar API Reference (ESM Dynamic Import Wrapper)
app.use('/docs', async (req, res, next) => {
    try {
        const { apiReference } = await (eval('import("@scalar/express-api-reference")') as Promise<any>);
        apiReference({
            spec: {
                content: swaggerSpec,
            },
            theme: 'default',
        })(req, res, next);
    } catch (error) {
        next(error);
    }
});

// Routes
app.get('/', (req, res) => {
    res.json({ status: "Stationly Unified Backend Online" });
});

// Public — no API key required (website waitlist form)
app.post('/api/v1/waitlist/join', RateLimitMiddleware.strict, WaitlistController.join);

app.use('/api/v1', apiRoutes);

// Start Server
app.listen(port, () => {
    console.log(`\n--- [STATIONLY UNIFIED BACKEND LIVE] ---`);
    DataCacheService.initialize();
    console.log(`Port: ${port}`);
    console.log(`Endpoint: http://localhost:${port}/api/v1`);
    console.log(`Docs: http://localhost:${port}/docs`);
    console.log(`Spec: http://localhost:${port}/openapi.json`);
});
