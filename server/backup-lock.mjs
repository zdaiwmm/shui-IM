import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

/** Linux kernel lock survives container namespaces and releases on process exit. */
export async function withBackupLock(root, operation) {
  if (process.platform === 'linux') {
    const child = spawn('flock', ['-n', path.join(root, '.backup.flock'), 'sh', '-c', 'printf READY; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // Early lock rejection may close stdin before cleanup.
    const exited = new Promise(resolve => child.once('close', resolve));
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error('BACKUP_BUSY_OR_LOCK_UNAVAILABLE')));
        let ready = '';
        child.stdout.on('data', bytes => { ready += bytes.toString(); if (ready === 'READY') resolve(); else if (!'READY'.startsWith(ready)) reject(new Error('BACKUP_LOCK_INVALID')); });
      });
      return await operation();
    } finally { child.stdin.end(); await exited; }
  }
  // Development fallback is fail-closed after an interrupted process; never steal a lock.
  const lock = path.join(root, '.backup.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('BACKUP_BUSY_OR_INTERRUPTED');
    throw error;
  }
  try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
}
