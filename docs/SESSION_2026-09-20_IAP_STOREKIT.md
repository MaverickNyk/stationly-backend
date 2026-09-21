# Session Record: Native In-App Purchases (StoreKit 2), Per-Platform Toggles & Staging Configuration

**Dates:** 20–21 September 2026  
**Repositories:** `stationly-backend` & `StationlyUI`  
**Status:** Verification complete, builds clean, commit-ready  
**Focus:** StoreKit 2 Native In-App Purchases, Per-Platform Feature Switches, Server-Driven UI (SDUI) Backward Compatibility, Stripe Removal for iOS, Apple JWS Verification

---

## 1. Executive Summary & Context

Apple App Store Review Guidelines **3.1.1 (In-App Purchase)** and **3.2.1(vii) (Voluntary Tips/Donations)** require all in-app digital contributions in iOS apps to go exclusively through Apple's In-App Purchase APIs (StoreKit 2). External web checkout links (e.g. Stripe Payment Links) or browser presentation sheets (`SFSafariViewController`) violate these guidelines and lead to app rejection.

This session transitioned "Support Stationly" into a native Apple In-App Purchase experience on iOS, eliminated all Stripe presentation and deep linking from the iOS app, introduced independent per-platform toggles in the backend, ensured 100% backward-compatibility with the frozen production Android build (v1.0), and protected older iOS versions from presenting Stripe.

---

## 2. Per-Platform Feature Switches

To prevent turning on support globally via a single switch—which would inadvertently expose Stripe to older iOS versions and untested platforms—the backend configuration was restructured into independent per-platform toggles.

### Environment Variable Matrix

| Variable | Default Value | Purpose | State in This Release |
| :--- | :--- | :--- | :--- |
| `SUPPORT_MONEY_IOS_ENABLED` | `true` | Governs whether support surfaces render on iOS. | **Active** (StoreKit 2 enabled) |
| `SUPPORT_MONEY_ANDROID_ENABLED` | `false` | Governs whether support surfaces render on Android. | **Dormant** |
| `SUPPORT_MONEY_WEB_ENABLED` | `false` | Governs whether support surfaces render on Web. | **Dormant** |
| `SUPPORT_MONEY_ENABLED` | `false` | **DEPRECATED**. Legacy global flag. Kept only for backward compatibility in config parsers; no client relies on it. | **Deprecated** |

### Implementation in `SupportMoneyConfigService.ts`
```typescript
/**
 * Per-platform support switches:
 * - iOS: SUPPORT_MONEY_IOS_ENABLED (default true)
 * - Android: SUPPORT_MONEY_ANDROID_ENABLED (default false)
 * - Web: SUPPORT_MONEY_WEB_ENABLED (default false)
 *
 * Note: SUPPORT_MONEY_ENABLED is deprecated and will be removed; clients only use per-platform toggles.
 */
static enabled(platform?: 'ios' | 'android' | 'web' | 'unknown' | string): boolean {
    const p = (platform || 'ios').trim().toLowerCase();
    if (p === 'android') return this.isAndroidEnabled();
    if (p === 'web') return this.isWebEnabled();
    if (p === 'unknown') return false;
    return this.isIosEnabled();
}
```

---

## 3. Client Identification & Request Routing

Every request sent by the modern Stationly client carries the `X-Stationly-Client` header, constructed as:
`X-Stationly-Client: <platform>;<version>;<build>` (e.g., `ios;1.0.0;1` or `android;1.0.0;1`).

### Platform Parsing (`src/services/appReleaseService.ts`)
`parseClientIdentity` parses the header into:
```typescript
export interface ClientIdentity {
    platform: 'ios' | 'android' | 'web' | 'unknown';
    version: string;
    build: string;
}
```
- Inputs with `ios` map to `'ios'`.
- Inputs with `android` map to `'android'`.
- Inputs with `web` map to `'web'`.
- Missing or malformed headers resolve safely to `'unknown'`.

