import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkBackupCapacity } from './backup-capacity.mjs';
import { createConsistentBackup } from '../server/backup.mjs';
import { readBackupState, writeBackupState } from './backup-state.mjs';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const backupRoot = path.resolve(process.env.BACKUP_DIR ?? './backups');
const intervalMs = Math.max(60_000, Number(process.env.BACKUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000));
const retentionCount = Math.max(2, Math.floor(Number(process.env.BACKUP_RETENTION_COUNT ?? 3)));

if (!Number.isSafeInteger(intervalMs) || !Number.isSafeInteger(retentionCount)) throw new Error('INVALID_BACKUP_CONFIGURATION');

async function runOnce() {
  await mkdir(backupRoot, { recursive: true });
  await checkBackupCapacity(backupRoot);
  const result = await createConsistentBackup({ dataDir, backupRoot, retentionDays: retentionCount });
  await writeBackupState(backupRoot, { lastVerifiedAt: new Date().toISOString(), snapshotCreatedAt: result.createdAt,
    lastAttemptAt: new Date().toISOString(), lastAttemptSucceeded: true });
  process.stdout.write(`${JSON.stringify({ event: 'backup_verified', ...result })}\n`);
}

let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

const mode = process.env.BACKUP_MODE ?? 'local';
if (!['local', 'mac-pull'].includes(mode)) throw new Error('INVALID_BACKUP_CONFIGURATION');

while (!stopping) {
  if (mode === 'mac-pull') {
    await new Promise(resolve => setTimeout(resolve, 1000));
    continue;
  }
  let nextDelay = intervalMs;
  const startedAt = Date.now();
  let succeeded = false;
  try {
    await runOnce();
    succeeded = true;
  } catch (error) {
    process.stderr.write(`Backup cycle failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    nextDelay = Math.min(intervalMs, 5 * 60 * 1000);
    try {
      const previous = await readBackupState(backupRoot);
      await writeBackupState(backupRoot, { lastVerifiedAt: previous?.lastVerifiedAt, snapshotCreatedAt: previous?.snapshotCreatedAt,
        lastAttemptAt: new Date().toISOString(), lastAttemptSucceeded: false });
    } catch { process.stderr.write('Backup failure state could not be written\n'); }
  }
  const nextRunAt = succeeded ? Math.max(Date.now(), startedAt + nextDelay) : Date.now() + nextDelay;
  while (!stopping && Date.now() < nextRunAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, nextRunAt - Date.now())));
  }
}
