import { NOTIFICATION_POLICY_CACHE, readNotificationPolicy, withNotificationLock } from './notification-policy';

/** Explicitly user-authored, device-wide fixed copy. Never uploaded or read from the chat vault. */
export const NOTIFICATION_COPY_URL = '/__quiet-room-notification-copy';
export const DEFAULT_NOTIFICATION_COPY = { v: 1 as const, title: 'Quiet Room', body: '有一条新消息，解锁后查看。' };
export type NotificationCopy = typeof DEFAULT_NOTIFICATION_COPY;
export const NOTIFICATION_COPY_LIMITS = { title: 24, body: 80 };
export function notificationCopyLength(value: string): number {
  return [...new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value)].length;
}
export function notificationCopyError(key: 'title' | 'body', value: string): string {
  if (notificationCopyLength(value) > NOTIFICATION_COPY_LIMITS[key]) return `请缩短到 ${NOTIFICATION_COPY_LIMITS[key]} 个字以内。`;
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? '请移除不可显示的字符。' : '';
}
export function normalizeNotificationCopy(value: Pick<NotificationCopy, 'title' | 'body'>): NotificationCopy {
  for (const key of ['title', 'body'] as const) {
    const error = notificationCopyError(key, value[key]);
    if (error) throw new Error(error);
  }
  return { v: 1, title: value.title.trim() || DEFAULT_NOTIFICATION_COPY.title, body: value.body.trim() || DEFAULT_NOTIFICATION_COPY.body };
}
export async function readNotificationCopy(): Promise<NotificationCopy> {
  const response = await (await caches.open(NOTIFICATION_POLICY_CACHE)).match(NOTIFICATION_COPY_URL);
  if (!response) return { ...DEFAULT_NOTIFICATION_COPY };
  try {
    const value = await response.json();
    if (value?.v !== 1 || typeof value.title !== 'string' || typeof value.body !== 'string') return { ...DEFAULT_NOTIFICATION_COPY };
    return normalizeNotificationCopy(value);
  } catch { return { ...DEFAULT_NOTIFICATION_COPY }; }
}
export async function saveNotificationCopy(value: Pick<NotificationCopy, 'title' | 'body'>, signal: AbortSignal): Promise<NotificationCopy> {
  const copy = normalizeNotificationCopy(value);
  return withNotificationLock(signal, async () => {
    const cache = await caches.open(NOTIFICATION_POLICY_CACHE);
    signal.throwIfAborted();
    // Cache.put replaces one complete record atomically, including while the worker reads it.
    await cache.put(NOTIFICATION_COPY_URL, new Response(JSON.stringify(copy), { headers: { 'Content-Type': 'application/json' } }));
    signal.throwIfAborted();
    return copy;
  });
}
export function notificationCopyPaused(): boolean { return readNotificationPolicy()?.enabled === false; }
