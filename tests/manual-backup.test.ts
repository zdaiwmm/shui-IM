import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAvailableBackupSpace, availableBackupSpace } from './fixtures/backup-capacity';
import * as capacity from '../scripts/backup-capacity.mjs';
import { manualBackupRetention, runManualBackup } from '../scripts/backup.mjs';
import { createStore } from '../server/storage.mjs';
import { verifyBackup } from '../server/backup.mjs';

const roots: string[] = [];
beforeEach(() => { useAvailableBackupSpace(); });
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'manual-backup-')); roots.push(root);
  const env = { DATA_DIR: path.join(root, 'data'), BACKUP_DIR: path.join(root, 'backups') };
  const store = await createStore({ dataDir: env.DATA_DIR });
  const actor = crypto.randomUUID(), blob = crypto.randomUUID();
  const { roomId } = store.createRoom({ deviceId: actor, encryptionKey: {}, signingKey: {} }, 'a'.repeat(43));
  store.createBlob(roomId, blob, 1, 17, actor);
  await store.putBlobChunk(roomId, blob, 0, new Uint8Array(17), actor); await store.completeBlob(roomId, blob, actor); store.close();
  const backup = (date: string, args: string[] = []) => runManualBackup({ env, now: new Date(date), args });
  const names = async () => (await readdir(env.BACKUP_DIR)).filter(n => n.startsWith('quiet-room-')).sort();
  return { root, env, backup, names, chunk: path.join(env.DATA_DIR, 'blobs', roomId, blob, '00000000.bin') };
}

it('retains all existing snapshots by default and explicitly reports that policy', async () => {
  const f = await fixture();
  for (const date of ['2026-10-20T12:00:00Z', '2026-10-21T12:00:00Z', '2026-10-22T12:00:00Z', '2026-10-22T15:00:00Z']) {
    const result = await f.backup(date);
    expect(result).toMatchObject({ verified: true, capacityPolicy: 'strict', retention: { mode: 'keep-all', days: null } });
  }
  expect(await f.names()).toHaveLength(4);
});

it('prunes only after a new verified snapshot, retaining two UTC dates and unknown or corrupt points', async () => {
  const f = await fixture();
  const first = await f.backup('2026-10-20T12:00:00Z');
  await writeFile(path.join(first.backupDir, 'quiet-room.sqlite'), 'corrupt fixture');
  await mkdir(path.join(f.env.BACKUP_DIR, 'operator-recovery-point'));
  await f.backup('2026-10-21T12:00:00Z'); await f.backup('2026-10-22T12:00:00Z');
  const result = await f.backup('2026-10-23T12:00:00Z', ['--retain-days', '2']);
  expect(result.retention).toEqual({ mode: 'verified-utc-days', days: 2 });
  expect((await f.names()).map(name => name.slice(11, 21))).toEqual(['2026-10-20', '2026-10-22', '2026-10-23']);
  expect(await readdir(f.env.BACKUP_DIR)).toContain('operator-recovery-point');
  await expect(verifyBackup(first.backupDir)).rejects.toThrow();
  await expect(verifyBackup(result.backupDir)).resolves.toMatchObject({ verified: true });
});

it('preserves old recovery points on either capacity rejection or failed snapshot creation', async () => {
  const f = await fixture(), old = await f.backup('2026-10-20T12:00:00Z');
  const oldNames = await f.names();
  vi.mocked(capacity.checkBackupCapacity).mockImplementation(async (_root, options) => {
    capacity.assertBackupCapacity({ ...availableBackupSpace, bavail: 7 * 1024 ** 3 }, options);
  });
  await expect(f.backup('2026-10-21T12:00:00Z', ['--retain-days', '2'])).rejects.toThrow('BACKUP_CAPACITY_LOW');
  expect(await f.names()).toEqual(oldNames);
  vi.restoreAllMocks(); useAvailableBackupSpace();
  await rm(f.chunk);
  await expect(f.backup('2026-10-21T12:00:00Z', ['--retain-days', '2'])).rejects.toThrow();
  expect(await f.names()).toEqual(oldNames);
  expect((await readdir(f.env.BACKUP_DIR)).some(name => name.includes('.partial-'))).toBe(false);
  await expect(verifyBackup(old.backupDir)).resolves.toMatchObject({ verified: true });
});

it('requires explicit reserve selection on a busy disk and preserves its free-space floor', async () => {
  const f = await fixture(), GiB = 1024 ** 3;
  vi.mocked(capacity.checkBackupCapacity).mockImplementation(async (_root, options) => {
    capacity.assertBackupCapacity({ ...availableBackupSpace, blocks: 512 * GiB, bfree: 24 * GiB, bavail: 24 * GiB }, options);
  });
  await expect(f.backup('2026-10-20T12:00:00Z')).rejects.toThrow('BACKUP_CAPACITY_LOW');
  const result = await runManualBackup({ env: { ...f.env, BACKUP_CAPACITY_POLICY: 'reserve' } });
  expect(result.capacityPolicy).toBe('reserve');
  expect(result.verified).toBe(true);
});

it('rejects invalid retention and unsafe destinations before snapshot work, including the real CLI entry', async () => {
  for (const args of [['--retain-days', '1'], ['--retain-days', '2.5'], ['--retain-days', '-2'], ['--retain-days'], ['--force'], ['--retain-days', '9007199254740992']]) {
    expect(() => manualBackupRetention(args)).toThrow('Usage:');
  }
  const f = await fixture();
  await expect(runManualBackup({ env: { ...f.env, BACKUP_DIR: path.join(f.env.DATA_DIR, 'backup') } })).rejects.toThrow('DATA_DIR');
  expect(await readdir(f.env.DATA_DIR)).not.toContain('backup');
  await expect(runManualBackup({ env: { ...f.env, BACKUP_CAPACITY_POLICY: 'disabled' } })).rejects.toThrow('BACKUP_CAPACITY_POLICY_INVALID');
  const child = spawnSync(process.execPath, ['scripts/backup.mjs', '--retain-days', '1'], { encoding: 'utf8', env: f.env });
  expect(child.status).toBe(1); expect(child.stdout).toBe(''); expect(child.stderr).toContain('Usage:');
  expect(await readFile(path.join(f.env.DATA_DIR, 'quiet-room.sqlite'))).not.toHaveLength(0);
});
