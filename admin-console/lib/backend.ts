/**
 * Server-only client for the Stationly backend admin API.
 *
 * THE security boundary: each environment's `ADMIN_KEY` and Cloudflare
 * service token live here, in the Next server's env, and are attached to
 * outbound requests. They are NEVER sent to the browser. The browser talks
 * only to this app's own /api/admin/* proxy routes (gated by the session
 * cookie); the target env is fixed by the deployment (staging | prod) and
 * resolved here server-side — never chosen by the browser.
 *
 * `import 'server-only'` makes the build fail loudly if this module is ever
 * imported into a Client Component.
 */
import 'server-only';
import type { SendRequest, SendResult } from './payload';
import { resolveEnv, type EnvName } from './env';

function adminHeaders(env: EnvName): { url: string; headers: Record<string, string> } {
  const cfg = resolveEnv(env);
  if (!cfg.adminKey) {
    throw new Error(`No admin key configured for "${env}" (set ${env.toUpperCase()}_ADMIN_KEY).`);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.adminKey}`,
  };
  // Cloudflare Access service token — attached only when configured for this
  // env, so the proxy can authenticate machine-to-machine through Access.
  if (cfg.cfClientId && cfg.cfClientSecret) {
    headers['CF-Access-Client-Id'] = cfg.cfClientId;
    headers['CF-Access-Client-Secret'] = cfg.cfClientSecret;
  }
  return { url: cfg.baseUrl, headers };
}

export interface BackendResponse<T> {
  ok: boolean;
  status: number;
  data: T | { error?: string; message?: string };
}

export async function sendNotification(
  env: EnvName,
  body: SendRequest,
): Promise<BackendResponse<SendResult>> {
  const { url, headers } = adminHeaders(env);
  const res = await fetch(`${url}/api/v1/admin/notifications/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { message: await res.text().catch(() => 'Unreadable response') };
  }
  return { ok: res.ok, status: res.status, data };
}

export interface HistoryItem {
  id: string;
  createdAt: number;
  audienceType: string;
  audienceSummary: string;
  payloadType: string;
  title: string;
  body: string;
  severity: string;
  successCount: number;
  failureCount: number;
  messageId: string;
  ok: number; // 0 | 1
}

/** Recent admin sends from a given env's local audit log. */
export async function getHistory(
  env: EnvName,
  limit = 50,
): Promise<BackendResponse<{ items: HistoryItem[]; count: number }>> {
  const { url, headers } = adminHeaders(env);
  const res = await fetch(
    `${url}/api/v1/admin/notifications/history?limit=${encodeURIComponent(String(limit))}`,
    { method: 'GET', headers, cache: 'no-store' },
  );

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { message: await res.text().catch(() => 'Unreadable response') };
  }
  return { ok: res.ok, status: res.status, data };
}

// ── Read-only data views ──────────────────────────────────────────────

export interface DashboardStats {
  transport: { stations: number; lines: number; modes: number; lineStatuses: number };
  subscribedStations: number;
  users: { total: number; active: number; refreshedAt: number };
  waitlist: { total: number; refreshedAt: number };
  recentNotifications: HistoryItem[];
}

export interface AdminUser {
  uid: string;
  email: string;
  displayName: string;
  createdAt: number;
  lastLoggedInTime: number;
  loggedIn: boolean;
  emailVerified: boolean;
  stationCount: number;
}

export interface WaitlistEntry {
  id: string;
  email: string;
  joinedAt: number;
}

export interface SubscribedStation {
  naptanId: string;
  count: number;
  commonName: string | null;
  lat: number | null;
  lon: number | null;
  modes: string[];
}

async function getJson<T>(env: EnvName, path: string): Promise<BackendResponse<T>> {
  const { url, headers } = adminHeaders(env);
  const res = await fetch(`${url}/api/v1${path}`, { method: 'GET', headers, cache: 'no-store' });
  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { message: await res.text().catch(() => 'Unreadable response') };
  }
  return { ok: res.ok, status: res.status, data };
}

export const getStats = (env: EnvName) =>
  getJson<DashboardStats>(env, '/admin/stats');

export const getUsers = (env: EnvName, refresh = false) =>
  getJson<{ items: AdminUser[]; count: number; cached: boolean; refreshedAt: number }>(
    env,
    `/admin/users${refresh ? '?refresh=1' : ''}`,
  );

export const getWaitlist = (env: EnvName, refresh = false) =>
  getJson<{ items: WaitlistEntry[]; count: number; cached: boolean; refreshedAt: number }>(
    env,
    `/admin/waitlist${refresh ? '?refresh=1' : ''}`,
  );

export const getSubscribedStations = (env: EnvName) =>
  getJson<{ items: SubscribedStation[]; count: number }>(env, '/admin/subscribed-stations');

export interface TokenStats {
  uid: string;
  tokenCount: number;
  deliverable: boolean;
  cached: boolean;
  source: 'cache' | 'firestore';
}

/**
 * Look up a uid's registered-device count (count only — never raw tokens).
 * Cache-first on the backend; `fresh` forces a live Firestore read.
 */
export async function getUserTokens(
  env: EnvName,
  uid: string,
  fresh?: boolean,
): Promise<BackendResponse<TokenStats>> {
  const { url, headers } = adminHeaders(env);
  const qs = fresh ? '?fresh=1' : '';
  const res = await fetch(
    `${url}/api/v1/admin/users/${encodeURIComponent(uid)}/tokens${qs}`,
    { method: 'GET', headers, cache: 'no-store' },
  );

  let data: any;
  try {
    data = await res.json();
  } catch {
    data = { message: await res.text().catch(() => 'Unreadable response') };
  }
  return { ok: res.ok, status: res.status, data };
}
