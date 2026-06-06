'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ViewHeader from './ViewHeader';
import { relTime, dateTime } from '@/lib/format';
import { ENV_META, type EnvName } from '@/lib/env';
import type { AdminUser } from '@/lib/backend';

export default function UsersTable({ env }: { env: EnvName }) {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [cached, setCached] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/data?resource=users${refresh ? '&refresh=1' : ''}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setItems(Array.isArray(data.items) ? data.items : []);
        setRefreshedAt(data.refreshedAt || 0);
        setCached(!!data.cached);
      } else {
        setItems([]);
        setError(data.message || `Failed (${res.status})`);
      }
    } catch (e: any) {
      setItems([]);
      setError(e?.message ?? 'Network error');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter(
      (u) =>
        u.email.toLowerCase().includes(s) ||
        u.displayName.toLowerCase().includes(s) ||
        u.uid.toLowerCase().includes(s),
    );
  }, [items, q]);

  return (
    <div>
      <ViewHeader env={env}>
        <button onClick={() => load(true)} disabled={busy} title="Does one live Firestore read">
          {busy ? '…' : '↻ Refresh (1 read)'}
        </button>
      </ViewHeader>

      <div className="toolbar">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email, name or UID…" />
        <span className="toolbar-meta">
          {filtered.length} of {items.length} ·{' '}
          {refreshedAt ? `${cached ? '⚡ cached, ' : ''}refreshed ${relTime(refreshedAt)}` : 'from local cache'}
        </span>
      </div>

      {error && <div className="errors">{error}</div>}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {filtered.length === 0 && !busy ? (
          <p className="empty" style={{ padding: 28 }}>
            No users {q ? 'match your search' : `cached for ${ENV_META[env].label}. Hit Refresh to load.`}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Status</th>
                <th>Stations</th>
                <th className="nowrap">Last seen</th>
                <th className="nowrap">Joined</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.uid}>
                  <td>
                    <div className="cell-title">{u.displayName || '(no name)'}</div>
                    <div className="cell-sub">{u.email || u.uid}</div>
                  </td>
                  <td className="nowrap">
                    <span className={`pill ${u.loggedIn ? 'on' : 'off'}`}>{u.loggedIn ? 'Active' : 'Offline'}</span>
                    {u.emailVerified ? <span className="pill verified">Verified</span> : <span className="pill muted">Unverified</span>}
                  </td>
                  <td>{u.stationCount}</td>
                  <td className="muted nowrap">{relTime(u.lastLoggedInTime)}</td>
                  <td className="muted nowrap">{dateTime(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
