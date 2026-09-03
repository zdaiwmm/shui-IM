import webpush from 'web-push';

function configuredValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function createPushService(options = {}) {
  const publicKey = configuredValue(options.publicKey ?? process.env.VAPID_PUBLIC_KEY);
  const privateKey = configuredValue(options.privateKey ?? process.env.VAPID_PRIVATE_KEY);
  const subject = configuredValue(options.subject ?? process.env.VAPID_SUBJECT) ?? 'mailto:security@example.invalid';
  const enabled = Boolean(publicKey && privateKey);

  if (enabled) webpush.setVapidDetails(subject, publicKey, privateKey);

  return {
    enabled,
    publicKey: enabled ? publicKey : null,
    async wake(subscription) {
      if (!enabled) return { delivered: false, disabled: true };
      try {
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

export function validatePushSubscription(value) {
  if (!value || typeof value !== 'object') return false;
  const endpoint = value.endpoint;
  const keys = value.keys;
  if (typeof endpoint !== 'string' || endpoint.length < 16 || endpoint.length > 2048) return false;
  try {
    if (new URL(endpoint).protocol !== 'https:') return false;
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
