'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ViewHeader from './ViewHeader';
import { ENV_META, type EnvName } from '@/lib/env';
import type { SubscribedStation } from '@/lib/backend';

export default function StationsTable({ env }: { env: EnvName }) {
  const [items, setItems] = useState<SubscribedStation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/data?resource=subscribed`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems(Array.isArray(data.items) ? data.items : []);
      else {
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
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter(
      (st) => (st.commonName || '').toLowerCase().includes(s) || st.naptanId.toLowerCase().includes(s),
    );
  }, [items, q]);

  const maxCount = useMemo(() => Math.max(1, ...items.map((i) => i.count)), [items]);

  return (
    <div>
      <ViewHeader env={env}>
        <button onClick={load} disabled={busy}>
          {busy ? '…' : '↻ Refresh'}
        </button>
      </ViewHeader>

      <div className="toolbar">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search station name or Naptan…" />
        <span className="toolbar-meta">{filtered.length} of {items.length} · served from memory (0 reads)</span>
      </div>

      {error && <div className="errors">{error}</div>}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {filtered.length === 0 && !busy ? (
          <p className="empty" style={{ padding: 28 }}>
            No subscribed stations {q ? 'match your search' : `on ${ENV_META[env].label}.`}
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Station</th>
                <th>Modes</th>
                <th style={{ width: '38%' }}>Subscribers</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((st) => (
                <tr key={st.naptanId}>
                  <td>
                    <div className="cell-title">{st.commonName || '(unknown station)'}</div>
                    <div className="cell-sub">{st.naptanId}</div>
                  </td>
                  <td className="nowrap">
                    {st.modes.length ? st.modes.map((m) => <span key={m} className="pill muted">{m}</span>) : '—'}
                  </td>
                  <td>
                    <div className="bar-row">
                      <div className="bar-track">
                        <div className="bar-fill" style={{ width: `${Math.round((st.count / maxCount) * 100)}%` }} />
                      </div>
                      <b>{st.count}</b>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
