import path from 'node:path';
import process from 'node:process';
import { verifyBackup } from '../server/backup.mjs';

const backupDir = process.argv[2];
if (!backupDir) {
  process.stderr.write('Usage: npm run backup:verify -- /absolute/path/to/backup\n');
  process.exitCode = 2;
} else {
  verifyBackup(path.resolve(backupDir))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`Backup verification failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
}
