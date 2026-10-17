import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { assertBackupCapacity, backupCapacityPolicy } from '../scripts/backup-capacity.mjs';

const GiB = 1024 ** 3;
const healthy = { bsize: 1, blocks: 40 * GiB, bfree: 16 * GiB, bavail: 14 * GiB, files: 1000, ffree: 900 };

describe('online backup capacity admission', () => {
  it('admits a healthy filesystem and rejects unknown statistics', () => {
    expect(() => assertBackupCapacity(healthy)).not.toThrow();
    expect(() => assertBackupCapacity({ ...healthy, bavail: NaN })).toThrow('BACKUP_CAPACITY_UNKNOWN');
  });
  it('blocks low bytes, high utilization or inode pressure before creating a snapshot', () => {
    for (const stats of [
      { ...healthy, bavail: 7 * GiB },
      { ...healthy, blocks: 100 * GiB, bfree: 16 * GiB, bavail: 14 * GiB },
      { ...healthy, ffree: 100 },
    ]) expect(() => assertBackupCapacity(stats)).toThrow('BACKUP_CAPACITY_LOW');
  });
  it('requires explicit reserve selection while the default still rejects high utilization', () => {
    const occupied = { ...healthy, blocks: 512 * GiB, bfree: 24 * GiB, bavail: 24 * GiB };
    expect(backupCapacityPolicy()).toBe('strict');
    expect(() => assertBackupCapacity(occupied)).toThrow('BACKUP_CAPACITY_LOW');
    expect(() => assertBackupCapacity(occupied, { policy: 'reserve', pendingBytes: GiB })).not.toThrow();
    expect(() => backupCapacityPolicy('disabled')).toThrow('BACKUP_CAPACITY_POLICY_INVALID');
    expect(() => assertBackupCapacity(occupied, { policy: 'disabled' })).toThrow('BACKUP_CAPACITY_POLICY_INVALID');
  });
  it('reserves eight GiB after the pending file and still rejects inode pressure or unknown space', () => {
    const occupied = { ...healthy, blocks: 512 * GiB, bfree: 9 * GiB, bavail: 9 * GiB };
    expect(() => assertBackupCapacity(occupied, { policy: 'reserve', pendingBytes: GiB })).not.toThrow();
    expect(() => assertBackupCapacity(occupied, { policy: 'reserve', pendingBytes: GiB + 1 })).toThrow('BACKUP_CAPACITY_LOW');
    expect(() => assertBackupCapacity({ ...occupied, bavail: 7 * GiB }, { policy: 'reserve' })).toThrow('BACKUP_CAPACITY_LOW');
    expect(() => assertBackupCapacity({ ...occupied, ffree: 100 }, { policy: 'reserve' })).toThrow('BACKUP_CAPACITY_LOW');
    expect(() => assertBackupCapacity({ ...occupied, bavail: NaN }, { policy: 'reserve' })).toThrow('BACKUP_CAPACITY_UNKNOWN');
  });
  it.each([-1, NaN, 0.5, Number.MAX_SAFE_INTEGER])('fails closed for invalid pending byte budget %s', pendingBytes => {
    expect(() => assertBackupCapacity(healthy, { policy: 'reserve', pendingBytes })).toThrow('BACKUP_CAPACITY_CONFIGURATION_INVALID');
  });
  it('rejects an invalid installer policy before accessing any machine deployment configuration', () => {
    const result = spawnSync(process.execPath, ['scripts/install-mac-backup.mjs', '--capacity-policy', 'disabled'], { encoding: 'utf8', env: {} });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('BACKUP_CAPACITY_POLICY_INVALID');
    expect(result.stdout).toBe('');
  });
});