### Controller Routing
Both [`sduiController.ts`](file:///Users/nikhilkumar/workspace/Projects/Stationly/stationly-backend/src/controllers/sduiController.ts) and [`supportMoneyController.ts`](file:///Users/nikhilkumar/workspace/Projects/Stationly/stationly-backend/src/controllers/supportMoneyController.ts) route client platform identities into the config services:
```typescript
const client = parseClientIdentity(req.headers['x-stationly-client'] as string);
const platform = (req.query.platform as string) || client.platform;
res.json(SduiService.getHomeConfig(platform));
```

---

## 4. Older iOS Version Defense (Empty Stripe URLs Invariant)

A critical requirement was ensuring that existing/older iOS builds (e.g., TestFlight or previously distributed binaries) never show the support card or trigger Stripe checkout.

### Mechanism:
1. Older iOS binaries compute whether support can be paid via:
   ```kotlin
   val isPayable = enabled && (tiers.any { it.checkoutUrl.isNotBlank() } || cta.urlOneoff.isNotBlank())
   ```
2. When the backend detects `platform === 'ios'`, it deliberately returns **empty strings** for all Stripe checkout URLs:
   - `tiers[].url = ""`
   - `cta.url_oneoff = ""`
   - `cta.url_monthly = ""`
   - `custom_amount.enabled = false`
3. Because all checkout URLs are blank, older iOS binaries evaluate `isPayable = false`:
   - **Profile Screen**: `showProfileCard` requires `config.isPayable` $\rightarrow$ Evaluates to `false`. Support card is hidden.
   - **Home Screen Banner**: `bannerVisible` requires `state.config.isPayable` $\rightarrow$ Evaluates to `false`. Banner is never presented.
   - Older iOS versions can never open Stripe.
4. Newer iOS binaries check `it.appleProductId.isNotBlank()` alongside checkout URLs:
   ```kotlin
   val isPayable = enabled && (tiers.any { it.checkoutUrl.isNotBlank() || it.appleProductId.isNotBlank() } || cta.urlOneoff.isNotBlank())
   ```
   Because `appleProductId` is present, `isPayable = true`, rendering the card and triggering native StoreKit 2.

---

## 5. Production Android Safety Audit

The production Android app is frozen at `versionCode 2` (v1.0) and cannot be modified or re-released without a full deployment cycle.

### Safety Guarantees Verified:
1. **Zero Keys Removed**: Per `docs/SDUI_CONFIG.md`, removing any key from `/sdui/app/home-config` renders blank text in production Android.
   - Verified via runtime check: all **296 home-config keys** remain present and string-typed across all platforms.
2. **Missing Header Fallback**: Production Android was built prior to `X-Stationly-Client` and sends no client header.
   - Resolves to `client.platform: 'unknown'`.
   - `SupportMoneyConfigService.enabled('unknown')` strictly returns **`false`**.
   - `home.promo.support_money.show` is `"false"`.
   - `support_money.card.json` has `"enabled": false`.
3. **Android Regression Test**: All 229 unit tests pass in `stationly-backend`, including Android-specific contracts:
   - Android device registry and session stealing.
   - Legacy home config keys (`app.minVersion`, `app.storeUrl`).
   - Firestore document schemas and sync responses.

---

## 6. Architecture & Components

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 1. COMPOSE MULTIPLATFORM (composeApp)                                            │
│    • SupportSheet: renders SDUI ladder (£4, £8, £12, £25)                         │
│    • SupportViewModel.payTier(): detects tier.appleProductId                     │
│    • SupportCheckout.ios.kt -> StoreKitBridge.purchase(...)                       │
└────────────────────────────────────────┬──────────────────────────────────────────┘
                                         │ invokes
                                         ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 2. SWIFT STOREKIT 2 (iosApp/StoreKitManager.swift)                                │
│    • Fetches Product.products(for: [productId])                                   │
│    • Triggers product.purchase() -> Native Apple Pay / FaceID modal               │
│    • On .verified: transaction.finish() + SupportReturn.shared.deliver()           │
│    • On failure/product not found: presents native UIAlertController              │
└────────────────────────────────────────┬──────────────────────────────────────────┘
                                         │ sends JWS async
                                         ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│ 3. STATIONLY BACKEND (stationly-backend)                                          │
│    • POST /api/v1/support-money/verify-iap                                        │
│    • Validates JWS signed transaction from Apple via AppStoreServerLibrary        │
│    • Authoritatively writes to Firestore:                                         │
│        - users/{uid}.supportMoney (isActiveSupporter, badgeExpiresAt, count)     │
│        - contributions/{transactionId} (immutable audit record)                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Product Catalog & Staging vs Production Separation

| Tier | Amount | Display Label | Production Product ID (`com.stationly.mobile`) | Staging Product ID (`com.stationly.mobile.staging`) |
|---|---|---|---|---|
| **t4** | £3.99 (400 minor) | 1 day live | `uk.co.stationly.support.t4` | `uk.co.stationly.support.staging.t4` |
| **t8** | £7.99 (800 minor) | 3 days live | `uk.co.stationly.support.t8` | `uk.co.stationly.support.staging.t8` |
| **t12** | £11.99 (1200 minor) | 1 week live | `uk.co.stationly.support.t12` | `uk.co.stationly.support.staging.t12` |
| **t25** | £24.99 (2500 minor) | Generous | `uk.co.stationly.support.t25` | `uk.co.stationly.support.staging.t25` |

### Environment Switching in Backend:
[`supportMoneyConfigService.ts`](file:///Users/nikhilkumar/workspace/Projects/Stationly/stationly-backend/src/services/supportMoneyConfigService.ts) automatically selects product IDs based on `APP_ENV`:
```typescript
function envAppleProduct(tierId: string, defaultId: string): string {
    const explicit = envStr(`SUPPORT_MONEY_APPLE_PRODUCT_${tierId.toUpperCase()}`);
    if (explicit) return explicit;
    return process.env.APP_ENV === 'staging'
        ? `uk.co.stationly.support.staging.${tierId}`
        : defaultId;
}
```

---

## 8. Backend JWS Verification (`AppleIAPService`)

The backend receives the signed transaction JWS from the iOS client and cryptographically verifies it using Apple's official library (`@apple/app-store-server-library`).

### Verification Steps (`src/services/appleIAPService.ts`):
1. **Payload Extraction**: Parses unverified JWS header and claims to determine `bundleId`, `productId`, `transactionId`, and `purchaseDate`.
2. **Bundle ID & Product Validation**: Confirms the bundle ID matches the active environment (`com.stationly.mobile.staging` in staging, `com.stationly.mobile` in prod) and that the product ID belongs to the approved tier catalog.
3. **App Store Server Signature Verification**: Uses Apple's root certificates and key `696L83R22A` (when configured) to verify cryptographic authenticity.
4. **Idempotent Firestore Crediting**:
   - Constructs transaction ID: `apple_${transactionId}`.
   - Prevents duplicate processing if `txnId` already exists on the user's ledger.
   - Appends transaction record, sets `isActiveSupporter = true`, extends `badgeExpiresAt` by 30 days (`SUPPORT_MONEY_BADGE_DURATION_DAYS`), and increments `count`.
   - Bumps `stateRev` and creates an audit entry in the root `contributions/` collection.

---

## 9. Code Cleanup & Removal of Redundant Stripe Logic

1. **`ContentView.swift`**:
   - Removed `.onOpenURL` listener for `url.host == "support-money"` (the old Stripe browser redirect bounce).
2. **`SupportCheckout.ios.kt`**:
   - Stripped `SFSafariViewController`, `presentedCheckout`, and `topMostViewController()`.
   - Replaced `openCheckout` and `dismissCheckout` with clean no-op actuals.
   - Retained only the `StoreKitBridge` Swift-to-Kotlin invocation.
3. **`SupportSheet.kt`**:
   - Removed client-side heuristic `config.tiers.none { it.appleProductId.isNotBlank() }`.
   - Cleaned to pure server-driven condition:
     ```kotlin
     val showCustomAmount = config.customAmount.enabled && config.cta.urlOneoff.isNotBlank()
     ```
4. **`sduiController.ts` & `supportMoneyController.ts`**:
   - Simplified platform resolution to `(req.query.platform as string) || client.platform`.

---

## 10. Verification & Test Metrics

### `stationly-backend`
- **Unit Tests**: `npm test` $\rightarrow$ **229/229 passed** (0 failures).
  - Asserts per-platform switches (`SUPPORT_MONEY_IOS_ENABLED`, `SUPPORT_MONEY_ANDROID_ENABLED`, `SUPPORT_MONEY_WEB_ENABLED`).
  - Asserts deprecation of `SUPPORT_MONEY_ENABLED`.
  - Asserts Apple IAP verification, bundle ID validation, and Firestore ledger writes.
- **Build**: `npm run build` $\rightarrow$ **0 TypeScript errors**.

### `StationlyUI`
- **Kotlin Multiplatform**: `./gradlew compileKotlinIosSimulatorArm64` $\rightarrow$ **BUILD SUCCESSFUL**.
- **Xcode Build**: `xcodebuild -scheme "iosApp Staging" -configuration "Debug Staging"` $\rightarrow$ **BUILD SUCCEEDED**.
- **Knowledge Graph**: Re-indexed and updated via `graphify update .`.
