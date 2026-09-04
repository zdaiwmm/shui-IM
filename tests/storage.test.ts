import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('server ciphertext storage', () => {
  it('migrates the previous two-device schema without losing device authentication', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-migration-'));
    directories.push(dataDir);
    const database = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
    database.exec(`
      CREATE TABLE rooms (
        room_id TEXT PRIMARY KEY, access_hash BLOB NOT NULL, next_seq INTEGER NOT NULL DEFAULT 0,
        next_receipt_seq INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
        message_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, sealed_at TEXT,
        mls_welcome TEXT, protocol TEXT NOT NULL DEFAULT 'legacy-v1'
      );
      CREATE TABLE members (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, device_id TEXT NOT NULL,
        role TEXT NOT NULL, encryption_jwk TEXT NOT NULL, signing_jwk TEXT NOT NULL,
        mls_key_package TEXT, join_proof TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(room_id, device_id), UNIQUE(room_id, role)
      );
      CREATE TABLE receipts (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE, receipt_seq INTEGER NOT NULL,
        client_msg_id TEXT NOT NULL, message_seq INTEGER NOT NULL, receiver_id TEXT NOT NULL,
        receipt TEXT NOT NULL, accepted_at TEXT NOT NULL, PRIMARY KEY(room_id, receipt_seq),
        UNIQUE(room_id, client_msg_id)
      );
      CREATE TABLE mls_events (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        event_seq INTEGER NOT NULL, event_id TEXT NOT NULL, sender_device_id TEXT NOT NULL,
        target_device_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('add', 'remove')),
        envelope TEXT NOT NULL, accepted_at TEXT NOT NULL,
        PRIMARY KEY(room_id, event_seq), UNIQUE(room_id, event_id)
      );
    `);
    const roomId = crypto.randomUUID();
    const creatorId = crypto.randomUUID();
    const token = 'z'.repeat(43);
    const createdAt = new Date().toISOString();
    database.prepare('INSERT INTO rooms(room_id, access_hash, created_at, protocol) VALUES (?, ?, ?, ?)')
      .run(roomId, createHash('sha256').update(token).digest(), createdAt, 'legacy-v1');
    database.prepare(`INSERT INTO members(
      room_id, device_id, role, encryption_jwk, signing_jwk, mls_key_package, join_proof, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      roomId,
      creatorId,
      'creator',
      JSON.stringify(bundle(creatorId).encryptionKey),
      JSON.stringify(bundle(creatorId).signingKey),
      null,
      null,
      createdAt,
    );
    database.prepare('INSERT INTO mls_events VALUES (?, 1, ?, ?, ?, ?, ?, ?)')
      .run(roomId, crypto.randomUUID(), creatorId, crypto.randomUUID(), 'add', '{"action":"add"}', createdAt);
    database.close();

    const store = await createStore({ dataDir });
    expect(store.roomState(roomId).members[0]).toMatchObject({
      deviceId: creatorId,
      status: 'active',
      deviceName: '已迁移设备',
      joinSeq: 0,
    });
    expect(store.authenticatedDevice(roomId, token, creatorId)?.deviceId).toBe(creatorId);
    expect(store.roomState(roomId).mlsEvents).toMatchObject([{ eventSeq: 1, event: { action: 'add' } }]);
    const migrated = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
    expect(() => migrated.prepare('INSERT INTO mls_events VALUES (?, 2, ?, ?, ?, ?, ?, ?)')
      .run(roomId, crypto.randomUUID(), creatorId, crypto.randomUUID(), 'replace', '{"action":"replace"}', createdAt)).not.toThrow();
    migrated.close();
    store.close();
  });

  it('authenticates capabilities, seals membership, and assigns idempotent order', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-store-'));
    directories.push(dataDir);
    const store = await createStore({ dataDir });
    const accessToken = 'a'.repeat(43);
    const creatorId = crypto.randomUUID();
    const joinerId = crypto.randomUUID();
    const { roomId } = store.createRoom(bundle(creatorId), accessToken);

    expect(store.authenticate(roomId, accessToken)).toBe(true);
    expect(store.authenticate(roomId, 'b'.repeat(43))).toBe(false);
    expect(store.updateMemberCapabilities(roomId, creatorId, ['image-album-v1', 'image-album-v1'])).toMatchObject({
      capabilities: ['image-album-v1'],
    });
    const state = store.joinRoom(roomId, bundle(joinerId), 'proof');
    expect(state.members).toHaveLength(2);
    const idempotentJoin = store.joinRoom(roomId, bundle(joinerId), 'proof');
    expect(idempotentJoin.members).toHaveLength(2);
    expect(() => store.joinRoom(roomId, bundle(crypto.randomUUID()), 'proof')).toThrow('ROOM_SEALED');

    const firstId = crypto.randomUUID();
    const first = store.insertMessage(roomId, { clientMsgId: firstId, senderId: creatorId, ciphertext: 'opaque-1' });
    const duplicate = store.insertMessage(roomId, { clientMsgId: firstId, senderId: creatorId, ciphertext: 'opaque-1' });
    expect(() => store.insertMessage(roomId, { clientMsgId: firstId, senderId: creatorId, ciphertext: 'tampered' })).toThrow('MESSAGE_CONFLICT');
    const second = store.insertMessage(roomId, { clientMsgId: crypto.randomUUID(), senderId: joinerId, ciphertext: 'opaque-2' });

    expect(first.seq).toBe(1);
    expect(duplicate.seq).toBe(1);
    expect(duplicate.duplicate).toBe(true);
    expect(second.seq).toBe(2);
    expect(store.messagesAfter(roomId, 0).map((message) => message.seq)).toEqual([1, 2]);

    const receipt = {
      v: 1,
      roomId,
      clientMsgId: firstId,
      seq: 1,
      receiverId: joinerId,
      receivedAt: new Date().toISOString(),
      signature: 'opaque-signature',
    };
    const storedReceipt = store.insertReceipt(roomId, receipt);
    const duplicateReceipt = store.insertReceipt(roomId, receipt);
    expect(storedReceipt.receiptSeq).toBe(1);
    expect(duplicateReceipt).toMatchObject({ receiptSeq: 1, duplicate: true });
    expect(store.receiptsAfter(roomId, 0)).toHaveLength(1);
    store.close();
  });

  it('stores and returns only opaque completed image chunks', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-blob-'));
    directories.push(dataDir);
    const store = await createStore({ dataDir });
    const creatorId = crypto.randomUUID();
    const { roomId } = store.createRoom(bundle(creatorId), 'a'.repeat(43));
    const blobId = crypto.randomUUID();
    const chunk0 = crypto.getRandomValues(new Uint8Array(64));
    const chunk1 = crypto.getRandomValues(new Uint8Array(37));
    store.createBlob(roomId, blobId, 2, chunk0.length + chunk1.length, creatorId);
    await store.putBlobChunk(roomId, blobId, 0, chunk0, creatorId);
    expect(store.blobStatus(roomId, blobId)).toMatchObject({
      uploadedIndexes: [0],
      receivedBytes: chunk0.length,
      completed: false,
    });
    store.createBlob(roomId, blobId, 2, chunk0.length + chunk1.length, creatorId);
    await store.putBlobChunk(roomId, blobId, 0, chunk0, creatorId);
    await expect(store.getBlobChunk(roomId, blobId, 0)).rejects.toThrow('INVALID_BLOB');
    await store.putBlobChunk(roomId, blobId, 1, chunk1, creatorId);
    await store.completeBlob(roomId, blobId, creatorId);
    expect(new Uint8Array(await store.getBlobChunk(roomId, blobId, 0))).toEqual(chunk0);
    expect(new Uint8Array(await store.getBlobChunk(roomId, blobId, 1))).toEqual(chunk1);
    await expect(store.healthCheck()).resolves.toMatchObject({ ok: true, database: true, storage: true });
    store.close();
  });

  it('enforces reservations and garbage-collects abandoned encrypted uploads', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-quota-'));
    directories.push(dataDir);
    const store = await createStore({
      dataDir,
      maxBlobBytes: 80,
      maxRoomStorageBytes: 100,
      maxTotalStorageBytes: 100,
      maxIncompleteBlobsPerRoom: 1,
      maxMessagesPerRoom: 1,
    });
    const senderId = crypto.randomUUID();
    const { roomId } = store.createRoom(bundle(senderId), 'a'.repeat(43));
    store.insertMessage(roomId, { clientMsgId: crypto.randomUUID(), senderId, ciphertext: 'opaque' });
    expect(() => store.insertMessage(roomId, {
      clientMsgId: crypto.randomUUID(),
      senderId,
      ciphertext: 'opaque',
    })).toThrow('MESSAGE_QUOTA');
    const blobId = crypto.randomUUID();
    store.createBlob(roomId, blobId, 1, 64, senderId);
    expect(() => store.createBlob(roomId, crypto.randomUUID(), 1, 40, senderId)).toThrow('TOO_MANY_UPLOADS');
    await expect(store.cleanupExpiredBlobs(new Date(Date.now() + 1000).toISOString())).resolves.toBe(1);
    expect(() => store.blobStatus(roomId, blobId)).toThrow('INVALID_BLOB');
    expect(() => store.createBlob(roomId, crypto.randomUUID(), 1, 81, senderId)).toThrow('BLOB_QUOTA');
    store.close();
  });

  it('reclaims unclaimed rooms without touching sealed rooms', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-orphan-'));
    directories.push(dataDir);
    const store = await createStore({ dataDir });
    const creatorId = crypto.randomUUID();
    const accessToken = 'a'.repeat(43);
    const orphan = store.createRoom(bundle(creatorId), accessToken);
    const sealed = store.createRoom(bundle(crypto.randomUUID()), 'b'.repeat(43));
    store.joinRoom(sealed.roomId, bundle(crypto.randomUUID()), 'proof');

    expect(store.cleanupOrphanRooms(new Date(Date.now() + 1_000).toISOString())).toBe(1);
    expect(store.roomState(orphan.roomId)).toBeNull();
    expect(store.roomState(sealed.roomId)?.members).toHaveLength(2);
    expect(() => store.deleteRoom(sealed.roomId, 'b'.repeat(43))).toThrow('ROOM_SEALED');
    store.close();
  });

  it('activates linked devices at an explicit history boundary with their own token', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-devices-'));
    directories.push(dataDir);
    const store = await createStore({ dataDir });
    const creatorId = crypto.randomUUID();
    const joinerId = crypto.randomUUID();
    const linkedId = crypto.randomUUID();
    const creatorToken = 'a'.repeat(43);
    const inviteToken = 'b'.repeat(43);
    const joinerToken = 'c'.repeat(43);
    const linkedToken = 'd'.repeat(43);
    const withMls = (deviceId: string) => ({ ...bundle(deviceId), mlsKeyPackage: 'A'.repeat(64) });
    const { roomId } = store.createRoom(withMls(creatorId), creatorToken, inviteToken, 'Mac', ['mls-multidevice-v1']);
    store.joinRoom(roomId, withMls(joinerId), 'proof', joinerToken, 'iPhone', ['mls-multidevice-v1']);
    const beforeLinkId = crypto.randomUUID();
    store.insertMessage(roomId, { clientMsgId: beforeLinkId, senderId: creatorId, ciphertext: 'before-link' });

    const linkId = crypto.randomUUID();
    const secret = 'e'.repeat(43);
    store.createDeviceLink(roomId, creatorId, linkId, secret, new Date(Date.now() + 60_000).toISOString());
    store.claimDeviceLink(linkId, secret, withMls(linkedId), linkedToken, 'Windows 电脑', ['mls-multidevice-v1']);
    const secondPendingLinkId = crypto.randomUUID();
    const secondPendingSecret = 'f'.repeat(43);
    store.createDeviceLink(roomId, creatorId, secondPendingLinkId, secondPendingSecret, new Date(Date.now() + 60_000).toISOString());
    store.claimDeviceLink(
      secondPendingLinkId,
      secondPendingSecret,
      withMls(crypto.randomUUID()),
      'g'.repeat(43),
      'Tablet',
      ['mls-multidevice-v1'],
    );
    expect(() => store.createDeviceLink(
      roomId,
      creatorId,
      crypto.randomUUID(),
      'h'.repeat(43),
      new Date(Date.now() + 60_000).toISOString(),
    )).toThrow('DEVICE_LIMIT');
    const target = store.roomState(roomId).members.find((member: { deviceId: string }) => member.deviceId === linkedId);
    expect(target.status).toBe('pending');

    store.saveMlsEvent(roomId, {
      v: 1,
      protocol: 'mls-rfc9420',
      roomId,
      eventId: crypto.randomUUID(),
      previousEventSeq: 0,
      action: 'add',
      senderId: creatorId,
      targetId: linkedId,
      target,
      commit: 'opaque-commit',
      welcome: 'opaque-welcome',
      signature: 'opaque-signature',
    });
    const active = store.getMember(roomId, linkedId);
    expect(active).toMatchObject({ status: 'active', joinSeq: 1 });
    expect(store.authenticatedDevice(roomId, linkedToken, linkedId)?.deviceId).toBe(linkedId);

    const afterLinkId = crypto.randomUUID();
    store.insertMessage(roomId, { clientMsgId: afterLinkId, senderId: joinerId, ciphertext: 'after-link' });
    expect(store.messagesAfter(roomId, 0, 500, linkedId).map((message: { seq: number }) => message.seq)).toEqual([2]);
    store.insertReceipt(roomId, {
      v: 1,
      roomId,
      clientMsgId: beforeLinkId,
      seq: 1,
      receiverId: joinerId,
      receivedAt: new Date().toISOString(),
      signature: 'old-message-receipt',
    });
    store.insertReceipt(roomId, {
      v: 1,
      roomId,
      clientMsgId: afterLinkId,
      seq: 2,
      receiverId: creatorId,
      receivedAt: new Date().toISOString(),
      signature: 'new-message-receipt',
    });
    const linkedReceipts = store.receiptsAfter(roomId, 0, 500, linkedId);
    expect(linkedReceipts[0]).toMatchObject({ receiptSeq: 1, skipped: true });
    expect(linkedReceipts[0]).not.toHaveProperty('receipt');
    expect(linkedReceipts[1]).toMatchObject({ receiptSeq: 2, receipt: { clientMsgId: afterLinkId } });

    store.saveMlsEvent(roomId, {
      v: 1,
      protocol: 'mls-rfc9420',
      roomId,
      eventId: crypto.randomUUID(),
      previousEventSeq: 1,
      action: 'remove',
      senderId: creatorId,
      targetId: linkedId,
      commit: 'opaque-remove-commit',
      signature: 'opaque-signature',
    });
    expect(store.getMember(roomId, linkedId)).toMatchObject({ status: 'revoked' });
    expect(store.authenticatedDevice(roomId, linkedToken, linkedId)).toBeNull();
    expect(store.cleanupExpiredDeviceLinks(new Date(Date.now() + 120_000).toISOString())).toBe(1);
    expect(store.roomState(roomId).members.filter((member: { status: string }) => member.status === 'pending')).toHaveLength(0);
    store.close();
  });
});
