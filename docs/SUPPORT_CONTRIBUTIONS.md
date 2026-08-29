# Stationly Support & Contributions — Master Full-Stack Reference & Session Record

> **Master Reference:** This document unifies and consolidates the full-stack design, backend architecture, mobile client implementation, code review findings, Stripe configuration, and deployment guide for the **Support / Contributions ("Keep Stationly Free")** feature across both `stationly-backend` and `StationlyUI`.

---

## 1. Executive Summary & Philosophy

Every planned premium feature across Stationly is now **free forever** (no paywalls, no ads, no locked stations). Ongoing operational costs (TfL live data feeds, Firestore, push notifications, hosting) are funded through **voluntary developer contributions**:

| Lane | Mechanism | Platform Cut | User Impact |
|---|---|---|---|
| **One-off Contribution** (*Active*) | Stripe Hosted Payment Links via Safari / Web | **0%** (Apple Guideline 3.2.1 allows developer support outside StoreKit) | Grants an account-level **Supporter badge** for 30 days. Nothing functional is gated. |
| **Supporter IAP** (*Phase 2, Deferred*) | StoreKit 2 / Google Play Billing | 15% (Small Business Program) | Optional cosmetic extras & continuous badge. |

### Invariant Rules
1. **Never a Paywall:** Nothing already free ever moves behind a paywall.
2. **Support, Not Donations:** Wording strictly avoids "donation" / "donate" (Stationly is not a registered charity).
3. **No Metaphors / No Novelty Drinks:** The "buy me a coffee" framing was completely retired in favor of plain, honest sentences explaining server running costs.
4. **No Public Transaction Ledger:** The user sees their supporter status and lifetime count (`count`), but there is no public transaction list or history screen.
5. **Structural Monotonicity:** Supporter duration is measured from the latest transaction; an additional small contribution can never shorten an existing active badge.

---

## 2. End-to-End System Architecture

