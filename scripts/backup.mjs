import path from 'node:path';
import process from 'node:process';
import { createConsistentBackup } from '../server/backup.mjs';

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const backupRoot = path.resolve(process.env.BACKUP_DIR ?? './backups');

createConsistentBackup({ dataDir, backupRoot })
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    process.stderr.write(`Backup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
