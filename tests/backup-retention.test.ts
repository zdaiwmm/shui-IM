import { mkdtemp, rm, stat, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStore } from '../server/storage.mjs';
import { createConsistentBackup, restoreBackup, verifyBackup } from '../server/backup.mjs';
import { withBackupLock } from '../server/backup-lock.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'qr-retention-')); roots.push(root);
  const dataDir = path.join(root, 'data'), backupRoot = path.join(root, 'backups');
  const store = await createStore({ dataDir }); const deviceId = crypto.randomUUID();
  const key = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: [], ext: true };
  const { roomId } = store.createRoom({ deviceId, encryptionKey: key, signingKey: key }, 'a'.repeat(43));
  const blobId = crypto.randomUUID(); const bytes = new Uint8Array(81).fill(42);
  store.createBlob(roomId, blobId, 1, bytes.length, deviceId);
  await store.putBlobChunk(roomId, blobId, 0, bytes, deviceId); await store.completeBlob(roomId, blobId, deviceId); store.close();
  return { root, dataDir, backupRoot, bytes, chunk: (dir: string) => path.join(dir, 'blobs', roomId, blobId, '00000000.bin'),
    backup: (date: string) => createConsistentBackup({ dataDir, backupRoot, now: new Date(date), retentionDays: 3 }) };
}
it('keeps three distinct UTC dates, reuses only backup inodes, and every retained point restores independently', async () => {
  const f = await fixture(); const a = await f.backup('2026-09-20T12:00:00Z');
  const b = await f.backup('2026-09-21T12:00:00Z');
  expect((await stat(f.chunk(a.backupDir))).ino).toBe((await stat(f.chunk(b.backupDir))).ino);
  expect((await stat(f.chunk(a.backupDir))).ino).not.toBe((await stat(f.chunk(f.dataDir))).ino);
  expect((await stat(path.join(a.backupDir, 'quiet-room.sqlite'))).ino).not.toBe((await stat(path.join(b.backupDir, 'quiet-room.sqlite'))).ino);
  await f.backup('2026-09-22T12:00:00Z'); await f.backup('2026-09-22T15:00:00Z');
  expect((await readdir(f.backupRoot)).filter(n => n.startsWith('quiet-room-')).length).toBe(3);
  await f.backup('2026-09-23T12:00:00Z');
  const names = (await readdir(f.backupRoot)).filter(n => n.startsWith('quiet-room-')).sort();
  expect(names.map(n => n.slice(11, 21))).toEqual(['2026-09-21', '2026-09-22', '2026-09-23']);
  for (const [i, name] of names.entries()) {
    const target = path.join(f.root, `restore-${i}`);
    await restoreBackup({ backupDir: path.join(f.backupRoot, name), targetDataDir: target });
    expect(new Uint8Array(await readFile(f.chunk(target)))).toEqual(f.bytes);
    expect((await stat(f.chunk(target))).ino).not.toBe((await stat(f.chunk(path.join(f.backupRoot, name)))).ino);
  }
});
it('does not reuse corrupted backup chunks and preserves invalid points for investigation', async () => {
  const f = await fixture(); const a = await f.backup('2026-09-20T12:00:00Z');
  await writeFile(f.chunk(a.backupDir), new Uint8Array(81).fill(9));
  const b = await f.backup('2026-09-21T12:00:00Z');
  await expect(verifyBackup(b.backupDir)).resolves.toMatchObject({ verified: true });
  await expect(verifyBackup(a.backupDir)).rejects.toThrow('摘要');
  expect(new Uint8Array(await readFile(f.chunk(f.dataDir)))).toEqual(f.bytes);
  expect((await stat(f.chunk(a.backupDir))).ino).not.toBe((await stat(f.chunk(b.backupDir))).ino);
});
it('removes failed staging, keeps the last valid point, and excludes concurrent writers', async () => {
  const f = await fixture(); const a = await f.backup('2026-09-20T12:00:00Z');
  await withBackupLock(f.backupRoot, async () => {
    await expect(f.backup('2026-09-21T12:00:00Z')).rejects.toThrow('BACKUP_BUSY');
  });
  await rm(f.chunk(f.dataDir));
  await expect(f.backup('2026-09-21T12:00:00Z')).rejects.toThrow();
  expect((await readdir(f.backupRoot)).filter(n => n.includes('.partial-'))).toEqual([]);
  await expect(verifyBackup(a.backupDir)).resolves.toMatchObject({ verified: true });
});
