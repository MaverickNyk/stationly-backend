'use client';

import { useState } from 'react';
import Link from 'next/link';
import ViewHeader from './ViewHeader';
import { type EnvName } from '@/lib/env';
import type { TokenStats } from '@/lib/backend';

export default function AudienceLookup({ env }: { env: EnvName }) {
  const [uid, setUid] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; data: TokenStats | { message?: string } } | null>(null);

  async function lookup(fresh = false) {
    const id = uid.trim();
    if (!id) return;
    setBusy(true);
    if (!fresh) setResult(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}${fresh ? '?fresh=1' : ''}`);
      const data = await res.json().catch(() => ({}));
      setResult({ ok: res.ok, data });
    } catch (e: any) {
      setResult({ ok: false, data: { message: e?.message ?? 'Network error' } });
    } finally {
      setBusy(false);
    }
  }

  const stats = result?.ok ? (result.data as TokenStats) : null;

  return (
    <div style={{ maxWidth: 620 }}>
      <ViewHeader env={env} />

      <div className="card">
        <h2>Firebase UID</h2>
        <div className="field">
          <input
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup(false)}
            placeholder="Paste a Firebase user id…"
          />
          <div className="hint">Resolves to the user&apos;s registered device count. Tokens are never shown.</div>
        </div>
        <button className="btn-send" disabled={busy || !uid.trim()} onClick={() => lookup(false)}>
          {busy ? 'Looking up…' : 'Look up'}
        </button>

        {result && (
          <div className={`result ${result.ok ? 'ok' : 'fail'}`}>
            {result.ok && stats ? (
              <>
                {stats.deliverable ? '✅ Deliverable' : '⚠️ No registered devices'}
                <div className="counts">
                  <span>
                    devices <b className={stats.deliverable ? 'ok-n' : 'fail-n'}>{stats.tokenCount}</b>
                  </span>
                  <span style={{ color: 'var(--muted-2)', alignSelf: 'center' }}>
                    {stats.source === 'cache' ? '⚡ from cache (0 reads)' : '📡 live read'}
                  </span>
                </div>
                {!stats.deliverable && (
                  <pre>
                    This uid has no FCM tokens — the user hasn&apos;t registered a device (or hasn&apos;t opened the
                    app since install). A `uid` push would be a no-op.
                  </pre>
                )}
                <div style={{ display: 'flex', gap: 12, marginTop: 14, alignItems: 'center' }}>
                  <button className="btn-ghost" onClick={() => lookup(true)} disabled={busy}>
                    Force live refresh
                  </button>
                  {stats.deliverable && (
                    <Link className="btn-ghost" href={`/notifications`}>
                      Compose to this uid →
                    </Link>
                  )}
                </div>
              </>
            ) : (
              <>
                ❌ Lookup failed
                <pre>{JSON.stringify(result.data, null, 2)}</pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
