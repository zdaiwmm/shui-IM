import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import type { Vault } from './types';

export type NotificationCapability = 'available' | 'unsupported' | 'home-screen' | 'blocked' | 'unavailable' | 'unknown';
type PushConfiguration = { enabled: boolean; publicKey: string | null };
export function notificationPlatformCapability(): NotificationCapability {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (ios && !matchMedia('(display-mode: standalone)').matches && !(navigator as Navigator & { standalone?: boolean }).standalone) return 'home-screen';
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || !navigator.locks || !('caches' in window)) return 'unsupported';
  return Notification.permission === 'denied' ? 'blocked' : 'available';
}
async function responseError(response: Response): Promise<Error> {
  return new Error(response.status === 401 || response.status === 403 ? '此空间的本机访问已失效，请重新打开空间确认' : response.status === 503 ? '通知服务暂不可用，请稍后重试' : response.status === 429 ? '操作过于频繁，请稍后重试' : '通知设置未能确认，请检查网络后重试');
}
async function configuration(signal?: AbortSignal): Promise<PushConfiguration> {
  const response = await fetch('/api/push/public-key', { cache: 'no-store', signal: bounded(signal) });
  if (!response.ok) throw await responseError(response);
  return response.json();
}
const bounded = (signal?: AbortSignal) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]);
export async function notificationCapability(signal: AbortSignal): Promise<NotificationCapability> {
  const platform = notificationPlatformCapability();
  if (platform !== 'available') return platform;
  try { const config = await configuration(signal); return config.enabled && config.publicKey ? 'available' : 'unavailable'; }
  catch { signal.throwIfAborted(); return 'unknown'; }
}
export async function notificationRegistration(signal: AbortSignal): Promise<ServiceWorkerRegistration> {
  // ready can wait forever when registration failed. Bound it and respect privacy aborts.
  const timeout = bounded(signal);
  timeout.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(timeout.reason);
    timeout.addEventListener('abort', abort, { once: true });
    navigator.serviceWorker.ready.then(registration => {
      timeout.removeEventListener('abort', abort); timeout.aborted ? reject(timeout.reason) : resolve(registration);
    }, error => { timeout.removeEventListener('abort', abort); reject(error); });
  });
}
async function authorized(vault: Vault, init: RequestInit, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  const response = await fetch(`/api/rooms/${vault.roomId}/push/${vault.identity.publicBundle.deviceId}`, {
    ...init, cache: 'no-store', signal: bounded(signal),
    headers: { Authorization: `Bearer ${vault.accessToken}`, ...init.headers },
  });
  if (!response.ok) throw await responseError(response);
  signal.throwIfAborted();
  return response;
}
export async function createPushAuthorization(vault: Vault, action: 'subscribe' | 'unsubscribe', endpoint: string) {
  const unsigned = { v: 1 as const, action, roomId: vault.roomId, deviceId: vault.identity.publicBundle.deviceId, endpoint };
  const key = await crypto.subtle.importKey('jwk', vault.identity.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(canonicalStringify(unsigned)));
  return { ...unsigned, signature: toBase64Url(signature) };
}
export async function confirmedSpaceNotification(vault: Vault, endpoint: string, signal: AbortSignal): Promise<boolean> {
  const value = await (await authorized(vault, { method: 'GET' }, signal)).json() as { endpoint: string | null };
  signal.throwIfAborted();
  return value.endpoint === endpoint;
}
/** Uses an already granted permission. The settings click owns the permission prompt. */
export async function subscribeBrowserNotifications(signal: AbortSignal): Promise<{ subscription: PushSubscription; created: boolean }> {
  if (notificationPlatformCapability() !== 'available' || Notification.permission !== 'granted') throw new Error('请先允许本机使用通知');
  const config = await configuration(signal);
  if (!config.enabled || !config.publicKey) throw new Error('通知服务暂不可用，请稍后重试');
  const registration = await notificationRegistration(signal);
  signal.throwIfAborted();
  const existing = await registration.pushManager.getSubscription();
  signal.throwIfAborted();
  if (existing) return { subscription: existing, created: false };
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(config.publicKey) });
  if (signal.aborted) { await subscription.unsubscribe().catch(() => false); signal.throwIfAborted(); }
  return { subscription, created: true };
}
export async function registerSpaceNotification(vault: Vault, subscription: PushSubscription, signal: AbortSignal): Promise<void> {
  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) throw new Error('本机通知订阅不完整，请关闭后重新开启');
  const response = await authorized(vault, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: { endpoint: serialized.endpoint, keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth } }, authorization: await createPushAuthorization(vault, 'subscribe', serialized.endpoint) }),
  }, signal);
  const value = await response.json() as { stored?: boolean };
  signal.throwIfAborted();
  if (value.stored !== true) throw new Error('通知设置未能确认，请重试');
}
/** A space opt-out only removes that device's room row; the browser endpoint is shared. */
export async function unregisterSpaceNotification(vault: Vault, endpoint: string, signal: AbortSignal): Promise<void> {
  const response = await authorized(vault, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization: await createPushAuthorization(vault, 'unsubscribe', endpoint) }),
  }, signal);
  const value = await response.json() as { removed?: boolean };
  signal.throwIfAborted();
  if (value.removed !== true) throw new Error('通知设置未能确认，请重试');
}
