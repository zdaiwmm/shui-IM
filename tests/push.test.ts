import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePushSubscription } from '../server/push.mjs';
import { createStore } from '../server/storage.mjs';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function bundle(deviceId: string) {
  return {
    deviceId,
    encryptionKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: [], ext: true },
    signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: ['verify'], ext: true },
  };
}

describe('privacy-preserving push subscriptions', () => {
  it('accepts only bounded HTTPS Web Push subscriptions', () => {
    const valid = {
      endpoint: 'https://push.example.test/subscription/opaque',
      keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) },
    };
    expect(validatePushSubscription(valid)).toBe(true);
    expect(validatePushSubscription({ ...valid, endpoint: 'http://push.example.test/subscription' })).toBe(false);
    expect(validatePushSubscription({ ...valid, keys: { ...valid.keys, auth: 'not base64+' } })).toBe(false);
  });

  it('stores only one endpoint per enrolled device and excludes the sender', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-push-'));
    directories.push(dataDir);
    const store = await createStore({ dataDir });
    const creatorId = crypto.randomUUID();
    const joinerId = crypto.randomUUID();
    const { roomId } = store.createRoom(bundle(creatorId), 'a'.repeat(43));
    store.joinRoom(roomId, bundle(joinerId), 'proof');
    const subscription = {
      endpoint: 'https://push.example.test/subscription/one',
      keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) },
    };
    store.savePushSubscription(roomId, joinerId, subscription);
    expect(store.pushSubscriptionsForRoom(roomId, creatorId)).toEqual([
      expect.objectContaining({ deviceId: joinerId, endpoint: subscription.endpoint }),
    ]);
    expect(store.pushSubscriptionsForRoom(roomId, joinerId)).toEqual([]);
    expect(() => store.savePushSubscription(roomId, crypto.randomUUID(), subscription)).toThrow('MEMBER_NOT_FOUND');
    expect(store.deletePushSubscription(roomId, joinerId)).toBe(true);
    store.close();
  });
});
