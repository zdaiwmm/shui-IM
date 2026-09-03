import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsistentBackup, restoreBackup, verifyBackup } from '../server/backup.mjs';
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

describe('online disaster-recovery backup', () => {
  it('backs up a live WAL database with immutable completed blobs and restores it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'quiet-room-backup-'));
    directories.push(root);
    const dataDir = path.join(root, 'data');
    const backupRoot = path.join(root, 'backups');
    const restoreDir = path.join(root, 'restore');
    const store = await createStore({ dataDir });
    const { roomId } = store.createRoom(bundle(crypto.randomUUID()), 'a'.repeat(43));

    const completeBlobId = crypto.randomUUID();
    const completeBytes = crypto.getRandomValues(new Uint8Array(81));
    store.createBlob(roomId, completeBlobId, 1, completeBytes.length);
    await store.putBlobChunk(roomId, completeBlobId, 0, completeBytes);
    await store.completeBlob(roomId, completeBlobId);

    const incompleteBlobId = crypto.randomUUID();
    store.createBlob(roomId, incompleteBlobId, 2, 100);
    await store.putBlobChunk(roomId, incompleteBlobId, 0, new Uint8Array(50));

    const created = await createConsistentBackup({ dataDir, backupRoot, now: new Date('2026-09-03T12:00:00.000Z') });
    expect(created).toMatchObject({ verified: true, counts: { rooms: 1, blobs: 1 }, blobBytes: 81 });
    await expect(verifyBackup(created.backupDir)).resolves.toMatchObject({ verified: true });

    const restored = await restoreBackup({ backupDir: created.backupDir, targetDataDir: restoreDir });
    expect(restored.targetDataDir).toBe(restoreDir);
    const restoredStore = await createStore({ dataDir: restoreDir });
    expect(restoredStore.roomState(roomId)?.roomId).toBe(roomId);
    expect(restoredStore.blobStatus(roomId, completeBlobId)).toMatchObject({ completed: true, receivedBytes: 81 });
    expect(() => restoredStore.blobStatus(roomId, incompleteBlobId)).toThrow('INVALID_BLOB');
    expect(new Uint8Array(await restoredStore.getBlobChunk(roomId, completeBlobId, 0))).toEqual(completeBytes);
    restoredStore.close();
    store.close();
  });

  it('detects backup tampering before restore', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'quiet-room-backup-tamper-'));
    directories.push(root);
    const dataDir = path.join(root, 'data');
    const backupRoot = path.join(root, 'backups');
    await mkdir(dataDir, { recursive: true });
    const store = await createStore({ dataDir });
    store.createRoom(bundle(crypto.randomUUID()), 'a'.repeat(43));
    const created = await createConsistentBackup({ dataDir, backupRoot });
    const databasePath = path.join(created.backupDir, 'quiet-room.sqlite');
    const bytes = await readFile(databasePath);
    bytes[0] ^= 0xff;
    await writeFile(databasePath, bytes);
    await expect(verifyBackup(created.backupDir)).rejects.toThrow('摘要校验失败');
    store.close();
  });
});
