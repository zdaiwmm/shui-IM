/** Device-local, non-secret switches. No names, messages, keys or recovery material. */
export const NOTIFICATION_POLICY_KEY = 'quiet-room:notification-policy:v1';
export const NOTIFICATION_POLICY_CACHE = 'quiet-room-notification-policy-v1';
export const NOTIFICATION_POLICY_URL = '/__quiet-room-notification-policy';
export type NotificationPolicy = { v: 1; enabled: boolean; spaces: Record<string, boolean> };
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
export function readNotificationPolicy(): NotificationPolicy | null {
  const raw = localStorage.getItem(NOTIFICATION_POLICY_KEY);
  if (raw === null) return null;
  const value = JSON.parse(raw) as NotificationPolicy;
  if (value?.v !== 1 || typeof value.enabled !== 'boolean' || !value.spaces || typeof value.spaces !== 'object' || Array.isArray(value.spaces) ||
      Object.keys(value.spaces).length > 256 || Object.entries(value.spaces).some(([id, enabled]) => !uuid.test(id) || typeof enabled !== 'boolean')) {
    throw new Error('本机通知设置未能读取，请关闭通知后重试');
  }
  return value;
}
export function saveNotificationPolicy(policy: NotificationPolicy): void {
  localStorage.setItem(NOTIFICATION_POLICY_KEY, JSON.stringify(policy));
}
export async function setNotificationGate(enabled: boolean): Promise<void> {
  const cache = await caches.open(NOTIFICATION_POLICY_CACHE);
  await cache.put(NOTIFICATION_POLICY_URL, new Response(enabled ? 'on' : 'off'));
}
export function spaceNotificationEnabled(policy: NotificationPolicy, roomId: string): boolean {
  return policy.spaces[roomId] !== false;
}
export async function withNotificationLock<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  // Never run concurrent writers when cross-tab serialization is unavailable.
  if (!navigator.locks) throw new Error('当前浏览器无法安全保存通知设置');
  return navigator.locks.request('quiet-room:notification-settings:v1', { signal }, async () => {
    signal.throwIfAborted();
    return action();
  });
}