```text
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 1. USER INITIATION                                                                     │
 │    Profile Screen Support Card  OR  Home Contextual Banner (after adding a board)     │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │ User taps tier (£4, £8, £12, custom)
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 2. SAFARI CHECKOUT (SFSafariViewController / Custom Tabs)                             │
 │    Opens: https://buy.stripe.com/live_…?client_reference_id=<firebase_uid>            │
 │    User pays via Apple Pay / Card (1-tap native wallet sheet)                          │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │ Stripe redirects to success URL
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 3. BROWSER BOUNCE PAGE                                                                 │
 │    GET https://api.stationly.co.uk/api/v1/support-money/return?session_id=cs_…        │
 │    Immediate redirect: window.location = "stationly://support-money/thanks?…"          │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │ App catches deep link
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 4. CLIENT GRATIFICATION (OPTIMISTIC)                                                   │
 │    • dismissCheckout() closes Safari sheet                                             │
 │    • SupportStore.recordContribution() (10-min local optimistic window)                │
 │    • SupportThanksOverlay triggers celebratory multi-colored confetti & haptics        │
 │    • Supporter avatar badge lights up immediately                                      │
 └────────────────────────────────────────────────────────────────────────────────────────┘

 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 5. ASYNC AUTHORITATIVE WEBHOOK (INDEPENDENT SERVER PATH)                               │
 │    Stripe POST https://api.stationly.co.uk/api/v1/webhooks/stripe                      │
 │    ├── 1. Rate limiter (300/5min per IP)                                               │
 │    ├── 2. Raw body extraction (express.raw before express.json)                        │
 │    ├── 3. Constant-time HMAC-SHA256 signature verification (±300s replay window)       │
 │    ├── 4. Environment livemode verification                                            │
 │    ├── 5. SQLite idempotency ledger check (stripe_events table)                        │
 │    └── 6. Firestore atomic transaction:                                               │
 │           • Appends SupportTxn { txnId, atMs, amountMinor, currency } (capped at 50)  │
 │           • Increments stateRev = FieldValue.increment(1)                              │
 │           • Triggers afterContentWrite(uid, 'profile') WebSocket fan-out               │
 └───────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │ Cross-device sync push / socket
                                             ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────┐
 │ 6. CROSS-DEVICE RECONCILIATION                                                         │
 │    Other signed-in devices fetch GET /user/sync/profile                                │
 │    Server projects supportMoney { isActiveSupporter: true, count: N, entries: [...] }   │
 │    Supporter badge appears on all devices without needing IAP receipt restore          │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Backend Implementation Details (`stationly-backend`)

### 3.1 Key Files and Routes
- `src/utils/stripeSignature.ts`: Hand-rolled constant-time HMAC-SHA256 signature verifier with clock-skew replay tolerance.
- `src/services/supportMoneyConfigService.ts`: Server-driven UI configuration generator (both structured object and flat string map for `home-config`).
- `src/services/supportMoneyService.ts`: Webhook event processor, idempotency manager, and transaction handler.
- `src/controllers/stripeWebhookController.ts`: 7-layer guarded webhook receiver mounted at `POST /api/v1/webhooks/stripe`.
- `src/controllers/supportMoneyReturnController.ts`: Branded post-checkout bounce page mounted at `GET /api/v1/support-money/return`.
- `src/services/userService.ts`: Document ledger manager (`recordSupportMoney`), client response projection (`projectSupportMoneyForClient`), and forge protection (`PROTECTED_PROFILE_FIELDS`).

### 3.2 Data Models & Firestore Schema

#### Stored Document (`users/{uid}.supportMoney`)
```ts
export interface SupportMoneyEntry {
    txnId: string;        // Stripe Checkout Session ID (e.g. cs_live_...)
    atMs: number;         // Epoch timestamp in milliseconds
    amountMinor: number;  // Amount in pence/cents (e.g., 800 for £8.00)
    currency: string;     // Currency ISO code (e.g., 'GBP')
}
// Array stored directly on users/{uid}, capped at MAX_SUPPORT_MONEY_ENTRIES (50)
```

#### Wire Contract (Projected on `getUserProfile` and `createOrUpdateUser`)
```ts
export interface SupportMoneyStatusView {
    isActiveSupporter: boolean; // nowMs - latest.atMs < badgeDurationMs
    count: number;             // Lifetime contribution count
    entries: SupportMoneyEntry[]; // Contains only the single latest entry
}
```

### 3.3 Security & Idempotency Guarantees
1. **Fail-Closed Verification:** If `STRIPE_WEBHOOK_SECRET` is unset, the webhook returns HTTP `503`. Invalid signatures or timestamps outside ±300s return HTTP `400` with no diagnostic error leaked.
2. **Dual-Layer Idempotency:**
   - Transport Layer: Checked against SQLite `stripe_events` table.
   - Document Layer: `recordSupportMoney` checks if `txnId` already exists anywhere in the user's `supportMoney` array.
3. **Delayed Settlement Safety:** Both `checkout.session.completed` and `checkout.session.async_payment_succeeded` map to the same session `txnId`, preventing double-crediting on delayed payment methods.
4. **Client Anti-Spoofing:** `'supportMoney'` is in `PROTECTED_PROFILE_FIELDS`; client POST requests to `/user/sync/profile` cannot mutate or forge supporter status.

---

## 4. Mobile Client Implementation Details (`StationlyUI`)

### 4.1 Architecture & Components
- **`SupportMoneyConfig.kt`**: SDUI parser decoding `support_money.card.json` from `homeConfig` with a safe, offline-ready fallback.
- **`SupportStore.kt`**: Durable per-account KV store tracking `quietUntilMs`, `activeDays`, and local optimistic contributions (`contributedOptimistically`).
- **`SupportViewModel.kt`**: Root-level coordinator managing UI state, debounced server syncs (`syncMutex`), nag policy evaluation, and celebration triggers.
- **`SupportSheet.kt`**: Compose bottom sheet displaying the £4 / £8 / £12 / custom amount ladder with real-time story hints.
- **`SupportThanksOverlay.kt`**: Full-screen celebration overlay rendering physics-driven multi-colored confetti cannons and synchronized haptics.
- **`SupportProfileCard.kt` & `SupporterAvatarBadge`**: Profile and top-bar avatar badges with background-matched cut-out rings.
- **`SupportCheckout.kt` / `SupportCheckout.ios.kt`**: Opens checkouts in `SFSafariViewController` (enabling Apple Pay) and handles automated dismissal on return.

### 4.2 Nag Policy & Display Logic
- **Contextual Home Banner:** Appears only after a new board is added, provided `boards_count >= min_boards` (default 2) and `active_days >= min_days` (default 3).
- **Suppression Windows:**
  - "Maybe later" dismissal silences the banner for **3 days** (`SKIP_DAYS = 3`).
  - Making a contribution silences the banner for **30 days** (`QUIET_AFTER_CONTRIBUTION_DAYS = 30`).
- **Optimistic Grace Window:** The device retains supporter status locally for **10 minutes** (`OPTIMISTIC_WINDOW_MS = 600_000L`) immediately after checkout to prevent UI flicker while the Stripe webhook is in flight.

---

## 5. Stripe Console Configuration & Production Inventory

### 5.1 Payment Links & IDs

| Tier | Amount | Link ID | Product Description |
|---|---|---|---|
| **Tier 1 (`t4`)** | **£4.00** | `SUPPORT_MONEY_PAYMENT_URL_T4` | 1 day live · Covers live departures across the network |
| **Tier 2 (`t8`)** | **£8.00** (Default) | `SUPPORT_MONEY_PAYMENT_URL_T8` | 3 days live · Supports stops without physical departure boards |
| **Tier 3 (`t12`)** | **£12.00** | `SUPPORT_MONEY_PAYMENT_URL_T12` | 1 week live · Covers full servers and live data feeds |
| **Custom** | **£1.00 – £500.00** | `SUPPORT_MONEY_PAYMENT_URL_ONEOFF` | Choose your own amount (Preset: £8.00) |

### 5.2 Redirect & Webhook URLs
- **Stripe Success Redirect URL:**
  ```text
  https://api.stationly.co.uk/api/v1/support-money/return?session_id={CHECKOUT_SESSION_ID}
  ```
- **Stripe Webhook URL:**
  ```text
  https://api.stationly.co.uk/api/v1/webhooks/stripe
  ```
- **Webhook Events Subscribed:**
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`

