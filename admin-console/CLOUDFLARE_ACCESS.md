# Locking the Admin Console behind Cloudflare Access

This guide makes the admin console **unreachable to the public** while staying
a normal `https://` URL for your team. It assumes your domain is already on
Cloudflare and the backend runs on a self-managed nginx VPS.

There are **four** pieces. Do them in order:

1. Put the console on its own subdomain (`admin.stationly.co.uk`)
2. **Access App #1** — gate the console subdomain (the human login wall)
3. **Access App #2** — gate `*/api/v1/admin/*` on the API hosts + a Service Token
4. Lock the VPS origin to Cloudflare IPs (so nobody bypasses Access via the raw IP)

At the end you'll have three independent layers: Cloudflare Access → the
console's password login → the server-side admin-key proxy.

---

## How it fits together

```
Team member ─▶ admin.stationly.co.uk ──[App #1: Google/email login wall]──▶ console
                                                                              │ (server-side proxy)
console server ─▶ api.stationly.co.uk/api/v1/admin/* ─[App #2: service token]─▶ backend
                  attaches Bearer <ADMIN_KEY> + CF-Access-Client-Id/Secret      │
                                                                                ▼
                                              adminAuthMiddleware verifies:
                                                1. admin key (Bearer)
                                                2. Cf-Access-Jwt-Assertion (App #2 AUD)

mobile app ─▶ api.stationly.co.uk/api/v1/*  (NOT /admin)  ── untouched, no Access
```

Key insight: **Access App #2 is scoped to the `/api/v1/admin/*` path only.**
Your mobile clients hit `/api/v1/*` (predictions, lines, user sync) — those
paths don't match the app, so Access never touches them. No client changes.

---

## 1. Put the console on its own subdomain

- Deploy the console (this `admin-console/` Next app) somewhere reachable by
  Cloudflare — same VPS on a different port, or a separate host.
- In Cloudflare DNS, add a **proxied (orange-cloud)** record:
  `admin.stationly.co.uk` → your console host/IP.
