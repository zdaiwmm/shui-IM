import { describe, it, expect } from 'vitest';
import { assertBackupCapacity } from '../scripts/backup-capacity.mjs';

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
});
