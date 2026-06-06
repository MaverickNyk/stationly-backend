'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ViewHeader from './ViewHeader';
import { relTime, dateTime } from '@/lib/format';
import { ENV_META, type EnvName } from '@/lib/env';
import type { WaitlistEntry } from '@/lib/backend';

export default function WaitlistTable({ env }: { env: EnvName }) {
  const [items, setItems] = useState<WaitlistEntry[]>([]);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [cached, setCached] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/data?resource=waitlist${refresh ? '&refresh=1' : ''}`);
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
    return s ? items.filter((w) => w.email.toLowerCase().includes(s)) : items;
  }, [items, q]);

  function exportCsv() {
    const csv = ['email,joinedAt', ...filtered.map((w) => `${w.email},${new Date(w.joinedAt).toISOString()}`)].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `waitlist-${env}.csv`;
    a.click();
  }

  return (
    <div>
      <ViewHeader env={env}>
        <button onClick={() => load(true)} disabled={busy} title="Does one live Firestore read">
          {busy ? '…' : '↻ Refresh (1 read)'}
        </button>
      </ViewHeader>

      <div className="toolbar">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email…" />
        <span className="toolbar-meta">
          {filtered.length} of {items.length} ·{' '}
          {refreshedAt ? `${cached ? '⚡ cached, ' : ''}refreshed ${relTime(refreshedAt)}` : 'from local cache'}
        </span>
        <button className="btn-ghost" onClick={exportCsv} disabled={!filtered.length}>
          Export CSV
        </button>
      </div>

      {error && <div className="errors">{error}</div>}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {filtered.length === 0 && !busy ? (
          <p className="empty" style={{ padding: 28 }}>
            No waitlist entries {q ? 'match your search' : `cached for ${ENV_META[env].label}. Hit Refresh to load.`}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th className="nowrap">Joined</th>
                <th className="nowrap">When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((w) => (
                <tr key={w.id}>
                  <td className="cell-title">{w.email}</td>
                  <td className="muted nowrap">{dateTime(w.joinedAt)}</td>
                  <td className="muted nowrap">{relTime(w.joinedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
