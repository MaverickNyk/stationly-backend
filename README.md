# Stationly Unified Backend 🚀

The **Stationly Unified Backend** is a high-performance, TypeScript-powered API service designed to centralize user management, authentication synchronization, and a flexible Server-Driven UI (SDUI) engine for the Stationly ecosystem.

## 🌟 Key Features

- **Server-Driven UI (SDUI)**: Dynamically control mobile and web app layouts (Login, Profile, Station Selection) from the backend without waiting for app store updates.
- **User Profile Sync**: seamlessly synchronize user information and preferences between Firebase Auth and Firestore.
- **Station Management**: Manage user-specific station subscriptions with real-time Firestore persistence.
- **TfL Integration Proxy**: dynamic fetching of London Underground modes, lines, directions, and stations via a proxied TfL service.
- **Security First**: Implements `helmet` for security headers, `cors` for cross-origin management, and `morgan` for detailed request logging.

---

## 🛠️ Technology Stack

| Technology | Purpose |
| :--- | :--- |
| **TypeScript** | Type-safe development and modern JS features |
| **Express.js** | Fast, unopinionated web framework for Node.js |
| **Firestore** | Scalable NoSQL database for user profiles and subscriptions |
| **Firebase Admin** | Secure server-side interaction with Firebase services |
| **Axios** | HTTP client for external TfL data fetching |
| **Nodemon** | Hot-reloading development server |

---

## 📁 Project Structure

```text
stationly-backend/
├── src/
│   ├── config/             # Configuration files (Firebase, environment)
│   ├── controllers/        # Request handlers (SDUI, User)
│   ├── middleware/         # Express middlewares
│   ├── models/             # Data models and interfaces
│   ├── routes/             # API route definitions
│   ├── services/           # Business logic (Firestore, TfL, SDUI)
│   └── server.ts           # Application entry point
├── dist/                   # Compiled JavaScript output
├── tsconfig.json           # TypeScript configuration
└── package.json            # Dependencies and scripts
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v16+ recommended
- **Firebase Project**: A Firebase service account key (`serviceAccountKey.json`)
- **Environment Variables**: A `.env` file in the root directory

### Setup Instructions

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd stationly-backend
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Environment Setup**:
   Create a `.env` file and add the following:
   ```env
   PORT=3000
   FIREBASE_PROJECT_ID=your-project-id
   FIREBASE_KEY_PATH=./path/to/serviceAccountKey.json
   ```

4. **Run in Development**:
   ```bash
   npm run dev
   ```

5. **Build for Production**:
   ```bash
   npm run build
   npm start
   ```

---

## 📡 API Documentation (v1)

Base URL: `http://localhost:3000/api/v1`

### 🎨 Server-Driven UI (SDUI)

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/sdui/app/layout` | `GET` | Fetches the Dynamic Station Selection layout |
| `/sdui/app/login` | `GET` | Fetches the Login Screen layout |
| `/sdui/app/profile/:uid` | `GET` | Fetches the Profile Screen layout for a specific user |
| `/sdui/app/data/:type` | `GET` | Fetches dynamic dropdown data (modes, lines, etc.) |

### 👤 User & Station Sync

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/user/sync/profile` | `POST` | Syncs user auth details to the database |
| `/user/sync/stations` | `POST` | Bulk syncs local subscriptions to the cloud |
| `/user/stations/add` | `POST` | Subscribes a user to a new station |
| `/user/stations/delete`| `POST` | Unsubscribes a user from a station |

---

## 🧩 Architecture Overview

For a detailed deep dive into the SDUI patterns, Firestore data models, and TfL integration, please see the [Architecture Documentation](./ARCHITECTURE.md).

### 1. SDUI Engine
The `SduiService` serves "Blueprints". Each blueprint is a JSON object containing components (inputs, buttons, text, dropdowns) with defined actions and themes. The frontend renders these components natively.

### 2. User Service
The `UserService` manages Firestore documents. It handles the "Create or Update" logic for users and manages an array of `SubscribedStation` objects within the user's document.

### 3. TfL Proxy
The `TflService` uses `axios` to fetch live data from external services, transforming them into simplified labels and IDs used by the SDUI dropdowns.

---

## 🤝 Contributing

1. Fork the project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License
This project is private and intended for use within the Stationly ecosystem.
