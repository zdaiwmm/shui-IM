import path from 'node:path';
import process from 'node:process';
import { restoreBackup } from '../server/backup.mjs';

const [backupDir, targetDataDir] = process.argv.slice(2);
if (!backupDir || !targetDataDir) {
  process.stderr.write('Usage: npm run backup:restore -- /absolute/path/to/backup /absolute/empty/target\n');
  process.exitCode = 2;
} else {
  restoreBackup({ backupDir: path.resolve(backupDir), targetDataDir: path.resolve(targetDataDir) })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`Restore failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      process.exitCode = 1;
    });
}
