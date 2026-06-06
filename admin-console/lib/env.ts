/**
 * Target-environment config — mirrors StationlyUI's `AppConfig.kt`
 * (PROD_API_URL / STAGING_API_URL). The console targets exactly ONE
 * environment, fixed by the deployment (never chosen in the UI): staging or
 * production. There is no "local" environment — local development simply runs
 * the console with `STATIONLY_ENV=staging` so it points at staging.
 *
 * Each env has its own admin key + Cloudflare service token, resolved here
 * server-side and never shipped to the browser.
 */

export type EnvName = 'staging' | 'prod';

export interface EnvMeta {
  name: EnvName;
  label: string;
  /** Visual accent. prod is deliberately alarming. */
  tone: 'staging' | 'prod';
}

export const ENV_META: Record<EnvName, EnvMeta> = {
  staging: { name: 'staging', label: 'Staging', tone: 'staging' },
  prod: { name: 'prod', label: 'Production', tone: 'prod' },
};

/**
 * The SINGLE environment this console deployment targets — determined by the
 * server, NOT chosen in the UI. Set `STATIONLY_ENV` to `staging` or
 * `production` on the deployed instance. Defaults to `staging` (the safe
 * default; prod must be opt-in).
 */
export function activeEnv(): EnvName {
  const raw = (process.env.STATIONLY_ENV || process.env.APP_ENV || '').trim().toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'prod';
  return 'staging';
}

export interface ResolvedEnv {
  name: EnvName;
  baseUrl: string;
  adminKey?: string;
  cfClientId?: string;
  cfClientSecret?: string;
}

// Defaults mirror AppConfig.kt; overridable via env for flexibility.
const DEFAULT_URLS: Record<EnvName, string> = {
  staging: process.env.STAGING_BACKEND_URL || 'https://staging-api.stationly.co.uk',
  prod: process.env.PROD_BACKEND_URL || 'https://api.stationly.co.uk',
};

/**
 * Resolve a target env to its base URL + secrets. Per-env vars take the form
 * STAGING_ADMIN_KEY / PROD_ADMIN_KEY, etc. SERVER-ONLY.
 */
export function resolveEnv(name: EnvName): ResolvedEnv {
  const prefix = name === 'prod' ? 'PROD' : 'STAGING';
  return {
    name,
    baseUrl: DEFAULT_URLS[name].replace(/\/+$/, ''),
    adminKey: process.env[`${prefix}_ADMIN_KEY`],
    cfClientId: process.env[`${prefix}_CF_ACCESS_CLIENT_ID`],
    cfClientSecret: process.env[`${prefix}_CF_ACCESS_CLIENT_SECRET`],
  };
}
