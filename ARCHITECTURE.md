# Stationly Backend Architecture Documentation 🏗️

This document provides a deep dive into the architectural patterns and data models used in the Stationly Unified Backend.

---

## 1. Server-Driven UI (SDUI) Pattern

Stationly uses a **Server-Driven UI** approach to maintain maximum flexibility across multiple platforms (Android, iOS, Web). Instead of hardcoding UI components in the app, the app requests a "layout blueprint" from the backend.

### Why SDUI?
- **Instant Updates**: Change button colors, labels, or screen flow without a new app release.
- **Dynamic Content**: Inject different components based on time of day, user status, or premium subscription.
- **Unified Logic**: Validation and data sourcing happen in one place (the backend).

### Component Types
The backend currently supports the following UI primitives:
- `text`: Displays titles, subtitles, or body text.
- `input`: Text fields for user input.
- `button`: Interactive elements triggering defined actions (e.g., `LOGIN_ACTION`).
- `dropdown`: Selectable lists with local or remote (API-driven) data sources.
- `image`: Displays images or profile pictures.

### The Blueprints
Layouts are served from the `SduiService`. A typical blueprint looks like this:
```json
{
  "id": "station_selection_screen",
  "title": "Setup",
  "components": [
    {
      "type": "dropdown",
      "id": "mode",
      "label": "1. Select Mode",
      "dataSourceUrl": "/sdui/app/data/modes"
    },
    ...
  ]
}
```

---

## 2. User & Subscription Data Model

All user data is stored in **Google Cloud Firestore** under the `users` collection.

### User Document (`users/{uid}`)
```typescript
interface UserProfile {
    uid: string;           // Firebase Auth UID
    email: string;
    displayName: string;
    photoURL?: string;
    address?: string;
    stations: SubscribedStation[]; // Array of pinned stations
    createdAt: string;     // ISO timestamp
    updatedAt: string;     // ISO timestamp
}
```

### Subscribed Station Object
Each entry in the `stations` array represents a user-tracked London Transport route.
```typescript
interface SubscribedStation {
    id: string;        // TfL NaptanId (e.g. "940GZZLUPCO")
    name: string;      // Station common name
    line: string;      // TfL Line ID (e.g. "piccadilly")
    mode: string;      // e.g. "tube", "dlr"
    direction: string; // "inbound" or "outbound"
}
```

---

## 3. External API Integration (TfL Proxy)

The backend acts as a smart proxy for the **Transport for London (TfL)** API. This layer performs data transformation to ensure the frontend only receives clean, ready-to-display labels.

### Data Transformation Logic
1. **Fetch**: `TflService` calls internal or legacy TfL endpoints.
2. **Cleanse**: Simplifies complex TfL response structures.
3. **Format**: Prepends directions (e.g., "Inbound towards...") and removes redundant suffixes like "DLR Station".
4. **Deliver**: Sends a simple `id/label` array back to the SDUI dropdowns.

---

## 4. Middleware Stack

| Middleware | Description |
| :--- | :--- |
| `helmet` | Sets secure HTTP headers (XSS protection, Content Security Policy). |
| `cors` | Restricts API access to authorized domains. |
| `morgan` | Provides "dev" style console logging for all requests. |
| `express.json()`| Parses incoming JSON payloads into `req.body`. |

---

## 5. Environment Configuration

The application uses `dotenv` to load configurations. Key variables:
- `PORT`: Port the Express server runs on.
- `GOOGLE_APPLICATION_CREDENTIALS`: Path to your Firebase service account key.
- `FIREBASE_PROJECT_ID`: Your unique Firebase project identifier.