---

## 6. Full-Stack Production Deployment Runbook

### Step 1: Stripe Live Setup (Stripe Dashboard)
1. **Create Products & 4 Payment Links in Live Mode:**
   - **Tier £4:** Fixed price `£4.00` one-off $\rightarrow$ Copy live URL to `SUPPORT_MONEY_PAYMENT_URL_T4`
   - **Tier £8:** Fixed price `£8.00` one-off $\rightarrow$ Copy live URL to `SUPPORT_MONEY_PAYMENT_URL_T8`
   - **Tier £12:** Fixed price `£12.00` one-off $\rightarrow$ Copy live URL to `SUPPORT_MONEY_PAYMENT_URL_T12`
   - **Custom:** "Customer chooses what to pay" (£1.00 min, £500 max, £8.00 preset) $\rightarrow$ Copy live URL to `SUPPORT_MONEY_PAYMENT_URL_ONEOFF`
2. **Configure Success Redirect URL on ALL 4 Links:**
   Under **After payment** $\rightarrow$ **Don't show confirmation page (Redirect to your website)**:
   ```text
   https://api.stationly.co.uk/api/v1/support-money/return?session_id={CHECKOUT_SESSION_ID}
   ```
3. **Configure Live Webhook Endpoint:**
   - In **Developers $\rightarrow$ Webhooks $\rightarrow$ Add endpoint**:
     - **URL:** `https://api.stationly.co.uk/api/v1/webhooks/stripe`
     - **Events to listen to:**
       - `checkout.session.completed`
       - `checkout.session.async_payment_succeeded`
   - Copy the Signing Secret (`whsec_...`) $\rightarrow$ `STRIPE_WEBHOOK_SECRET`.
