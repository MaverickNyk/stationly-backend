'use client';

import { useCallback, useEffect, useState } from 'react';
import ViewHeader from './ViewHeader';
import { dateTime, relTime } from '@/lib/format';
import { ENV_META, type EnvName } from '@/lib/env';
import type { HistoryItem } from '@/lib/backend';

export default function HistoryTable({ env }: { env: EnvName }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/history?limit=100`);
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

  return (
    <div>
      <ViewHeader env={env}>
        <button onClick={load} disabled={busy}>
          {busy ? '…' : '↻ Refresh'}
        </button>
      </ViewHeader>

      {error && <div className="errors">{error}</div>}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {items.length === 0 && !busy ? (
          <p className="empty" style={{ padding: 28 }}>
            No sends recorded yet on {ENV_META[env].label}.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Audience</th>
                <th>Message</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="muted nowrap" title={dateTime(it.createdAt)}>{relTime(it.createdAt)}</td>
                  <td className="nowrap">{it.audienceSummary}</td>
                  <td>
                    <div className="cell-title">
                      {it.severity && <span className={`glyph ${it.severity}`}>●</span>}
                      {it.title}
                    </div>
                    <div className="cell-sub" style={{ fontFamily: 'inherit' }}>{it.body}</div>
                  </td>
                  <td className="muted nowrap">{it.payloadType}</td>
                  <td style={{ textAlign: 'right' }} className="nowrap">
                    {it.ok ? (
                      <>
                        <span className="ok-n">{it.successCount}✓</span>{' '}
                        {it.failureCount > 0 && <span className="fail-n">{it.failureCount}✗</span>}
                      </>
                    ) : (
                      <span className="fail-n">failed</span>
                    )}
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
