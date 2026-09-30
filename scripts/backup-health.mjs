import path from 'node:path';
import { readBackupState, backupStateHealth } from './backup-state.mjs';

try {
  const result = backupStateHealth(await readBackupState(path.resolve(process.env.BACKUP_DIR ?? './backups')),
    Date.now(), Number(process.env.BACKUP_MAX_AGE_MS ?? 36 * 60 * 60 * 1000));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.healthy ? 0 : 1;
} catch {
  process.stderr.write('BACKUP_HEALTH_CONFIGURATION_INVALID\n'); process.exitCode = 1;
}
