import { spawn } from 'node:child_process';
import path from 'node:path';
import { receiveBackup } from '../server/backup-transfer.mjs';
import { withBackupLock } from '../server/backup-lock.mjs';
import { pruneDailyBackups } from '../server/backup-retention.mjs';
import { verifyBackup } from '../server/backup.mjs';
import { mkdir, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { loadConfig, validateConfig, assertKeyFiles } from './deploy-config.mjs';

const root = process.env.QUIET_ROOM_MAC_BACKUP_DIR;
let child;
try {
  if (!root || !path.isAbsolute(root)) throw Error('MAC_BACKUP_ROOT_REQUIRED');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root || (await lstat(root)).mode & 0o077) throw Error('BACKUP_DESTINATION_NOT_PRIVATE');
  const config = assertKeyFiles(validateConfig(loadConfig(process.cwd()).config));
  await withBackupLock(root, async () => {
    const marker = path.join(root, '.mac-last-success.json');
    if (process.argv.includes('--scheduled')) {
      const previous = await readFile(marker, 'utf8').then(JSON.parse).catch(() => null);
      const age = Date.now() - Date.parse(previous?.createdAt ?? '');
      if (Number.isFinite(age) && age >= 0 && age < 12 * 60 * 60 * 1000) return;
    }
    child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', config.serverKey,
      `${config.serverUser}@${config.serverHost}`, 'sudo -n /usr/local/sbin/quiet-room-mac-backup'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stderr.resume(); // Never copy production metadata to operator logs.
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    exit.catch(() => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), 60 * 60 * 1000);
    try {
      const result = await receiveBackup({ root, input: child.stdout, output: child.stdin });
      child.stdin.end();
      if (await exit !== 0) throw Error('MAC_BACKUP_REMOTE_RECEIPT_FAILED');
      const temporary = `${marker}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ createdAt: result.createdAt, verifiedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      await rename(temporary, marker);
      await pruneDailyBackups(root, 3, verifyBackup);
      process.stdout.write(`${JSON.stringify({ event: 'mac_backup_verified', ...result })}\n`);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGTERM'); }
  });
} catch { process.stderr.write('MAC_BACKUP_FAILED\n'); process.exitCode = 1; }