4. **Enable Payment Methods:** Under **Settings $\rightarrow$ Payment Methods**, ensure **Apple Pay** and **Cards** are enabled.

### Step 2: Production Backend Configuration & Deployment
1. **Add Secrets to CI/CD & Production `.env`:**
   In `.github/workflows/deploy-prod.yml` and `/var/www/stationly-backend/.env`:
   ```bash
   # Master switch (turns on card in SDUI and enables public endpoints)
   SUPPORT_MONEY_ENABLED=true

   # Webhook signing secret from Step 1.3
   STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

   # Stripe live Payment Link URLs from Step 1.1
   # (Do NOT manually add ?client_reference_id={uid}; the backend appends it automatically)
   SUPPORT_MONEY_PAYMENT_URL_T4=https://buy.stripe.com/live_xxxxxxx4
   SUPPORT_MONEY_PAYMENT_URL_T8=https://buy.stripe.com/live_xxxxxxx8
   SUPPORT_MONEY_PAYMENT_URL_T12=https://buy.stripe.com/live_xxxxxx12
   SUPPORT_MONEY_PAYMENT_URL_ONEOFF=https://buy.stripe.com/live_custom

   # Production thresholds & duration
   SUPPORT_MONEY_MIN_BOARDS=2
   SUPPORT_MONEY_MIN_DAYS=3
   SUPPORT_MONEY_BADGE_DURATION_DAYS=30
   ```

2. **Deploy Code & Reload Server:**
   ```bash
   git checkout main
   git merge feat/support-contributions
   git push origin main
   # On the server or via CI:
   npm ci
   npm run build
   npm test
   pm2 reload stationly-backend
   ```

3. **Verify Production Backend Health:**
   ```bash
   # 1. Check SDUI endpoint serves active configuration
   curl -sS https://api.stationly.co.uk/api/v1/sdui/app/support-money-config | grep '"enabled":true'

   # 2. Check return bounce page serves HTML
   curl -I https://api.stationly.co.uk/api/v1/support-money/return

   # 3. Check webhook responds with 400 on unsigned ping (confirms gate is active)
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.stationly.co.uk/api/v1/webhooks/stripe
   # (Expected: 400 or 413, never 404 or 500)
   ```

### Step 3: Emergency Kill-Switch & Rollback
If you ever need to pause or disable the support feature instantly without redeploying code:
1. Set `SUPPORT_MONEY_ENABLED=false` in the server's `.env`.
2. Run `pm2 reload stationly-backend`.
3. All mobile clients will automatically hide the support card and home banner on their next launch/refresh.

### Step 4: Client Release (StationlyUI)
1. Merge the `ios-parity` working tree into `main`.
2. Build release framework and archive iOS app in Xcode:
   ```bash
   ./gradlew :composeApp:assembleComposeAppReleaseXCFramework
   ```
3. Submit build to App Store Connect.
4. *App Store Review Guideline:* Conforms with Apple App Store Review Guideline 3.2.1 (vii) for voluntary developer support/tipping outside StoreKit.

---

## 7. Verification & Test Audit Record

- **Backend Test Suite:** `npm test` $\rightarrow$ **180 / 180 tests passing** (covering signature validation, replay attacks, duplicate transaction prevention, deleted account attribution, and login contract projections).
- **Mobile Client Test Suite:** `./gradlew check` / `:composeApp:testDebugUnitTest` $\rightarrow$ **All tests passing** (covering optimistic expiry, nag quiet policies, attribution encoding, fallback voice rules, and currency formatting).
- **On-Device Live Verification:** Completed end-to-end checkout flow on iPhone test device:
  - Safari opens with Apple Pay ready.
  - Bounce page redirects seamlessly back to `stationly://support-money/thanks`.
  - Safari sheet auto-dismisses.
  - Confetti burst & haptics fire.
  - Firestore updates transaction ledger.
  - Supporter avatar badge renders on Home and Profile screens.
