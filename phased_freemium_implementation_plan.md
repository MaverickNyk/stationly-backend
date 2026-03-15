# 🎟️ Freemium to Pro Implementation Plan (Granular Phased Approach)

To minimize risk and ensure each step is stable before moving on, the implementation is broken down into 7 small, testable phases.

---

## 🟢 Phase 1: Backend Security & User Model Updates
*Goal: Prepare the backend to securely understand users, own multiple boards, and record their subscription status.*

**Step 1.1: Auth Middleware**
*   Create `src/middleware/requireAuth.ts`.
*   Implement `requireAuth` (verifies Firebase ID Token) and `requireOwnership` (ensures `req.user.uid === req.body.uid`).
*   Apply to all protected routes in `apiRoutes.ts`.
*   Update all methods in `userController.ts` to use `(req as any).user.uid` instead of `req.body.uid`.

**Step 1.2: UserProfile Data Model**
*   In `userService.ts`, add the subscription fields to the `UserProfile` interface: `subscriptionTier` ('free' | 'pro'), `subscriptionExpiresAt`, and `purchaseToken`.
*   Default `subscriptionTier` to 'free' on new user creation.

**Step 1.3: Update Board Limits**
*   In `userService.addStation()`, remove the single-board overwrite (`const updatedStations = [station]`).
*   Add logic to check `subscriptionTier` and enforce limits (1 for free, 5 for Pro). Throw a specific error (e.g., `SUBSCRIPTION_LIMIT_EXCEEDED`) if the limit is reached.
*   Update `userService.syncStations()` to *not* strip away existing boards if a user is downgraded; it should just enforce the limit on *new* additions by clamping the input array size based on tier if they try to sync *more* than allowed.

---

## 🟢 Phase 2: Android UI Foundation – The Horizontal Pager
*Goal: Move from a vertical list of boards to a modern, swipeable widget without any billing logic yet.*

**Step 2.1: Implement Horizontal Pager**
*   In `SummaryScreen.kt`, replace the `LazyColumn` holding the multiple `Board` items with a Compose `HorizontalPager`.
*   Wrap the Pager in a `Column` and add animated dot indicators (the `● ○ ○` style) below the top app bar.

**Step 2.2: Add Contextual Board Header**
*   Create a `BoardPageHeader` composable to replace the global `SummaryHeader`.
*   This header sits *above* the Horizontal Pager but updates its content (Station Name, Line, "Board 1 of X", Last Updated string, Delete Icon) based on the `pagerState.currentPage`.

**Step 2.3: Update ViewModels**
*   In `SelectionViewModel.kt`, remove the call to `stationLifecycleUseCase.cleanupAll()` inside `onActionTriggered`. This allows adding subsequent boards locally.
*   **Test:** Manually add 2-3 boards via the DB or the UI (bypassing limits temporarily) to ensure the swiping, dot indicators, and page headers work perfectly.

---

## 🟢 Phase 3: Android UI – The Locked/Tease State
*Goal: Introduce the visual concept of Premium and locked boards, even before real billing is wired up.*

**Step 3.1: The Locked Board State**
*   Update the `Board` composable in `SummaryScreen.kt` to accept `isLocked: Boolean` and `onUpgrade: () -> Unit`.
*   If `isLocked` is true, render a blurred overlay using a gradient and Box over the `AndroidView`.
*   Add a lock icon to the pager dots for locked pages.

**Step 3.2: The Ghost Board Tease**
*   If the user has exactly 1 board (free tier limit), render a subtle "Add a second board with Pro" ghost card below the `StationExploreSection` on the first page.

**Step 3.3: Top Bar Tease**
*   Change the top-right button in `SummaryScreen.kt`. If the user is on the free tier, show a star icon `[⭐]` instead of the plain `[+]` or edit icon.

---

## 🟢 Phase 4: Backend Subscription Services
*Goal: Create the endpoints needed to verify and manage subscriptions.*

