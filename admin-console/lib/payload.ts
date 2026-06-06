/**
 * Wire types for the admin notifications endpoint.
 *
 * MIRROR of the backend `src/admin/notificationService.ts` contract
 * (which itself mirrors the Android Kotlin `NotificationPayload`). Keep
 * all three in lockstep — adding a field on one without the others is the
 * easiest way to silently drop UX.
 */

export interface NotificationAction {
  label: string;
  deepLink: string;
}

export type Severity = 'danger' | 'warning' | 'success' | 'info' | 'neutral';
export type Style = 'bigText' | 'bigPicture' | 'inbox';
export type Priority = 'max' | 'high' | 'default' | 'low' | 'min';

export interface NotificationPayload {
  type: string;
  title: string;
  body: string;
  severity?: Severity;
  subtitle?: string;
  summary?: string;
  channel?: string;
  priority?: Priority;
  color?: string;
  imageUrl?: string;
  largeIconUrl?: string;
  style?: Style;
  deepLink?: string;
  actions?: NotificationAction[];
  groupKey?: string;
  notificationId?: number;
  // status-change extras
  lineId?: string;
  lineName?: string;
  previousStatus?: string;
  newStatus?: string;
}

export type AudienceType =
  | 'token'
  | 'tokens'
  | 'topic'
  | 'uid'
  | 'uids'
  | 'all'
  | 'line';

export type Audience =
  | { type: 'token'; value: string }
  | { type: 'tokens'; value: string[] }
  | { type: 'topic'; value: string }
  | { type: 'uid'; value: string }
  | { type: 'uids'; value: string[] }
  | { type: 'all' }
  | { type: 'line'; value: string };

export interface SendRequest {
  audience: Audience;
  payload: NotificationPayload;
}

export interface SendResult {
  successCount: number;
  failureCount: number;
  failures?: { code?: string; message?: string }[];
  messageId?: string;
}

/** Audiences whose blast radius is large/irreversible — UI confirms before send. */
export const BLAST_AUDIENCES: AudienceType[] = ['all', 'line', 'topic'];

export const AUDIENCE_LABELS: Record<AudienceType, string> = {
  all: 'All users (broadcast)',
  line: 'All subscribers of a line',
  topic: 'FCM topic',
  uid: 'Single user (UID)',
  uids: 'Multiple users (UIDs)',
  token: 'Single device token',
  tokens: 'Multiple device tokens',
};

/**
 * Client-side mirror of the backend `validatePayload` rules — instant
 * feedback in the form. The backend stays the source of truth.
 */
export function validatePayload(p: NotificationPayload): string[] {
  const errors: string[] = [];
  if (!p.type?.trim()) errors.push('Type is required');
  if (!p.title?.trim()) errors.push('Title is required');
  if (!p.body?.trim()) errors.push('Body is required');
  if (p.color && !/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(p.color)) {
    errors.push('Color must be hex (#RRGGBB or #AARRGGBB)');
  }
  if (p.imageUrl && !p.imageUrl.startsWith('https://')) {
    errors.push('Image URL must be HTTPS');
  }
  if (p.actions && p.actions.length > 3) {
    errors.push('Actions are capped at 3 by Android');
  }
  return errors;
}
