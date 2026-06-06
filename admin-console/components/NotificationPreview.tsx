'use client';

import type { NotificationPayload, Severity } from '@/lib/payload';
import { lineColor } from '@/lib/lines';

/**
 * Renders an Android-style notification chip from the payload, mirroring the
 * backend's `enrichPayload` so the preview matches what actually ships:
 *   - severity auto-derives from `newStatus` when not set
 *   - chip tint auto-fills from `lineId` colour when `color` not set
 */

const STATUS_SEVERITY: Record<string, Severity> = {
  'good service': 'success',
  'severe delays': 'danger',
  'service closed': 'danger',
  'part suspended': 'danger',
  suspended: 'danger',
  'planned closure': 'danger',
  'minor delays': 'warning',
  'part closure': 'warning',
  'reduced service': 'warning',
};

function effectiveSeverity(p: NotificationPayload): Severity | undefined {
  if (p.severity) return p.severity;
  if (p.newStatus) return STATUS_SEVERITY[p.newStatus.trim().toLowerCase()] ?? 'neutral';
  return undefined;
}

function effectiveColor(p: NotificationPayload): string | undefined {
  return p.color || lineColor(p.lineId);
}

export default function NotificationPreview({ payload }: { payload: NotificationPayload }) {
  const severity = effectiveSeverity(payload);
  const tint = effectiveColor(payload);
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const title = payload.title?.trim() || 'Notification title';
  const body = payload.body?.trim() || 'Your notification body text will appear here.';
  const initial = (payload.lineName || payload.lineId || 'S').charAt(0).toUpperCase();

  return (
    <div className="preview-wrap">
      <div className="phone" style={{ ['--line-color' as any]: tint }}>
        <div className="status-line">
          <span>{now}</span>
          <span>Stationly · now</span>
        </div>

        <div className="notif">
          <div className={`icon${tint ? ' lined' : ''}`} style={tint ? { background: tint, color: contrast(tint) } : undefined}>
            {initial}
          </div>
          <div className="content">
            <div className="app-row">
              <span>Stationly</span>
              <span className="dot" />
              <span>{payload.channel || 'now'}</span>
            </div>

            <p className="ntitle">
              {severity && <span className={`glyph ${severity}`}>●</span>}
              {title}
            </p>

            {payload.subtitle?.trim() && <p className="nsub">{payload.subtitle}</p>}

            <p className="nbody">{body}</p>

            {payload.style === 'bigPicture' && payload.imageUrl?.startsWith('https://') && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="nimg" src={payload.imageUrl} alt="" />
            )}

            {payload.actions && payload.actions.length > 0 && (
              <div className="actions">
                {payload.actions.slice(0, 3).map((a, i) => (
                  <span key={i}>{a.label || 'Action'}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="preview-note">Live preview · approximates the on-device chip</p>
    </div>
  );
}

/** Pick black/white text for legibility over an arbitrary hex background. */
function contrast(hex: string): string {
  const h = hex.replace('#', '').slice(0, 6);
  if (h.length < 6) return '#000';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}
