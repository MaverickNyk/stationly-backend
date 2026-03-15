# Stationly Unified Backend 🚉

The `stationly-backend` is the primary, high-performance API Gateway and User Management system for the Stationly mobile and web applications. It serves as the modern Node.js replacement for the public-facing components of the legacy Java `StationlyBE` monolith.

The backend leverages a Server-Driven UI (SDUI) architecture, robust caching via Firestore, and acts as a transparent proxy to the Transport for London (TfL) API, ensuring maximum speed while respecting rate limits.

---

## 🏗️ Architecture

The Stationly ecosystem is split into a **Two-Tier Backend Architecture**:

1.  **StationlyBE (Java)**: The **Pure Syncer**. Runs purely in the background on the OCI server. It polls TfL data periodically and synchronizes it directly to Firebase/Firestore. It pushes real-time arrival predictions via FCM. It exposes *no public endpoints*.
2.  **stationly-backend (Node.js)**: The **Public API Gateway** (This project). It handles all incoming traffic from the iOS/Android and Web Apps. It serves user profile operations, reads live station info from Firestore, caches heavy TfL Route Data, handles authentication state, and provides the SDUI layouts that build the mobile apps out of thin air.

---

## 🚀 Key Features

*   **Server-Driven UI (SDUI)**: Delivers dynamic JSON payloads to render the Login, Registration, Password Reset, Profile, and multi-step Station Selection screens natively on mobile apps.
*   **Firestore & TfL Hybrid Retrieval**: Fast data retrieval. It queries Firestore first (populated by the Java worker). On cache miss (e.g. searching for a station), it flawlessly falls back to the TfL API, serves the client, and asynchronously patches the database.
*   **TfL Rate-Limiter**: Implements a strict 300 requests/minute (210ms throttle) to prevent bans, mirroring the robust logic of the old Java system.
*   **User Management**: Syncs users, subscriptions, and layout preferences with Firebase Authentication.
*   **Modern Documentation**: Automatically generates rich OpenAPI documentation served on an elegant Scalar UI interface.

---

## 🛠️ Tech Stack

*   **Runtime**: Node.js (TypeScript)
*   **Framework**: Express.js
*   **Database**: Google Cloud Firestore / Firebase Admin SDK
*   **API Gateway**: Axios (with custom rate-limiting interceptors)
*   **Documentation**: Swagger-JSDoc + Scalar UI
*   **Security**: Helmet, CORS

---

## 💻 Local Setup

1.  **Clone the Repository**
2.  **Install Dependencies**: `npm install`
3.  **Environment Variables**: Create a `.env` file in the root based on `.env.example`:
    ```env
    PORT=3000
    TFL_APP_KEY=your_tfl_app_key_here
    TFL_API_TIMEOUT=30000
    FIREBASE_SERVICE_ACCOUNT_PATH=./path/to/firebase-credentials.json
    FIREBASE_DATABASE_URL=https://your-project.firebaseio.com
    ```
4.  **Run Development Server**: `npm run dev`
5.  **View API Docs**: Navigate to `http://localhost:3000/docs`

---

## 📍 API Overview

Interactive documentation is available at **`/docs`** once the server is running. Key routes include:

*   **SDUI Layouts**: `/api/v1/sdui/app/*` (Layouts for Login, Profile, etc.)
*   **Transport Modes**: `/api/v1/modes`
*   **Lines & Routes**: `/api/v1/lines/mode/:mode`, `/api/v1/lines/:lineId/route`
*   **Stations**: `/api/v1/stations/search`, `/api/v1/stations/line/:lineId`
*   **Users**: `/api/v1/user/sync/*`

---

## ☁️ Deployment Strategy (Oracle Cloud)

The application will be deployed to the same Oracle Cloud instance as the Java Syncer, managed by PM2, and reverse-proxied by NGINX.

### 1. NGINX Configuration Update
The current NGINX setup routes all traffic on `api.stationly.co.uk` to the Java backend at port 8080.
**Goal**: Point NGINX root `/` and `/api/v1` to the new Node.js backend port (e.g., `3000`), while keeping the background java worker completely internal.

```nginx
# Location: /etc/nginx/sites-available/api.stationly.co.uk
server {
    server_name api.stationly.co.uk;
    listen 443 ssl; 

    # Redirect root directly to the new Scalar docs
    location = / {
        return 301 https://api.stationly.co.uk/docs;
    }

    # Proxy all API requests to the Node.js Backend on port 3000
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 2. Node.js Deployment Script
A bash script (`.scripts/deploy.sh`) will be used to automate pushing the code to the Oracle server, updating NPM packages, building the TypeScript project, and restarting PM2.

**Deployment Steps via `deploy.sh`**:
1. Run `npm run build` locally to ensure code compiles.
2. `rsync` or `scp` the `package.json`, `package-lock.json`, `tsconfig.json`, `src/`, and `public/` directories to the server (excluding `node_modules`).
3. SSH into the server to run:
   * `npm ci` (clean install production dependencies).
   * `npm run build` (generate `dist` folder).
   * `pm2 restart stationly-backend` (seamless restart).

This architecture ensures a zero-downtime, fully automated deployment pipeline for the new Node.js gateway.
