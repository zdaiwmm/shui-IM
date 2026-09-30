import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

/** @param {string} root @returns {Promise<BackupState|null>} */
export async function readBackupState(root) {
  try { return JSON.parse(await readFile(path.join(root, '.backup-state.json'), 'utf8')); }
  catch { return null; }
}

/** @typedef {{lastVerifiedAt?: string, snapshotCreatedAt?: string, lastAttemptAt?: string, lastAttemptSucceeded?: boolean, destination?: string}} BackupState */
/** @param {string} root @param {BackupState} state */
export async function writeBackupState(root, state) {
  const destination = path.join(root, '.backup-state.json');
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

/** @param {BackupState|null} state @param {number} [now] @param {number} [maxAgeMs] */
export function backupStateHealth(state, now = Date.now(), maxAgeMs = 36 * 60 * 60 * 1000) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60_000 || !Number.isFinite(now)) throw new Error('INVALID_BACKUP_CONFIGURATION');
  const verified = Date.parse(typeof state?.lastVerifiedAt === 'string' ? state.lastVerifiedAt : '');
  const snapshot = Date.parse(typeof state?.snapshotCreatedAt === 'string' ? state.snapshotCreatedAt : '');
  if (!Number.isFinite(verified) || !Number.isFinite(snapshot) || snapshot > verified || verified > now || snapshot > now) {
    return { healthy: false, code: 'BACKUP_STATE_INVALID_OR_MISSING' };
  }
  if (now - snapshot > maxAgeMs) return { healthy: false, code: 'BACKUP_STALE' };
  if (state?.lastAttemptSucceeded !== true) return { healthy: false, code: 'BACKUP_LAST_ATTEMPT_FAILED' };
  return { healthy: true, code: 'BACKUP_FRESH', ageMs: now - snapshot };
}
