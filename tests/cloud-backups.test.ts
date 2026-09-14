import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/storage.mjs';
import { generateIdentity } from '../src/lib/crypto';
import { newRecoveryCode, recoveryFetchToken, sealRecovery, openRecovery, randomBackupSecret, sealJson, openJson } from '../src/lib/backup-crypto';
import { BACKUP_REQUEST_TIMEOUT_MS, fetchRecoveryBundle, normalizeRecoveryCodes } from '../src/lib/cloud-backup';
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
  it('normalizes one or more device recovery codes for session-wide restore', () => {
    const first = newRecoveryCode();
    const second = newRecoveryCode();
    expect(normalizeRecoveryCodes(`\n${first.code}\n${second.code}\n${first.code}\n`)).toEqual([first.code, second.code]);
    expect(() => normalizeRecoveryCodes('')).toThrow('请输入至少一个恢复码');
    expect(() => normalizeRecoveryCodes('QR3-invalid')).toThrow('恢复码格式不正确');
    expect(() => normalizeRecoveryCodes(Array.from({ length: 7 }, () => newRecoveryCode().code))).toThrow('最多支持 6 个');
  });

  it('terminates a stalled fetch and clears its deadline', async () => {
    const code = newRecoveryCode().code;
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    try {
      const result = fetchRecoveryBundle(code, new AbortController().signal);
      const rejected = expect(result).rejects.toThrow('备份请求超时');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(BACKUP_REQUEST_TIMEOUT_MS);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); fetchMock.mockRestore(); }
  });

  it('waits for a rate-limit response and retries the same recovery request', async () => {
    const f = await fixture();
    let attempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) return new Response(JSON.stringify({ code: 'RATE_LIMITED' }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
      });
      return new Response(JSON.stringify({ revision: 1, sealed: f.upload.sealed }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      await expect(fetchRecoveryBundle(f.recovery.code, new AbortController().signal)).resolves.toEqual(f.bundle);
      expect(attempts).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('honors the server cooldown and cancellation without another request', async () => {
    const recovery = newRecoveryCode();
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      status: 429, headers: { 'Retry-After': '60' },
    }));
    vi.useFakeTimers();
    try {
      const pending = fetchRecoveryBundle(recovery.code, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(59_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      controller.abort();
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      vi.useRealTimers();
      fetchMock.mockRestore();
    }
  });

  it('stops persistent throttling after a bounded retry budget', async () => {
    const recovery = newRecoveryCode();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', {
      status: 429, headers: { 'Retry-After': '0' },
    }));
    try {
      await expect(fetchRecoveryBundle(recovery.code, new AbortController().signal)).rejects.toThrow('备份请求过于频繁');
      expect(fetchMock).toHaveBeenCalledTimes(13);
      const calls = fetchMock.mock.calls;
      for (const [url, options] of calls) {
        expect(url).toEqual(calls[0]![0]);
        expect({ ...options, signal: undefined }).toEqual({ ...calls[0]![1], signal: undefined });
        expect(options?.signal?.aborted).toBe(false);
      }
    } finally { fetchMock.mockRestore(); }
  });

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

  it('accepts only creator deletion projections in the optional encrypted snapshot', async () => {
    const { bundle, recovery } = await fixture();
    const hidden = { v: 1 as const, category: 'images' as const, clientMsgId: crypto.randomUUID(), assetIndex: 0, hidden: true, pinnedAt: null };
    const withHidden = { ...bundle, galleryHidden: [hidden] };
    await expect(openRecovery(await sealRecovery(withHidden, recovery.code), recovery.code)).resolves.toEqual(withHidden);
    for (const invalid of [
      { ...withHidden, checkpoint: { ...bundle.checkpoint, historyRestoreTask: { v: 1 as const, id: crypto.randomUUID(), codes: [recovery.code], createdAt: new Date().toISOString() } } },
      { ...withHidden, checkpoint: { ...bundle.checkpoint, role: 'joiner' as const } },
      { ...withHidden, galleryHidden: [{ ...hidden, hidden: false }] },
      { ...withHidden, galleryHidden: [{ ...hidden, pinnedAt: 1 }] },
    ]) await expect(openRecovery(await sealRecovery(invalid, recovery.code), recovery.code)).rejects.toThrow();
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

  it('reads bounded authenticated batches without allowing another capability or archive', async () => {
    const f = await fixture(); f.store.cloudBackups.save(f.roomId, f.token, f.upload);
    const ids = Array.from({ length: 20 }, randomBackupSecret);
    const sealed = { iv: 'a'.repeat(16), ciphertext: 'b'.repeat(30) };
    for (const id of ids) f.store.cloudBackups.putPart(f.roomId, f.token, f.archive.id, id, sealed);
    expect(f.store.cloudBackups.getParts(f.archive.id, ids, f.archive.token).parts).toEqual(ids.map(id => ({ id, sealed })));
    for (const invalid of [[], [...ids, randomBackupSecret()], [ids[0], ids[0]], ['invalid']]) {
      expect(() => f.store.cloudBackups.getParts(f.archive.id, invalid, f.archive.token)).toThrow('INVALID_BACKUP');
    }
    expect(() => f.store.cloudBackups.getParts(f.archive.id, ids, f.upload.fetchToken)).toThrow('BACKUP_UNAVAILABLE');
    expect(() => f.store.cloudBackups.getParts(randomBackupSecret(), ids, f.archive.token)).toThrow('BACKUP_UNAVAILABLE');
    expect(() => f.store.cloudBackups.getParts(f.archive.id, [randomBackupSecret()], f.archive.token)).toThrow('BACKUP_UNAVAILABLE');
    const bigIds = Array.from({ length: 3 }, randomBackupSecret);
    for (const id of bigIds) f.store.cloudBackups.putPart(f.roomId, f.token, f.archive.id, id, { ...sealed, ciphertext: 'c'.repeat(1_700_000) });
    const result = f.store.cloudBackups.getParts(f.archive.id, bigIds, f.archive.token);
    expect(result.parts.map(part => part.id)).toEqual(bigIds.slice(0, 2));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(f.store.cloudBackups.getParts(f.archive.id, bigIds.slice(2), f.archive.token).parts).toHaveLength(1);
    const db = new DatabaseSync(path.join(f.dir, 'quiet-room.sqlite'));
    db.prepare("UPDATE members SET status='revoked' WHERE device_id=?").run(f.identity.publicBundle.deviceId); db.close();
    expect(() => f.store.cloudBackups.getParts(f.archive.id, ids, f.archive.token)).toThrow('BACKUP_UNAVAILABLE');
  });
});
