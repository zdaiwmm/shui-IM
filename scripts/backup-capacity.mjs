import { statfs } from 'node:fs/promises';

const GiB = 1024 ** 3;

export function backupCapacityPolicy(value = 'strict') {
  if (!['strict', 'reserve'].includes(value)) throw new Error('BACKUP_CAPACITY_POLICY_INVALID');
  return value;
}

export function assertBackupCapacity(stats, { policy = 'strict', pendingBytes = 0 } = {}) {
  backupCapacityPolicy(policy);
  if (!Number.isSafeInteger(pendingBytes) || pendingBytes < 0 || !Number.isSafeInteger(8 * GiB + pendingBytes)) {
    throw new Error('BACKUP_CAPACITY_CONFIGURATION_INVALID');
  }
  const fields = ['bsize', 'blocks', 'bfree', 'bavail', 'files', 'ffree'];
  if (fields.some(key => !Number.isFinite(stats[key]) || stats[key] < 0) || stats.bsize === 0 || stats.blocks === 0 ||
      stats.bfree > stats.blocks || stats.bavail > stats.bfree || stats.ffree > stats.files) {
    throw new Error('BACKUP_CAPACITY_UNKNOWN');
  }
  const available = stats.bavail * stats.bsize;
  if (!Number.isFinite(available)) throw new Error('BACKUP_CAPACITY_UNKNOWN');
  const used = stats.blocks - stats.bfree;
  const usedPercent = 100 * used / Math.max(1, used + stats.bavail);
  const inodeUsed = stats.files ? 100 * (stats.files - stats.ffree) / stats.files : 0;
  if (available < 8 * GiB + pendingBytes || (policy === 'strict' && usedPercent >= 80) || inodeUsed >= 80) {
    throw new Error('BACKUP_CAPACITY_LOW');
  }
}

export async function checkBackupCapacity(directory, options) {
  assertBackupCapacity(await statfs(directory), options);
}
