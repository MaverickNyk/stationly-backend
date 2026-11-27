# Email studio (backend half)

The admin console's **Email** page (stationly-admin `components/email/`) drives
these endpoints. Everything here is admin-key only, except the two public
routes (images, unsubscribe). No `@swagger` (see `../CLAUDE.md`).

## Files

| File | What it does |
|---|---|
| `emailDoc.ts` | The email document: subject, preheader, sender, category (service / marketing), header, blocks. Validation (`validateDoc`). |
| `emailRender.ts` | Doc → HTML + text. Pure. The ONLY renderer, so preview, test and real send match. Modes: `direct` (per recipient), `broadcast` (Resend placeholders), `preview`. Safe Markdown subset; everything is escaped first. |
| `emailAudience.ts` | Who gets it. Pure filter over the admin cache (`AdminDataService`, 0 Firestore reads): platform, app version, activity, sign-in, boards, station + line + direction, supporters, joined dates, provider, custom and excluded addresses. Every exclusion is counted with a reason. |
| `emailCampaigns.ts` | Drafts (Firestore `admin_email_campaigns`), test sends, real sends, the send lock, delivery audit (`…/deliveries`). `plan()` picks direct vs broadcast. |
| `resendClient.ts` | Every Resend call, behind one throttle (8 req/s; free plan is 10). Batch sends, contacts, the managed segment, broadcasts. |
| `emailStores.ts` | Usage counters (`email_usage/d_<day>`, `m_<month>`), opt-outs (`email_optouts`), signed unsubscribe links. |
| `emailAssets.ts` | Image uploads: sharp re-encode (≤1200 px, ≤900 KB), Firestore `email_assets` master + `data/email-assets/` disk cache. |
| `emailController.ts` | Admin routes under `/api/v1/admin/email`. |
| `emailPublicRoutes.ts` | Public: `GET /api/v1/email-assets/<id>.<ext>`, `GET/POST /api/v1/email/unsubscribe`. |

Tests: `npx ts-node src/tests/email.test.ts` (pure modules, no Firestore/Resend).

## How a send chooses Resend's channel (free plan)

| | Direct (batch API) | Broadcast |
|---|---|---|
| Quota | 1 per recipient, of a **70/day, 2,500/month** budget (Resend's 100/3,000 minus room for sign-up and password emails; staging + prod share one Resend account) | **none** (marketing plan: unlimited sends to ≤1,000 contacts) |
| Requests | 1 per 100 emails | ~2 per new contact on the first sync, then only changes |
| Personalisation | everything, incl. `{{station}}` | `{{first_name}}`, `{{email}}` only |
| Unsubscribe | marketing: our signed link + `List-Unsubscribe` one-click header | Resend's link, always |
| Opt-outs | our `email_optouts` (marketing only) | Resend's own, imported into ours on each sync |

`plan()` recommends: marketing → broadcast; service → direct when it uses at
most half of today's remaining quota, else broadcast. An announcement to every
Android user ("2.0 is out") is a broadcast and costs no daily quota.

Broadcasts use ONE segment, "Stationly managed broadcast" (segments have fixed
members, and the free plan allows 3). Before each broadcast its members are set
to exactly the audience; contacts are never deleted, so unsubscribes stick. One
send at a time (lock in `admin_email_meta/state`, 30 min expiry), and a new
broadcast waits until the previous one has left the queue.

## Safety

- The send endpoint re-resolves the audience and refuses unless the count
  equals the `confirmCount` the admin typed. A stale screen can't widen a send.
- Sent emails are read-only records; duplicate to reuse.
- Staging: `[Staging]` subject prefix; `EMAIL_STAGING_ALLOWLIST` restricts real sends.
- The console asks for the admin password again before a send, a test or a delete.

## Configuration

Nothing new is required: no GitHub secrets, no new server settings. The only
key it needs is the existing `RESEND_API_KEY`. The Resend plan limits live in
`.env.defaults` (committed; the code has the same defaults). Optional, normally
unset: `EMAIL_STAGING_ALLOWLIST`, `RESEND_BROADCAST_SEGMENT_ID`,
`EMAIL_LINK_SECRET` (unsubscribe links are otherwise signed with a key derived
from `STATIONLY_ADMIN_KEY`; rotating that key breaks old unsubscribe links).

## Firestore cost

Reads: the campaign list (≤60 docs, no bodies) and the opened campaign; opt-outs
(one small collection, cached 5 min); usage (2 docs, cached 30 s); an image's
first fetch after a deploy. Audiences and previews: 0.
Writes: draft saves (debounced), one progress write per 100 emails or per 10
contacts synced, one delivery doc per batch, usage increments.
