'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import ViewHeader from './ViewHeader';
import { relTime, num } from '@/lib/format';
import { ENV_META, type EnvName } from '@/lib/env';
import type { DashboardStats } from '@/lib/backend';

export default function Dashboard({ env }: { env: EnvName }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/data?resource=stats`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setStats(data);
      else {
        setStats(null);
        setError(data.message || `Failed (${res.status})`);
      }
    } catch (e: any) {
      setStats(null);
      setError(e?.message ?? 'Network error');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <ViewHeader env={env}>
        <button onClick={load} disabled={busy}>
          {busy ? '…' : '↻ Refresh'}
        </button>
      </ViewHeader>

      {error && <div className="errors">{error}</div>}

      <div className="stat-grid">
        <StatCard label="Users" value={num(stats?.users.total)} sub={`${num(stats?.users.active)} active now`} href="/users" accent />
        <StatCard label="Waitlist" value={num(stats?.waitlist.total)} sub="signups" href="/waitlist" accent />
        <StatCard label="Subscribed stations" value={num(stats?.subscribedStations)} sub="being watched" href="/stations" accent />
        <StatCard label="Stations" value={num(stats?.transport.stations)} sub="in cache" />
        <StatCard label="Lines" value={num(stats?.transport.lines)} sub="in cache" />
        <StatCard label="Modes" value={num(stats?.transport.modes)} sub="in cache" />
      </div>

      <div className="grid" style={{ marginTop: 8 }}>
        <div className="card">
          <h2>Recent sends</h2>
          {stats?.recentNotifications?.length ? (
            <ul className="feed">
              {stats.recentNotifications.map((n) => (
                <li key={n.id}>
                  <span className={`feed-dot ${n.ok ? 'ok' : 'fail'}`} />
                  <div className="feed-body">
                    <div className="feed-title">
                      {n.severity && <span className={`glyph ${n.severity}`}>●</span>}
                      {n.title || '(no title)'}
                    </div>
                    <div className="feed-meta">
                      {n.audienceSummary} · {relTime(n.createdAt)} ·{' '}
                      {n.ok ? <span className="ok-n">{n.successCount}✓</span> : <span className="fail-n">failed</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No sends recorded yet on {ENV_META[env].label}.</p>
          )}
          <Link href="/history" className="card-link">View all history →</Link>
        </div>

        <div className="card">
          <h2>Quick actions</h2>
          <div className="actions-col">
            <Link href="/notifications" className="action-tile">
              <b>Send a notification</b>
              <span>Compose &amp; broadcast a push</span>
            </Link>
            <Link href="/audiences" className="action-tile">
              <b>Audience lookup</b>
              <span>Check a UID&apos;s device count</span>
            </Link>
            <Link href="/users" className="action-tile">
              <b>Browse users</b>
              <span>Profiles, sessions, stations</span>
            </Link>
          </div>
          {stats && (
            <p className="empty" style={{ marginTop: 14 }}>
              Users data {stats.users.refreshedAt ? `refreshed ${relTime(stats.users.refreshedAt)}` : 'not loaded yet'} · served from local cache (0 Firestore reads)
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  href,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  href?: string;
  accent?: boolean;
}) {
  const inner = (
    <div className={`stat-card${accent ? ' accent' : ''}${href ? ' clickable' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
