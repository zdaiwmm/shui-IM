import { statfs } from 'node:fs/promises';

const GiB = 1024 ** 3;

export function assertBackupCapacity(stats) {
  const fields = ['bsize', 'blocks', 'bfree', 'bavail', 'files', 'ffree'];
  if (fields.some(key => !Number.isFinite(stats[key]) || stats[key] < 0) || stats.bsize === 0 || stats.blocks === 0) {
    throw new Error('BACKUP_CAPACITY_UNKNOWN');
  }
  const available = stats.bavail * stats.bsize;
  const used = stats.blocks - stats.bfree;
  const usedPercent = 100 * used / Math.max(1, used + stats.bavail);
  const inodeUsed = stats.files ? 100 * (stats.files - stats.ffree) / stats.files : 0;
  if (available < 8 * GiB || usedPercent >= 80 || inodeUsed >= 80) {
    throw new Error('BACKUP_CAPACITY_LOW');
  }
}

export async function checkBackupCapacity(directory) {
  assertBackupCapacity(await statfs(directory));
}
