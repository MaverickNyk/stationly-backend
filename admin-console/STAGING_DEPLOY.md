# Admin Console — going live on staging

The console targets exactly one environment, fixed by the deployment. On the
staging box it runs as its own pm2 process (`stationly-admin`, port 4000)
behind nginx at `staging-admin.stationly.co.uk`, talking to the staging
backend at `https://staging-api.stationly.co.uk`.

## Prerequisites (one-time)

1. **Deploy the updated backend to staging first.** The console's data screens
   call admin endpoints added recently — `/admin/stats`, `/admin/users`,
   `/admin/waitlist`, `/admin/subscribed-stations`, `/admin/notifications/history`,
   `/admin/users/:uid/tokens`. Until the backend is redeployed, those return
   `Missing 'X-Stationly-Key'` (the routes don't exist yet on staging). Run the
   backend deploy: `cd stationly-backend && ./.scripts/staging_deploy.sh`.

2. **Secrets in `admin-console/.env.local`** (used by the deploy script):
   - `ADMIN_PASSWORD` — console login password
   - `SESSION_SECRET` — `openssl rand -hex 32`
   - `STAGING_ADMIN_KEY` — must equal the backend's staging `STATIONLY_ADMIN_KEY`
   - (optional) `STAGING_CF_ACCESS_CLIENT_ID` / `_SECRET` once Cloudflare Access
     gates the admin API path

3. **DNS**: point `staging-admin.stationly.co.uk` at the staging server
   (`79.72.94.209`), proxied through Cloudflare.

## Deploy

```bash
cd admin-console
./staging_deploy.sh
```

This builds the standalone bundle, uploads it, writes a chmod-600
`.env.production` on the server, and (re)starts the `stationly-admin` pm2
process. It health-checks `http://127.0.0.1:4000/login` on the box.

## nginx + TLS (one-time, on the server)

```bash
# copy deploy/nginx-staging-admin.conf to the server, then:
sudo cp nginx-staging-admin.conf /etc/nginx/sites-available/staging-admin.stationly.co.uk
sudo ln -s /etc/nginx/sites-available/staging-admin.stationly.co.uk /etc/nginx/sites-enabled/
sudo certbot --nginx -d staging-admin.stationly.co.uk
sudo nginx -t && sudo systemctl reload nginx
```

Then open `https://staging-admin.stationly.co.uk` — you should see the orange
**⚠ STAGING ENVIRONMENT** banner and the login screen.

## Recommended before sharing the URL

- **Cloudflare Access** on `staging-admin.stationly.co.uk` (and the
  `/api/v1/admin/*` path on `staging-api`) — see `CLOUDFLARE_ACCESS.md`. Until
  then the only gate is the console password + the admin key.

## Production

Identical, with: `STATIONLY_ENV=production`, `PROD_ADMIN_KEY`,
`admin.stationly.co.uk`, and no staging banner. Copy `staging_deploy.sh` to a
`prod_deploy.sh` with the prod host/dir/url (or parameterise it).
