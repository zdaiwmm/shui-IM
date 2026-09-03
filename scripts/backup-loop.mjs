import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createConsistentBackup } from '../server/backup.mjs';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const backupRoot = path.resolve(process.env.BACKUP_DIR ?? './backups');
const intervalMs = Math.max(60_000, Number(process.env.BACKUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000));
const retentionCount = Math.max(2, Math.floor(Number(process.env.BACKUP_RETENTION_COUNT ?? 14)));

async function pruneVerifiedBackups() {
  const candidates = [];
  for (const name of await readdir(backupRoot).catch(() => [])) {
    if (!/^quiet-room-\d{4}-\d{2}-\d{2}T/.test(name)) continue;
    const target = path.join(backupRoot, name);
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory()) candidates.push({ name, target });
  }
  candidates.sort((left, right) => right.name.localeCompare(left.name));
  for (const candidate of candidates.slice(retentionCount)) {
    await rm(candidate.target, { recursive: true });
    process.stdout.write(`Pruned expired backup ${candidate.name}\n`);
  }
}

async function runOnce() {
  const result = await createConsistentBackup({ dataDir, backupRoot });
  process.stdout.write(`${JSON.stringify({ event: 'backup_verified', ...result })}\n`);
  await pruneVerifiedBackups();
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
