import webpush from 'web-push';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';

export const DEFAULT_ALLOWED_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  '*.push.apple.com',
  '*.notify.windows.com',
];

function configuredValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeAllowedHosts(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : DEFAULT_ALLOWED_ENDPOINT_HOSTS;
  return [...new Set(values
    .filter((host) => typeof host === 'string')
    .map((host) => host.trim().toLowerCase().replace(/^\*\./, '*.'))
    .filter(Boolean))];
}

function hostAllowed(hostname, allowedHosts) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((allowed) => {
    if (allowed.startsWith('*.')) return host.endsWith(allowed.slice(1)) && host !== allowed.slice(2);
    return host === allowed;
  });
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 6) {
    if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPrivateAddress(mapped) : false;
  }
  if (isIP(normalized) !== 4) return false;
  const octets = normalized.split('.').map(Number);
  const [first, second] = octets;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) || first >= 224 ||
    (first === 192 && (second === 0 || second === 2)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0);
}

async function assertSafePushEndpoint(endpoint, allowedHosts) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !hostAllowed(url.hostname, allowedHosts)) {
    throw new Error('推送服务地址不在允许范围内');
  }
  if (isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error('推送服务地址不能指向本机或内网');
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('推送服务地址解析到了本机或内网地址');
  }
}

export function createPushService(options = {}) {
  const publicKey = configuredValue(options.publicKey ?? process.env.VAPID_PUBLIC_KEY);
  const privateKey = configuredValue(options.privateKey ?? process.env.VAPID_PRIVATE_KEY);
  const subject = configuredValue(options.subject ?? process.env.VAPID_SUBJECT) ?? 'mailto:security@example.invalid';
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts ?? process.env.PUSH_ALLOWED_HOSTS);
  const enabled = Boolean(publicKey && privateKey);

  if (enabled) webpush.setVapidDetails(subject, publicKey, privateKey);

  return {
    enabled,
    publicKey: enabled ? publicKey : null,
    allowedHosts,
    async wake(subscription) {
      if (!enabled) return { delivered: false, disabled: true };
      try {
        await assertSafePushEndpoint(subscription.endpoint, allowedHosts);
        // Deliberately omit a payload. Push providers receive only a generic wake-up,
        // never the room id, sender, message type, text, attachment metadata, or count.
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        }, undefined, {
          TTL: 60,
          urgency: 'high',
          topic: 'quiet-room-wake',
        });
        return { delivered: true };
      } catch (error) {
        const statusCode = Number(error?.statusCode ?? 0);
        return {
          delivered: false,
          expired: statusCode === 404 || statusCode === 410,
          statusCode,
          message: error instanceof Error ? error.message : 'PUSH_FAILED',
        };
      }
    },
  };
}

export function validatePushSubscription(value, options = {}) {
  if (!value || typeof value !== 'object') return false;
  const endpoint = value.endpoint;
  const keys = value.keys;
  if (typeof endpoint !== 'string' || endpoint.length < 16 || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname, normalizeAllowedHosts(options.allowedHosts))) return false;
    if (isPrivateAddress(url.hostname)) return false;
  } catch {
    return false;
  }
  return Boolean(
    keys &&
    typeof keys.p256dh === 'string' && /^[A-Za-z0-9_-]{40,256}$/.test(keys.p256dh) &&
    typeof keys.auth === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(keys.auth),
  );
}

export function validatePushAuthorization(value, roomId, deviceId, action, endpoint) {
  return Boolean(
    value &&
    value.v === 1 &&
    value.action === action &&
    value.roomId === roomId &&
    value.deviceId === deviceId &&
    value.endpoint === endpoint &&
    typeof value.signature === 'string' &&
    value.signature.length > 0 && value.signature.length <= 512
  );
}
