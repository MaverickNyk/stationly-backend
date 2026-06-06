'use client';

import { useMemo, useState } from 'react';
import NotificationPreview from './NotificationPreview';
import ViewHeader from './ViewHeader';
import { TFL_LINES } from '@/lib/lines';
import {
  AUDIENCE_LABELS,
  BLAST_AUDIENCES,
  validatePayload,
  type AudienceType,
  type Audience,
  type NotificationPayload,
  type SendResult,
  type Severity,
  type Style,
} from '@/lib/payload';
import { ENV_META, type EnvName } from '@/lib/env';

const AUDIENCE_TYPES: AudienceType[] = ['all', 'line', 'topic', 'uid', 'uids', 'token', 'tokens'];
const SEVERITIES: (Severity | '')[] = ['', 'info', 'success', 'warning', 'danger', 'neutral'];
// Only the styles the app's NotificationDispatcher renders meaningfully from
// an admin push. `inbox` is omitted — it lists `actions` rows, which the
// composer doesn't set, so it would render an empty expanded view.
const STYLES: Style[] = ['bigText', 'bigPicture'];
const TYPES = ['announcement', 'line_status_change', 'promo', 'system'];

const NEEDS_SINGLE_VALUE: AudienceType[] = ['line', 'topic', 'uid', 'token'];
const NEEDS_LIST_VALUE: AudienceType[] = ['uids', 'tokens'];

