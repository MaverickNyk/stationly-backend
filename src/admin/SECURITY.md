# Stationly Backend Architecture & Security Manual 🛡️

This document outlines the architectural patterns, security postures, trust classifications, and authorization designs implemented in **`stationly-backend`**. 

Future developers and agentic AI systems MUST read and strictly adhere to the security invariants documented here when modifying the routing, authentication, or administrative interfaces.

---

## 🏗️ 1. Trust Separation Matrix

Stationly enforces a strict **Three-Tier Security Architecture** dividing endpoints into distinct trust classes. Each class employs a different verification technique to ensure that a leak in one tier cannot compromise another.

| Trust Class | Endpoint Prefix | Required Credentials | Primary Defense Mechanism | Intended Clients / Consumers |
| :--- | :--- | :--- | :--- | :--- |
| **Administrative** | `/api/v1/admin/*` | `Authorization: Bearer <STATIONLY_ADMIN_KEY>` | Fails Closed, Constant-Time Comparison, Off-spec | Developers, operations tools, backend cron jobs. |
| **Client API** | `/api/v1/*` | `X-Stationly-Key: <Client_Key>` | Client-level rate limits, key rotation | Mobile apps (iOS & Android), Web app. |
| **Public** | `/api/v1/waitlist/join` | *None* | Strict rate-limiting (`RateLimitMiddleware.strict`) | Public website visitors, launch waitlist. |

---

## 🔒 2. Administrative Security Plan (Authorization Bearer Protocol)

Administrative routes (e.g., fanning out manual push notifications via `/api/v1/admin/notifications/send`) bypass normal user constraints. To secure them, the backend implements the standard **Bearer Token Protocol**.

### The Authorization Header
To make an admin request, clients must send the secret key inside the HTTP standard `Authorization` header:
```http
Authorization: Bearer <STATIONLY_ADMIN_KEY>
```

### Invariant A: "Fail-Closed" Posture (No Fallbacks)
To prevent silent security exposures, the administrative middleware has **zero fallbacks** and strictly **fails closed**. 
* If the environment variable `STATIONLY_ADMIN_KEY` is not configured, is empty, or is insecurely short (`< 16` characters), the middleware **refuses all admin requests** immediately and logs a loud system error, returning an `HTTP 503 Service Unavailable`.
* Under no circumstances may an admin route fall back to a default password or allow requests to pass when keys are missing.

### Invariant B: Timing Attack Protection (Constant-Time Matching)
To protect the system against advanced byte-by-byte timing attacks, the middleware does NOT use standard string equality (`===`).
* Standard comparisons exit early on the first mismatched character, allowing an attacker to measure processing time down to microseconds and guess the key character-by-character.
* We enforce a **cryptographic constant-time comparison** using Node's native `crypto.timingSafeEqual`.
* Even if the incoming key has a length mismatch, the comparison still executes over a dummy buffer to ensure the processing time remains flat.

---

## 📡 3. Public Endpoint Isolation (The Waitlist Design)

Endpoints like `POST /api/v1/waitlist/join` must remain fully open to the public internet because visitors on `stationly.co.uk` need to register for the launch without an active user account.

### Defenses in Place:
* **No Key Requirements**: Do not install client API key checks or admin checks on this route.
* **Strict Throttling**: The route is explicitly bound to `RateLimitMiddleware.strict` (Express-Rate-Limit) to block automated brute-force attacks and resource exhaustion attempts.
* **Off the Admin Domain**: Never register public forms or client-facing registration controls under the `/api/v1/admin` router.

---

## 🚀 4. How to Test Admin Endpoints

When executing curl commands to administrative endpoints, always use the standard `Bearer` authorization schema:

```bash
# Read local secret
KEY=$(grep STATIONLY_ADMIN_KEY .env | cut -d'"' -f2)

# Send authenticated admin notification trigger
curl -X POST https://staging-api.stationly.co.uk/api/v1/admin/notifications/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "audience": { "type": "all" },
    "payload": {
      "type": "announcement",
      "title": "System Update",
      "body": "Staging servers successfully migrated to Bearer Auth."
    }
  }'
```
