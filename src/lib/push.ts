import { fromBase64Url } from './base64';
import { toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import type { Vault } from './types';

type PushConfiguration = { enabled: boolean; publicKey: string | null };

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as { error?: string };
    return new Error(body.error || `后台通知请求失败（${response.status}）`);
  } catch {
    return new Error(`后台通知请求失败（${response.status}）`);
  }
}

async function configuration(): Promise<PushConfiguration> {
  const response = await fetch('/api/push/public-key', { cache: 'no-store' });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

async function authorized(path: string, vault: Vault, init: RequestInit): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${vault.accessToken}`, ...init.headers },
  });
  if (!response.ok) throw await responseError(response);
  return response;
}

function pushPath(vault: Vault): string {
  return `/api/rooms/${vault.roomId}/push/${vault.identity.publicBundle.deviceId}`;
}

export async function createPushAuthorization(
  vault: Vault,
  action: 'subscribe' | 'unsubscribe',
  endpoint: string,
) {
  const unsigned = {
    v: 1 as const,
    action,
    roomId: vault.roomId,
    deviceId: vault.identity.publicBundle.deviceId,
    endpoint,
  };
  const key = await crypto.subtle.importKey(
    'jwk',
    vault.identity.signingPrivateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(canonicalStringify(unsigned)),
  );
  return { ...unsigned, signature: toBase64Url(signature) };
}

export async function backgroundNotificationStatus(): Promise<'unsupported' | 'unavailable' | 'blocked' | 'enabled' | 'off'> {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  const config = await configuration().catch(() => ({ enabled: false, publicKey: null }));
  if (!config.enabled) return 'unavailable';
  if (Notification.permission === 'denied') return 'blocked';
  const registration = await navigator.serviceWorker.ready;
  return await registration.pushManager.getSubscription() ? 'enabled' : 'off';
}

export async function enableBackgroundNotifications(vault: Vault): Promise<void> {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error('当前浏览器不支持安全后台通知');
  }
  const config = await configuration();
  if (!config.enabled || !config.publicKey) throw new Error('服务器尚未配置后台通知密钥');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? '后台通知权限已被浏览器阻止' : '未授予后台通知权限');
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(config.publicKey),
  });
  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
    await subscription.unsubscribe().catch(() => undefined);
    throw new Error('浏览器没有返回完整的通知订阅');
  }
  try {
    await authorized(pushPath(vault), vault, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: {
          endpoint: serialized.endpoint,
          keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth },
        },
        authorization: await createPushAuthorization(vault, 'subscribe', serialized.endpoint),
      }),
    });
  } catch (error) {
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }
}

export async function disableBackgroundNotifications(vault: Vault): Promise<void> {
  let endpoint = '';
  let subscription: PushSubscription | null = null;
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.ready;
    subscription = await registration.pushManager.getSubscription();
    endpoint = subscription?.endpoint ?? '';
  }
  await authorized(pushPath(vault), vault, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization: await createPushAuthorization(vault, 'unsubscribe', endpoint) }),
  });
  await subscription?.unsubscribe().catch(() => undefined);
}
