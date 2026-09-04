import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/storage.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { newRecoveryCode, recoveryFetchToken, sealRecovery, openRecovery, randomBackupSecret, sealJson, openJson } from '../src/lib/backup-crypto';
import type { CloudRecoveryBundle, BackupUpload } from '../src/lib/backup-types';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cloud-backup-test-'));
  const store = await createStore({ dataDir: dir });
  cleanups.push(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const identity = await generateIdentity();
  const token = randomBackupSecret();
  const { roomId } = store.createRoom(identity.publicBundle, token, randomBackupSecret(), 'source', ['recovery-replace-v1']);
  const recovery = newRecoveryCode();
  const archive = { id: randomBackupSecret(), key: randomBackupSecret(), token: randomBackupSecret(), parts: [] };
  const bundle: CloudRecoveryBundle = { v: 1, backupId: recovery.id, roomId, deviceId: identity.publicBundle.deviceId,
    checkpoint: { v: 3, roomId, accessToken: token, role: 'creator', pairingSecret: '', creatorFingerprint: 'fingerprint', identity,
      members: [], lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420' }, archives: [archive] };
  const upload: BackupUpload = { id: recovery.id, revision: 1, fetchToken: await recoveryFetchToken(recovery.code),
    sealed: await sealRecovery(bundle, recovery.code), archives: [{ id: archive.id, token: archive.token, writable: true }] };
  return { dir, store, token, roomId, identity, recovery, archive, bundle, upload };
}

describe('cloud recovery encryption and atomic storage', () => {
  it('separates lookup capability from decryption and authenticates the backup identity', async () => {
    const { recovery, upload, bundle } = await fixture();
    expect(upload.fetchToken).not.toContain(recovery.code.slice(4));
    expect(await openRecovery(upload.sealed, recovery.code)).toEqual(bundle);
    const other = newRecoveryCode();
    await expect(openRecovery(upload.sealed, other.code)).rejects.toThrow();
    await expect(openRecovery({ ...upload.sealed, ciphertext: upload.sealed.ciphertext.slice(1) }, recovery.code)).rejects.toThrow();
    const secret = randomBackupSecret();
    const encrypted = await sealJson({ text: 'history' }, secret, 'archive-one');
    await expect(openJson(encrypted, secret, 'archive-two')).rejects.toThrow();
  });

  it('stores no recovery code or history key, rejects unauthorized writes and handles exact retries', async () => {
    const f = await fixture();
    const first = f.store.cloudBackups.save(f.roomId, f.token, f.upload);
    expect(f.store.cloudBackups.save(f.roomId, f.token, f.upload)).toEqual(first);
    expect(() => f.store.cloudBackups.save(f.roomId, randomBackupSecret(), f.upload)).toThrow('UNAUTHORIZED');
    expect(() => f.store.cloudBackups.save(f.roomId, f.token, { ...f.upload, recoveryCode: f.recovery.code })).toThrow('INVALID_BACKUP');
    expect(() => f.store.cloudBackups.save(f.roomId, f.token, { ...f.upload, revision: 3 })).toThrow('BACKUP_CONFLICT');
    const partId = randomBackupSecret();
    const sealed = await sealJson({ content: 'not plaintext on server' }, f.archive.key, 'part');
    f.store.cloudBackups.putPart(f.roomId, f.token, f.archive.id, partId, sealed);
    expect(f.store.cloudBackups.getPart(f.archive.id, partId, f.archive.token)).toEqual(sealed);
    expect(() => f.store.cloudBackups.getPart(f.archive.id, partId, f.upload.fetchToken)).toThrow('BACKUP_UNAVAILABLE');
    const db = new DatabaseSync(path.join(f.dir, 'quiet-room.sqlite'));
    const rows = JSON.stringify({ b: db.prepare('SELECT * FROM recovery_backups').all(), a: db.prepare('SELECT * FROM history_archives').all(), p: db.prepare('SELECT * FROM history_archive_parts').all() });
    db.close();
    for (const secret of [f.recovery.code, f.archive.key, f.upload.fetchToken, f.archive.token, 'not plaintext on server']) expect(rows).not.toContain(secret);
    expect(f.store.cloudBackups.rooms()).toHaveLength(1);
    expect(f.store.cleanupOrphanRooms(new Date(Date.now() + 86_400_000).toISOString())).toBe(0);
  });

  it('requires a completed replacement and transfers every archive while retiring old online capabilities atomically', async () => {
    const f = await fixture();
    f.store.cloudBackups.save(f.roomId, f.token, f.upload);
    const second = await generateIdentity();
    const secondToken = randomBackupSecret();
    f.store.joinRoom(f.roomId, second.publicBundle, 'proof', secondToken, 'replacement', ['recovery-replace-v1']);
    const next = newRecoveryCode();
    const nextArchive = { id: randomBackupSecret(), token: randomBackupSecret(), writable: true };
    const nextRead = randomBackupSecret();
    const upload = { ...f.upload, id: next.id, fetchToken: await recoveryFetchToken(next.code), replaces: f.recovery.id,
      archives: [{ id: f.archive.id, token: nextRead, writable: false }, nextArchive] };
    expect(() => f.store.cloudBackups.save(f.roomId, secondToken, upload)).toThrow('INVALID_BACKUP_REPLACEMENT');
    const db = new DatabaseSync(path.join(f.dir, 'quiet-room.sqlite'));
    // Model the durable output of the separately tested authenticated MLS replacement.
    db.prepare("INSERT INTO recovery_requests VALUES(?,?,?,?,?,?,?,'completed',?)").run(f.roomId, crypto.randomUUID(), f.identity.publicBundle.deviceId,
      second.publicBundle.deviceId, Buffer.alloc(32), '{}', new Date().toISOString(), new Date().toISOString());
    db.close();
    expect(() => f.store.cloudBackups.save(f.roomId, secondToken, { ...upload, archives: [nextArchive] })).toThrow('BACKUP_ARCHIVE_MISSING');
    expect(f.store.cloudBackups.fetch(f.recovery.id, f.upload.fetchToken).sealed).toEqual(f.upload.sealed);
    const result = f.store.cloudBackups.save(f.roomId, secondToken, upload);
    expect(f.store.cloudBackups.save(f.roomId, secondToken, upload)).toEqual(result);
    expect(() => f.store.cloudBackups.fetch(f.recovery.id, f.upload.fetchToken)).toThrow('BACKUP_UNAVAILABLE');
    expect(() => f.store.cloudBackups.getPart(f.archive.id, randomBackupSecret(), f.archive.token)).toThrow('BACKUP_UNAVAILABLE');
    f.store.cloudBackups.deleteRoom(f.roomId);
    expect(() => f.store.cloudBackups.fetch(next.id, upload.fetchToken)).toThrow('BACKUP_UNAVAILABLE');
    expect(f.store.cloudBackups.rooms()).toHaveLength(0);
    expect(f.store.cloudBackups.pendingCleanup()).toEqual([f.roomId]);
  });
});
