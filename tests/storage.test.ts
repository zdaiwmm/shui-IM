import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    const state = store.joinRoom(roomId, bundle(joinerId), 'proof');
    expect(state.members).toHaveLength(2);
    const idempotentJoin = store.joinRoom(roomId, bundle(joinerId), 'proof');
    expect(idempotentJoin.members).toHaveLength(2);
    expect(() => store.joinRoom(roomId, bundle(crypto.randomUUID()), 'proof')).toThrow('ROOM_SEALED');

    const firstId = crypto.randomUUID();
    const first = store.insertMessage(roomId, { clientMsgId: firstId, senderId: creatorId, ciphertext: 'opaque-1' });
    const duplicate = store.insertMessage(roomId, { clientMsgId: firstId, senderId: creatorId, ciphertext: 'opaque-1' });
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
    const { roomId } = store.createRoom(bundle(crypto.randomUUID()), 'a'.repeat(43));
    const blobId = crypto.randomUUID();
    const chunk0 = crypto.getRandomValues(new Uint8Array(64));
    const chunk1 = crypto.getRandomValues(new Uint8Array(37));
    store.createBlob(roomId, blobId, 2, chunk0.length + chunk1.length);
    await store.putBlobChunk(roomId, blobId, 0, chunk0);
    expect(store.blobStatus(roomId, blobId)).toMatchObject({
      uploadedIndexes: [0],
      receivedBytes: chunk0.length,
      completed: false,
    });
    store.createBlob(roomId, blobId, 2, chunk0.length + chunk1.length);
    await store.putBlobChunk(roomId, blobId, 0, chunk0);
    await expect(store.getBlobChunk(roomId, blobId, 0)).rejects.toThrow('INVALID_BLOB');
    await store.putBlobChunk(roomId, blobId, 1, chunk1);
    await store.completeBlob(roomId, blobId);
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
    const { roomId } = store.createRoom(bundle(crypto.randomUUID()), 'a'.repeat(43));
    store.insertMessage(roomId, { clientMsgId: crypto.randomUUID(), senderId: crypto.randomUUID(), ciphertext: 'opaque' });
    expect(() => store.insertMessage(roomId, {
      clientMsgId: crypto.randomUUID(),
      senderId: crypto.randomUUID(),
      ciphertext: 'opaque',
    })).toThrow('MESSAGE_QUOTA');
    const blobId = crypto.randomUUID();
    store.createBlob(roomId, blobId, 1, 64);
    expect(() => store.createBlob(roomId, crypto.randomUUID(), 1, 40)).toThrow('TOO_MANY_UPLOADS');
    await expect(store.cleanupExpiredBlobs(new Date(Date.now() + 1000).toISOString())).resolves.toBe(1);
    expect(() => store.blobStatus(roomId, blobId)).toThrow('INVALID_BLOB');
    expect(() => store.createBlob(roomId, crypto.randomUUID(), 1, 81)).toThrow('BLOB_QUOTA');
    store.close();
  });
});
