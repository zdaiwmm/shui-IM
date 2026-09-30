import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sendBackup } from '../server/backup-transfer.mjs';
import { withBackupLock } from '../server/backup-lock.mjs';
import { readBackupState, writeBackupState } from './backup-state.mjs';

const root = path.resolve(process.env.BACKUP_DIR ?? './backups');
const deadline = setTimeout(() => process.exit(1), 60 * 60 * 1000);
let temporary;
try {
  if (process.env.BACKUP_MODE !== 'mac-pull') throw Error('BACKUP_MODE_NOT_MAC_PULL');
  await mkdir(root, { recursive: true });
  await withBackupLock(root, async () => {
    const previous = await readBackupState(root);
    await writeBackupState(root, { lastVerifiedAt: previous?.lastVerifiedAt, snapshotCreatedAt: previous?.snapshotCreatedAt,
      lastAttemptAt: new Date().toISOString(), lastAttemptSucceeded: false });
    const ownedTemporary = path.join(tmpdir(), 'quiet-room-mac-export');
    await rm(ownedTemporary, { recursive: true, force: true });
    await mkdir(ownedTemporary, { mode: 0o700 });
    temporary = await mkdtemp(path.join(ownedTemporary, 'snapshot-'));
    try {
      const state = await sendBackup({ dataDir: path.resolve(process.env.DATA_DIR ?? './data'), temporaryRoot: temporary,
        output: process.stdout, input: process.stdin });
      await writeBackupState(root, state);
      // The caller requires SSH exit success in addition to its own verification.
    } catch (error) {
      const previous = await readBackupState(root);
      await writeBackupState(root, { lastVerifiedAt: previous?.lastVerifiedAt, snapshotCreatedAt: previous?.snapshotCreatedAt,
        lastAttemptAt: new Date().toISOString(), lastAttemptSucceeded: false });
      throw error;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
} catch { process.stderr.write('MAC_BACKUP_EXPORT_FAILED\n'); process.exitCode = 1; }
finally { clearTimeout(deadline); }