- Confirm `https://admin.stationly.co.uk` loads (it will, since there's no
  Access policy yet — you'll add it next).

> Optional staging console: `staging-admin.stationly.co.uk`. Or run one
> console that targets both envs via the in-app switcher (what we built).

---

## 2. Access App #1 — gate the console subdomain (human login)

Cloudflare dashboard → **Zero Trust** (`one.dash.cloudflare.com`).

First-time only:
- **Settings → Authentication → Login methods**: add an identity provider.
  - Easiest start: **One-time PIN** (emails a code, no IdP setup).
  - Recommended: **Google** (or Google Workspace) so the team uses SSO.

Then:
- **Access → Applications → Add an application → Self-hosted**.
- **Application name**: `Stationly Admin Console`
- **Session duration**: e.g. `24h`
- **Application domain**: `admin.stationly.co.uk` (leave path empty → whole site)
- **Identity providers**: select the one(s) you configured.
- Click **Next** to add a policy:
  - **Policy name**: `Team`
  - **Action**: `Allow`
  - **Include** → choose one:
    - `Emails` → list your teammates' emails, **or**
    - `Emails ending in` → `@stationly.co.uk` (if you all share a domain), **or**
    - `Login Methods` / `Identity provider groups` for a Workspace group.
- Save. Now `admin.stationly.co.uk` shows the Cloudflare login wall to
  everyone; only allowed identities get through.

✅ The console UI is now non-public for the whole team, on any device, no VPN.

---

## 3. Access App #2 — gate the admin API path + create a Service Token

This is what makes a leaked admin key useless from the public internet.

### 3a. Create the Service Token (machine identity for the console proxy)

- **Access → Service Auth → Service Tokens → Create Service Token**.
- **Name**: `admin-console-proxy`
- Copy the **Client ID** and **Client Secret** — shown **once**. These become
  the console's `*_CF_ACCESS_CLIENT_ID` / `*_CF_ACCESS_CLIENT_SECRET`.

### 3b. Create the Access application over the admin path

- **Access → Applications → Add an application → Self-hosted**.
- **Application name**: `Stationly Admin API`
- **Application domain**: add BOTH (use “+ Add domain” for the second):
  - `api.stationly.co.uk`  with **Path** `/api/v1/admin` *(covers subpaths)*
  - `staging-api.stationly.co.uk` with **Path** `/api/v1/admin`
  - One app covering both hosts ⇒ **one AUD** ⇒ one value to configure on both
    backends. (If you'd rather isolate, make two apps with two AUDs/tokens.)
- **Next → add policies (add TWO):**
  - Policy `Team` — Action **Allow**, Include **Emails** (same list as App #1).
    *(Lets a human hit the admin API directly in a pinch.)*
  - Policy `Console proxy` — Action **Allow** **→ but use a Service Auth policy**:
    set **Action = Service Auth**, Include → **Service Token** →
    `admin-console-proxy`. *(This is the path the console actually uses.)*
- Save.

> ⚠️ Use **Action: Service Auth** (not Allow) for the service-token policy.
> A plain `Allow` with a service token include can let *non*-token requests
> that also satisfy other Allow rules through; `Service Auth` requires the
> token headers to be present.

### 3c. Grab the AUD tag

- Open the **Stationly Admin API** app → **Overview** (or **Settings**) →
  copy the **Application Audience (AUD) Tag** (a long hex string).
- This becomes `CF_ACCESS_AUD` on the backend(s).

### 3d. Find your team domain

- **Settings → Custom Pages / General**, or your Access URLs, show your team
  domain, e.g. `stationly.cloudflareaccess.com`.
- This becomes `CF_ACCESS_TEAM_DOMAIN` (you can pass the bare `stationly` too —
  `cfAccess.ts` normalises it).

---

## 4. Wire the env vars

### Backend (`.env` on each backend — staging and prod)

```ini
# Turns ON the Cf-Access-Jwt-Assertion check in adminAuthMiddleware.
CF_ACCESS_TEAM_DOMAIN=stationly.cloudflareaccess.com
CF_ACCESS_AUD=<AUD tag from step 3c>
```

Leave these unset on local dev and the JWT check is skipped (admin key only).

### Console (`admin-console/.env.local`)

```ini
# Same service token works for both envs (single App #2). If you made two
# apps, use each env's own token here.
STAGING_CF_ACCESS_CLIENT_ID=<client id>
STAGING_CF_ACCESS_CLIENT_SECRET=<client secret>
PROD_CF_ACCESS_CLIENT_ID=<client id>
PROD_CF_ACCESS_CLIENT_SECRET=<client secret>
```

The console's proxy attaches these as `CF-Access-Client-Id` /
`CF-Access-Client-Secret` automatically (see `lib/backend.ts`).

---

## 5. Lock the origin to Cloudflare (close the back door)

Access only protects traffic that goes *through* Cloudflare. If someone learns
your VPS's raw IP, they skip Access entirely. Shut that down.

### Option A (recommended for an nginx VPS): firewall to Cloudflare IPs

Allow `:80/:443` only from Cloudflare's published ranges:

```bash
# Run on the VPS. Re-run if Cloudflare updates its ranges (rare).
sudo ufw default deny incoming
sudo ufw allow OpenSSH                       # keep your SSH access!
for ip in $(curl -s https://www.cloudflare.com/ips-v4) \
          $(curl -s https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from "$ip" to any port 443 proto tcp
  sudo ufw allow from "$ip" to any port 80  proto tcp
done
sudo ufw enable
```

### Option B: Authenticated Origin Pulls (mTLS Cloudflare ↔ origin)

Cloudflare → **SSL/TLS → Origin Server → Authenticated Origin Pulls** (zone
level), then in nginx require Cloudflare's origin-pull cert:

```nginx
ssl_client_certificate /etc/nginx/cloudflare/origin-pull-ca.pem;
ssl_verify_client on;
```

### Option C: cloudflared Tunnel

Replace the public DNS→IP record with a **Cloudflare Tunnel** so the origin has
no inbound public port at all. Most secure; more setup than A.

### Restore the real client IP (nice-to-have)

Behind Cloudflare, `req.ip` should reflect `CF-Connecting-IP`. In nginx set
`real_ip_header CF-Connecting-IP;` with `set_real_ip_from` for the CF ranges,
so the backend's `req.ip` logs (used in the admin auth warnings) are accurate.

---

## 6. Verify

1. **Public can't see the console**: open `admin.stationly.co.uk` in an
   incognito window with a non-team account → Cloudflare login wall, no access.
2. **Team can**: log in with an allowed identity → console loads.
3. **Admin API is gated**: from a machine *without* the service token:
   ```bash
   curl -i https://api.stationly.co.uk/api/v1/admin/notifications/send
   # → Cloudflare Access challenge / 403, never reaches Node
   ```
4. **Service token works**:
   ```bash
   curl -i https://api.stationly.co.uk/api/v1/admin/notifications/send \
     -H "CF-Access-Client-Id: <id>" \
     -H "CF-Access-Client-Secret: <secret>" \
     -H "Authorization: Bearer <ADMIN_KEY>" \
     -H "Content-Type: application/json" \
     -d '{"audience":{"type":"token","value":"short"},"payload":{"type":"system","title":"t","body":"b"}}'
   # → reaches Node; backend then validates the JWT + admin key
   ```
5. **Mobile API still open**: `curl https://api.stationly.co.uk/api/v1/modes`
   with a normal `X-Stationly-Key` → works, no Access challenge (path isn't
   under /api/v1/admin).
6. **Origin is locked**: hitting the raw VPS IP on :443 from outside the
   Cloudflare ranges should time out / refuse.

---

## Rotation & ops notes

- **Rotate the service token**: create a new one, add it to App #2's Service
  Auth policy, update the console env, then delete the old token.
- **Add/remove team members**: edit the `Team` policy on App #1 (and App #2
  if you keep the human Allow policy there).
- **Adding a third env / new admin endpoint**: it's already covered — App #2
  matches the whole `/api/v1/admin/*` subtree, so new admin routes inherit the
  protection automatically.
- The backend stays **fail-shut**: if `CF_ACCESS_AUD`/`CF_ACCESS_TEAM_DOMAIN`
  are set but a request arrives without a valid assertion, it's `403` — see
  `src/admin/adminAuthMiddleware.ts` + `src/admin/cfAccess.ts`.
