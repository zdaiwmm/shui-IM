import { mkdir, open, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
/** Separate status-only volume; never copy backup paths, files or raw state. */
export async function publishBackupAdminStatus(backupRoot, statusRoot, now = Date.now()) {
    if (!statusRoot)
        return;
    let handle, raw = {};
    try {
        handle = await open(path.join(backupRoot, '.backup-state.json'), 'r');
        const info = await handle.stat();
        if (!info.isFile() || info.size > 4096)
            throw new Error('INVALID_RECEIPT');
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096)
            throw new Error('INVALID_RECEIPT');
        raw = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    }
    catch {
        raw = {};
    }
    finally {
        await handle?.close();
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        raw = {};
    const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const state = { sampledAt: new Date(now).toISOString(), lastVerifiedAt: timestamp(raw.lastVerifiedAt), snapshotCreatedAt: timestamp(raw.snapshotCreatedAt), lastAttemptAt: timestamp(raw.lastAttemptAt), lastAttemptSucceeded: raw.lastAttemptSucceeded === true, destination: raw.destination === 'mac-pull' ? 'mac-pull' : 'local' };
    await mkdir(statusRoot, { recursive: true, mode: 0o700 });
    const temporary = path.join(statusRoot, `.backup-${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 });
    await rename(temporary, path.join(statusRoot, 'backup.json'));
}
