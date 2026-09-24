import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkBackupCapacity } from './backup-capacity.mjs';
import { createConsistentBackup } from '../server/backup.mjs';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const backupRoot = path.resolve(process.env.BACKUP_DIR ?? './backups');
const intervalMs = Math.max(60_000, Number(process.env.BACKUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000));
const retentionCount = Math.max(2, Math.floor(Number(process.env.BACKUP_RETENTION_COUNT ?? 3)));

if (!Number.isSafeInteger(intervalMs) || !Number.isSafeInteger(retentionCount)) throw new Error('INVALID_BACKUP_CONFIGURATION');

async function runOnce() {
  await mkdir(backupRoot, { recursive: true });
  await checkBackupCapacity(backupRoot);
  const result = await createConsistentBackup({ dataDir, backupRoot, retentionDays: retentionCount });
  process.stdout.write(`${JSON.stringify({ event: 'backup_verified', ...result })}\n`);
}

let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

while (!stopping) {
  let nextDelay = intervalMs;
  try {
    await runOnce();
  } catch (error) {
    process.stderr.write(`Backup cycle failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    nextDelay = Math.min(intervalMs, 5 * 60 * 1000);
  }
  const nextRunAt = Date.now() + nextDelay;
  while (!stopping && Date.now() < nextRunAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, nextRunAt - Date.now())));
  }
}
