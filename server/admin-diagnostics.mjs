import { open } from 'node:fs/promises';
import path from 'node:path';
import { backupStateHealth } from '../scripts/backup-state.mjs';
/** Read only an explicitly mounted receipt, never enumerate snapshots or paths. */
export async function adminBackupStatus(file, now = Date.now()) {
    if (!file)
        return { available: false, code: 'NOT_CONNECTED' };
    let handle;
    try {
        handle = await open(file, 'r');
        const info = await handle.stat();
        if (!info.isFile() || info.size > 4096)
            return { available: false, code: 'INVALID_RECEIPT' };
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096)
            return { available: false, code: 'INVALID_RECEIPT' };
        const raw = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        const sampledAt = Date.parse(typeof raw.sampledAt === 'string' ? raw.sampledAt : '');
        if (!Number.isFinite(sampledAt) || sampledAt > now || now - sampledAt > 120000)
            return { available: false, code: 'STALE_STATUS' };
        const timestamp = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
        const state = { lastVerifiedAt: timestamp(raw.lastVerifiedAt), snapshotCreatedAt: timestamp(raw.snapshotCreatedAt), lastAttemptAt: timestamp(raw.lastAttemptAt), lastAttemptSucceeded: raw.lastAttemptSucceeded === true,
            destination: raw.destination === 'mac-pull' ? 'mac-pull' : 'local' };
        const mode = raw.mode ?? 'local', maxAgeMs = raw.maxAgeMs ?? 36 * 60 * 60 * 1000;
        if (!['local', 'mac-pull'].includes(mode) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60000)
            return { available: false, code: 'INVALID_RECEIPT' };
        const health = mode === 'mac-pull' && state.destination !== 'mac-pull' ? { healthy: false, code: 'MAC_BACKUP_RECEIPT_MISSING' } : backupStateHealth(state, now, maxAgeMs);
        return { available: true, mode, maxAgeMs, sampledAt: new Date(sampledAt).toISOString(), ...state, ...health };
    }
    catch {
        return { available: false, code: 'INVALID_RECEIPT' };
    }
    finally {
        await handle?.close();
    }
}
export async function adminReleaseId(staticDir) {
    let handle;
    try {
        handle = await open(path.join(staticDir, 'sw.js'), 'r');
        const buffer = Buffer.alloc(256);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return /^const RELEASE_ID = '([0-9A-Za-z][0-9A-Za-z._-]{0,63})';/.exec(buffer.subarray(0, bytesRead).toString())?.[1] ?? null;
    }
    catch {
        return null;
    }
    finally {
        await handle?.close();
    }
}