**Step 4.1: Subscription Service**
*   Create `src/services/subscriptionService.ts`.
*   Implement `verifyPlayStorePurchase()` calling the Google Play Developer API to validate tokens. Add replay attack prevention (ensure the token isn't bound to another UID).
*   Add helper methods `grantPro()`, `revokePro()`, and `getSubscriptionStatus()`.

**Step 4.2: Subscription Controller & Routes**
*   Create `src/controllers/subscriptionController.ts` wrapping the service methods.
*   Expose endpoints: `GET /user/subscription/status`, `POST /user/subscription/verify`, and `POST /user/subscription/webhook`.
*   Add `PUBSUB_VERIFICATION_TOKEN` logic to the webhook to prevent forged Google PubSub events.

**Step 4.3: Secure Firestore**
*   Deploy updated Firestore Security Rules to explicitly deny client-side writes to `subscriptionTier`, `subscriptionExpiresAt`, and `purchaseToken`.

---

## 🟢 Phase 5: Android Billing Integration
*Goal: Wire up the Google Play Billing Library to handle real money.*

**Step 5.1: Add Dependencies**
*   Add `com.android.billingclient:billing-ktx:6.2.1` to `build.gradle.kts`.

**Step 5.2: Create SubscriptionManager**
*   Create `SubscriptionManager.kt` as an app-level singleton (instantiate in `StationlyApplication.kt`).
*   Implement `BillingClientStateListener` and `PurchasesUpdatedListener`.
*   Add logic to fetch product details (`stationly_pro_monthly`, `stationly_pro_yearly`), check existing purchases on launch, and launch the billing flow.
*   Add logic to call the new backend `/verify` endpoint when a successful purchase callback is received.

**Step 5.3: The Paywall UI**
*   Create `PaywallScreen.kt` – a full-screen, premium-looking Composable displaying the fetched products, a feature list, and purchase buttons.
*   Overlay this screen in `SummaryScreen` and `SelectionScreen` based on a boolean in the `SubscriptionManager` state.

---

## 🟢 Phase 6: Wiring It All Together
*Goal: Connect the UI limits, FCM subscriptions, and Billing state.*

**Step 6.1: Gate the Selection Flow**
*   In `SelectionViewModel.kt`, before calling `setupStation()`, read the `SubscriptionManager.state.boardLimit`.
*   If the user hits the limit, abort the save and trigger the paywall to show.

**Step 6.2: FCM Suspension Logic**
*   In `SubscriptionManager.kt`, observe tier changes.
*   If a user downgrades to free, loop through their `getAllSelections()`, drop the first one, and explicitly *unsubscribe* those extra stations from Firebase Messaging topics to save bandwidth and battery.
*   If they upgrade back to Pro, re-subscribe them.

**Step 6.3: Pass Real State to UI**
*   Feed the `isLocked` state in `SummaryScreen` logically: `val isLocked = page > 0 && !subscriptionManager.state.isActive`.

---

## 🟢 Phase 7: Deployment & Play Console Configuration
*Goal: Take the feature live to production.*

**Step 7.1: Nginx & Rate Limiting**
*   Ensure the backend is protected by Nginx. Define strict rate limits for the `/user/subscription/verify` endpoint to prevent brute-forcing.

**Step 7.2: Play Console Setup**
*   Create the Monthly and Yearly subscription products in the Google Play Console under Monetize -> Products -> Subscriptions. Set prices and free trials.

**Step 7.3: Webhook Configuration**
*   Set up Real-time Developer Notifications (RTDN) in Google Cloud Pub/Sub, pointing to your backend's `/user/subscription/webhook` with the secure token parameter.

**Step 7.4: E2E Testing**
*   Add a test account email in the Play Console.
*   Perform full end-to-end testing: Purchase monthly, verify 5 boards unlock, cancel subscription, wait for expiration webhook, verify boards 2-5 become locked and blurred, reactive subscription, verify boards unlock again.
