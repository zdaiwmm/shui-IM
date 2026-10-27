import path from 'node:path';
import process from 'node:process';
import { mkdir } from 'node:fs/promises';
import { createConsistentBackup } from '../server/backup.mjs';
import { backupCapacityPolicy, checkBackupCapacity } from './backup-capacity.mjs';
import { isMainModule } from './release-runtime.mjs';

export function manualBackupRetention(args) {
  if (!args.length) return undefined;
  if (args.length !== 2 || args[0] !== '--retain-days' || !/^[1-9]\d*$/.test(args[1]) ||
      !Number.isSafeInteger(Number(args[1])) || Number(args[1]) < 2) {
    throw new Error('Usage: backup:create [--retain-days <distinct UTC dates, minimum 2>]');
  }
  return Number(args[1]);
}

export async function runManualBackup({ args = [], env = process.env, now = new Date() } = {}) {
  const retentionDays = manualBackupRetention(args);
  const policy = backupCapacityPolicy(env.BACKUP_CAPACITY_POLICY);
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  const backupRoot = path.resolve(env.BACKUP_DIR ?? './backups');
  if (backupRoot === dataDir || backupRoot.startsWith(`${dataDir}${path.sep}`)) throw new Error('备份目录不能放在 DATA_DIR 内部');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await checkBackupCapacity(backupRoot, { policy });
  const result = await createConsistentBackup({ dataDir, backupRoot, now, retentionDays });
  return { ...result, capacityPolicy: policy,
    retention: { mode: retentionDays === undefined ? 'keep-all' : 'verified-utc-days', days: retentionDays ?? null } };
}

if (isMainModule(import.meta.url)) {
  runManualBackup({ args: process.argv.slice(2) }).then(result => {
    if (result.retention.mode === 'keep-all') process.stderr.write('Manual backup retains all snapshots; use --retain-days N for explicit verified daily retention.\n');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`Backup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