export default function Composer({ env }: { env: EnvName }) {
  const [audienceType, setAudienceType] = useState<AudienceType>('all');
  const [audienceValue, setAudienceValue] = useState('');

  const [payload, setPayload] = useState<NotificationPayload>({
    type: 'announcement',
    title: '',
    body: '',
  });

  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; data: any } | null>(null);

  const set = (patch: Partial<NotificationPayload>) => setPayload((p) => ({ ...p, ...patch }));

  const errors = useMemo(() => {
    const e = validatePayload(payload);
    if (NEEDS_SINGLE_VALUE.includes(audienceType) && !audienceValue.trim()) {
      e.push(`Audience "${AUDIENCE_LABELS[audienceType]}" needs a value`);
    }
    if (NEEDS_LIST_VALUE.includes(audienceType)) {
      const items = splitList(audienceValue);
      if (items.length === 0) e.push('Provide at least one value (one per line)');
      if (items.length > 500) e.push('FCM caps lists at 500 per send');
    }
    return e;
  }, [payload, audienceType, audienceValue]);

  function buildAudience(): Audience {
    switch (audienceType) {
      case 'all':
        return { type: 'all' };
      case 'tokens':
        return { type: 'tokens', value: splitList(audienceValue) };
      case 'uids':
        return { type: 'uids', value: splitList(audienceValue) };
      default:
        return { type: audienceType, value: audienceValue.trim() } as Audience;
    }
  }

  function attemptSend() {
    if (errors.length > 0) return;
    if (BLAST_AUDIENCES.includes(audienceType) || env === 'prod') setConfirm(true);
    else doSend();
  }

  async function doSend() {
    setConfirm(false);
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience: buildAudience(), payload: clean(payload) }),
      });
      const data = await res.json().catch(() => ({}));
      setResult({ ok: res.ok, data });
    } catch (e: any) {
      setResult({ ok: false, data: { message: e?.message ?? 'Network error' } });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ViewHeader env={env} label="Sending to">
        {env === 'prod' && <span style={{ color: 'var(--danger)', fontSize: 12, fontWeight: 700 }}>reaches real users</span>}
      </ViewHeader>

      <div className="grid">
        {/* ── Left: the form ─────────────────────────────────────── */}
        <div>
          <div className="card">
            <h2>Audience</h2>
            <div className="seg" style={{ marginBottom: 16 }}>
              {AUDIENCE_TYPES.map((t) => (
                <button
                  key={t}
                  className={t === audienceType ? 'active' : ''}
                  onClick={() => {
                    setAudienceType(t);
                    setAudienceValue('');
                  }}
                >
                  {AUDIENCE_LABELS[t]}
                </button>
              ))}
            </div>

            {audienceType === 'line' ? (
              <div className="field">
                <label>Line</label>
                <select value={audienceValue} onChange={(e) => setAudienceValue(e.target.value)}>
                  <option value="">Select a line…</option>
                  {TFL_LINES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <div className="hint">Delivered via the LineStatus_&lt;id&gt; topic.</div>
              </div>
            ) : NEEDS_LIST_VALUE.includes(audienceType) ? (
              <div className="field">
                <label>{audienceType === 'uids' ? 'Firebase UIDs' : 'FCM tokens'} · one per line</label>
                <textarea
                  rows={4}
                  value={audienceValue}
                  onChange={(e) => setAudienceValue(e.target.value)}
                  placeholder={audienceType === 'uids' ? 'uid_abc\nuid_def' : 'token1\ntoken2'}
                />
                <div className="hint">{splitList(audienceValue).length} item(s) · max 500.</div>
              </div>
            ) : audienceType !== 'all' ? (
              <div className="field">
                <label>
                  {audienceType === 'uid' ? 'Firebase UID' : audienceType === 'token' ? 'FCM token' : 'Topic name'}
                </label>
                <input
                  value={audienceValue}
                  onChange={(e) => setAudienceValue(e.target.value)}
                  placeholder={audienceType === 'topic' ? 'e.g. LineStatus_piccadilly' : 'Paste value…'}
                />
              </div>
            ) : (
              <div className="hint">Broadcast to everyone via the stationly_all topic. No value needed.</div>
            )}
          </div>

          <div className="card">
            <h2>Message</h2>
            <div className="row">
              <div className="field">
                <label>Type</label>
                <select value={payload.type} onChange={(e) => set({ type: e.target.value })}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Severity</label>
                <select
                  value={payload.severity ?? ''}
                  onChange={(e) => set({ severity: (e.target.value || undefined) as Severity })}
                >
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s === '' ? 'Auto / none' : s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field">
              <label>Title</label>
              <input value={payload.title} onChange={(e) => set({ title: e.target.value })} placeholder="Piccadilly · Severe Delays" />
            </div>
            <div className="field">
              <label>Body</label>
              <textarea
                value={payload.body}
                onChange={(e) => set({ body: e.target.value })}
                placeholder="Signal failure between Acton Town and Heathrow."
              />
            </div>
          </div>

          <div className="card">
            <button
              type="button"
              className="advanced-toggle"
              onClick={() => setAdvanced((a) => !a)}
              aria-expanded={advanced}
            >
              <span>Advanced options</span>
              <span className="chev">{advanced ? '▲' : '▼'}</span>
            </button>

            {advanced && (
              <div className="advanced-body">
                <div className="field">
                  <label>Subtitle</label>
                  <input
                    value={payload.subtitle ?? ''}
                    onChange={(e) => set({ subtitle: e.target.value || undefined })}
                    placeholder="Short context line above the body"
                  />
                  <div className="hint">Shown as the notification sub-text.</div>
                </div>

                <div className="row">
                  <div className="field">
                    <label>Style</label>
                    <select
                      value={payload.style ?? 'bigText'}
                      onChange={(e) => {
                        const style = e.target.value as Style;
                        // Drop imageUrl when not bigPicture — it's only used there.
                        set(style === 'bigPicture' ? { style } : { style, imageUrl: undefined });
                      }}
                    >
                      {STYLES.map((s) => (
                        <option key={s} value={s}>
                          {s === 'bigText' ? 'Big text (default)' : 'Big picture (image)'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Line tint</label>
                    <select value={payload.lineId ?? ''} onChange={(e) => set({ lineId: e.target.value || undefined })}>
                      <option value="">None</option>
                      {TFL_LINES.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                    <div className="hint">Auto-colours the chip with the line colour.</div>
                  </div>
                </div>

                {payload.style === 'bigPicture' && (
                  <div className="field">
                    <label>Image URL (HTTPS)</label>
                    <input
                      value={payload.imageUrl ?? ''}
                      onChange={(e) => set({ imageUrl: e.target.value || undefined })}
                      placeholder="https://…"
                    />
                    <div className="hint">Fills the expanded notification. Required for Big picture.</div>
                  </div>
                )}

                <div className="row">
                  <div className="field">
                    <label>Colour override (hex)</label>
                    <input value={payload.color ?? ''} onChange={(e) => set({ color: e.target.value || undefined })} placeholder="#FFB81C" />
                    <div className="hint">Some Android skins re-tint this; the severity dot is the reliable cue.</div>
                  </div>
                  <div className="field">
                    <label>Deep link</label>
                    <input value={payload.deepLink ?? ''} onChange={(e) => set({ deepLink: e.target.value || undefined })} placeholder="stationly://home" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {errors.length > 0 && (
            <div className="errors">
              Fix before sending:
              <ul>
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <button className="btn-send" disabled={busy || errors.length > 0} onClick={attemptSend}>
            {busy ? 'Sending…' : `Send on ${ENV_META[env].label}`}
          </button>

          {result && (
            <div className={`result ${result.ok ? 'ok' : 'fail'}`}>
              {result.ok ? '✅ Sent' : '❌ Failed'}
              {result.ok && typeof (result.data as SendResult).successCount === 'number' && (
                <div className="counts">
                  <span>
                    delivered <b className="ok-n">{(result.data as SendResult).successCount}</b>
                  </span>
                  <span>
                    failed <b className="fail-n">{(result.data as SendResult).failureCount}</b>
                  </span>
                  {(result.data as SendResult).messageId && <span>id {(result.data as SendResult).messageId}</span>}
                </div>
              )}
              {(!result.ok || (result.data as SendResult).failures?.length) && (
                <pre>{JSON.stringify(result.data, null, 2)}</pre>
              )}
            </div>
          )}
        </div>

        {/* ── Right: the live preview ────────────────────────────── */}
        <div>
          <div className="card">
            <h2>Preview</h2>
            <NotificationPreview payload={payload} />
          </div>
        </div>
      </div>

      {confirm && (
        <div className="confirm-overlay" onClick={() => setConfirm(false)}>
          <div className={`confirm-box ${env === 'prod' ? 'prod' : ''}`} onClick={(e) => e.stopPropagation()}>
            <h3>{env === 'prod' ? 'Send to PRODUCTION?' : 'Confirm broadcast'}</h3>
            <p>
              You&apos;re about to send <b>{AUDIENCE_LABELS[audienceType]}</b> on <b>{ENV_META[env].label}</b>
              {env === 'prod' && ' — this reaches real users and cannot be undone'}.
            </p>
            <div className="actions">
              <button className="cancel" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button className="go" onClick={doSend}>
                Send now
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function splitList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clean(p: NotificationPayload): NotificationPayload {
  const out: any = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as NotificationPayload;
}
