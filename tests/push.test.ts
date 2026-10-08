import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
      endpoint: 'https://fcm.googleapis.com/subscription/opaque',
      keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) },
    };
    expect(validatePushSubscription(valid)).toBe(true);
    expect(validatePushSubscription({ ...valid, endpoint: 'http://push.example.test/subscription' })).toBe(false);
    expect(validatePushSubscription({ ...valid, endpoint: 'https://127.0.0.1/subscription' })).toBe(false);
    expect(validatePushSubscription({ ...valid, endpoint: 'https://192.0.2.1/subscription' })).toBe(false);
    expect(validatePushSubscription({ ...valid, endpoint: 'https://[::1]/subscription' })).toBe(false);
    expect(validatePushSubscription({ ...valid, endpoint: 'https://evil.example/subscription' })).toBe(false);
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
      endpoint: 'https://fcm.googleapis.com/subscription/one',
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


describe('shared browser endpoint ownership and upgrade', () => {
  it('migrates existing subscriptions without losing rows and isolates room opt-out', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-push-upgrade-')); directories.push(dataDir);
    let store = await createStore({ dataDir });
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const roomA = store.createRoom(bundle(a), 'a'.repeat(43)).roomId, roomB = store.createRoom(bundle(b), 'b'.repeat(43)).roomId;
    const subscription = { endpoint: 'https://fcm.googleapis.com/shared', keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) } };
    store.savePushSubscription(roomA, a, subscription); store.close();
    const db = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE push_subscriptions RENAME TO original_push;
      CREATE TABLE push_subscriptions (room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, device_id TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(room_id, device_id), UNIQUE(endpoint), FOREIGN KEY(room_id, device_id) REFERENCES members(room_id, device_id) ON DELETE CASCADE);
      INSERT INTO push_subscriptions SELECT * FROM original_push;
      DROP TABLE original_push; COMMIT;`);
    db.close();
    store = await createStore({ dataDir });
    expect(store.pushSubscriptionStatus(roomA, a)).toEqual({ endpoint: subscription.endpoint });
    store.savePushSubscription(roomB, b, subscription);
    expect(store.pushSubscriptionStatus(roomB, b)).toEqual({ endpoint: subscription.endpoint });
    store.deletePushSubscription(roomA, a);
    expect(store.pushSubscriptionsForRoom(roomA, '')).toEqual([]);
    expect(store.pushSubscriptionsForRoom(roomB, '')).toHaveLength(1);
    expect(store.deletePushSubscriptionByEndpoint(subscription.endpoint)).toBe(true);
    store.close();
    // Reopening is idempotent and preserves foreign-key integrity.
    store = await createStore({ dataDir }); expect(store.pushSubscriptionStatus(roomB, b)).toEqual({ endpoint: null }); store.close();
    const reopened = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
    expect(reopened.prepare('PRAGMA foreign_key_check').all()).toEqual([]); reopened.close();
  });
});
