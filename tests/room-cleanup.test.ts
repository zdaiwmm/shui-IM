import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from '../server/storage.mjs';

const io = vi.hoisted(() => ({ failRemove: false, beforeWrite: null as null | (() => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (io.failRemove && String(args[0]).includes(`${path.sep}blobs${path.sep}`)) throw Object.assign(new Error('synthetic removal failure'), { code: 'EACCES' });
      return real.rm(...args);
    },
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      if (String(args[0]).endsWith('.bin')) await io.beforeWrite?.();
      return real.writeFile(...args);
    },
  };
});
afterEach(() => { io.failRemove = false; io.beforeWrite = null; });
const token = 'a'.repeat(43);
const bundle = () => ({ deviceId: crypto.randomUUID(), encryptionKey: { kty: 'EC' }, signingKey: { kty: 'EC' } });
async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'qr-room-cleanup-'));
  const store = await createStore({ dataDir, maxTotalStorageBytes: 64 });
  const owner = bundle(), room = store.createRoom(owner, token), blobId = crypto.randomUUID();
  store.createBlob(room.roomId, blobId, 1, 64, owner.deviceId);
  const file = path.join(dataDir, 'blobs', room.roomId, blobId, '00000000.bin');
  return { dataDir, store, owner, room, blobId, file };
}

for (const entry of ['device', 'orphan', 'administrator']) it(`queues ${entry} deletion atomically and retains its quota until files are removed`, async () => {
  const f = await fixture();
  try {
    await f.store.putBlobChunk(f.room.roomId, f.blobId, 0, Buffer.alloc(64), f.owner.deviceId);
    await f.store.completeBlob(f.room.roomId, f.blobId, f.owner.deviceId);
    if (entry === 'device') f.store.deleteRoom(f.room.roomId, token);
    else if (entry === 'orphan') expect(f.store.cleanupOrphanRooms('2999-01-01T00:00:00.000Z')).toBe(1);
    else f.store.cloudBackups.deleteRoom(f.room.roomId);
    expect(f.store.roomState(f.room.roomId)).toBeNull();
    expect(f.store.cloudBackups.pendingCleanup()).toEqual([f.room.roomId]);
    expect((await stat(f.file)).size).toBe(64);
    const next = bundle(), other = f.store.createRoom(next, token);
    expect(() => f.store.createBlob(other.roomId, crypto.randomUUID(), 1, 64, next.deviceId)).toThrow('STORAGE_QUOTA');
    await Promise.all([f.store.cleanupDeletedRooms(), f.store.cleanupDeletedRooms()]);
    await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.store.cloudBackups.pendingCleanup()).toEqual([]);
    expect(() => f.store.createBlob(other.roomId, crypto.randomUUID(), 1, 64, next.deviceId)).not.toThrow();
  } finally { f.store.close(); await rm(f.dataDir, { recursive: true, force: true }); }
});

it('retains failed cleanup and quota across restart, then retries only the pending cleanup', async () => {
  const f = await fixture(); let current = f.store;
  try {
    await current.putBlobChunk(f.room.roomId, f.blobId, 0, Buffer.alloc(64), f.owner.deviceId);
    current.deleteRoom(f.room.roomId, token);
    io.failRemove = true;
    await expect(current.cleanupDeletedRooms()).rejects.toMatchObject({ code: 'EACCES' });
    current.close();
    current = await createStore({ dataDir: f.dataDir, maxTotalStorageBytes: 64 });
    const next = bundle(), other = current.createRoom(next, token);
    expect(() => current.createBlob(other.roomId, crypto.randomUUID(), 1, 64, next.deviceId)).toThrow('STORAGE_QUOTA');
    expect((await stat(f.file)).size).toBe(64);
    io.failRemove = false;
    await current.cleanupDeletedRooms();
    expect(current.cloudBackups.pendingCleanup()).toEqual([]);
    await expect(stat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => current.createBlob(other.roomId, crypto.randomUUID(), 1, 64, next.deviceId)).not.toThrow();
  } finally { io.failRemove = false; current.close(); await rm(f.dataDir, { recursive: true, force: true }); }
});

it('drains a chunk writer that passed authentication before deletion without leaving a late file', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  try {
    io.beforeWrite = async () => { entered(); await gate; };
    const writing = f.store.putBlobChunk(f.room.roomId, f.blobId, 0, Buffer.alloc(64), f.owner.deviceId);
    const rejected = expect(writing).rejects.toThrow('UNAUTHORIZED');
    await started;
    f.store.deleteRoom(f.room.roomId, token);
    const cleanup = f.store.cleanupDeletedRooms();
    expect(f.store.cloudBackups.pendingCleanup()).toEqual([f.room.roomId]);
    release();
    await rejected; await cleanup;
    await expect(stat(path.join(f.dataDir, 'blobs', f.room.roomId))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.store.cloudBackups.pendingCleanup()).toEqual([]);
  } finally { release(); f.store.close(); await rm(f.dataDir, { recursive: true, force: true }); }
});

it('migrates the old durable cleanup schema without dropping its pending work', async () => {
  const f = await fixture(); let current = f.store;
  try {
    current.close();
    const db = new DatabaseSync(path.join(f.dataDir, 'quiet-room.sqlite'));
    const oldId = crypto.randomUUID();
    db.exec('DROP TABLE pending_room_cleanup; CREATE TABLE pending_room_cleanup(room_id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO pending_room_cleanup VALUES(?)').run(oldId); db.close();
    current = await createStore({ dataDir: f.dataDir });
    expect(current.cloudBackups.pendingCleanup()).toEqual([oldId]);
    await current.cleanupDeletedRooms();
    expect(current.cloudBackups.pendingCleanup()).toEqual([]);
    expect(current.roomState(f.room.roomId)).not.toBeNull();
  } finally { current.close(); await rm(f.dataDir, { recursive: true, force: true }); }
});
