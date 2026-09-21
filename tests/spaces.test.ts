import { describe, it, expect } from 'vitest';
import { newSpaceRecoveryCode, spaceCodeId, spaceCapability, sealSpaceDirectory, openSpaceDirectory } from '../src/lib/spaces';
import { newRecoveryCode } from '../src/lib/backup-crypto';
import { DatabaseSync } from 'node:sqlite';
import { createSpaceDirectories } from '../server/space-directories.mjs';

describe('encrypted space directory', () => {
  it('separates capabilities, authenticates the collection and leaves codes encrypted', async () => {
    const code = newSpaceRecoveryCode(), other = newSpaceRecoveryCode();
    expect(spaceCodeId(code)).toHaveLength(22);
    const capabilities = await Promise.all(['fetch','write','encryption'].map(p => spaceCapability(code, p as 'fetch')));
    expect(new Set(capabilities).size).toBe(3);
    const spaces = [{ roomId: crypto.randomUUID(), name: '仅本机名称', code: newRecoveryCode().code }];
    const sealed = await sealSpaceDirectory(code, spaces);
    expect(JSON.stringify(sealed)).not.toContain(spaces[0].code);
    expect(await openSpaceDirectory(code, sealed)).toEqual(spaces);
    await expect(openSpaceDirectory(other, sealed)).rejects.toThrow();
    await expect(openSpaceDirectory(code, { ...sealed, iv: sealed.iv.split('').reverse().join('') })).rejects.toThrow();
    await expect(sealSpaceDirectory(code, [...spaces, ...spaces])).rejects.toThrow();
  });
  it('rejects malformed and oversized catalog content', async () => {
    expect(() => spaceCodeId('QR3-' + 'a'.repeat(64))).toThrow();
    await expect(sealSpaceDirectory(newSpaceRecoveryCode(), [{ roomId: crypto.randomUUID(), name: 'x'.repeat(41) }])).rejects.toThrow();
  });
});

describe('opaque server directory', () => {
  it('requires an active device and write capability, preserves CAS and idempotence', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const store = createSpaceDirectories(db, { authenticatedDevice: (room: string, token: string) => room === 'room' && token === 'device' ? { deviceId: 'd' } : null });
      const code = newSpaceRecoveryCode(), id = spaceCodeId(code);
      const value = { roomId: 'room', revision: 1, fetchToken: await spaceCapability(code, 'fetch'), writeToken: await spaceCapability(code, 'write'), sealed: await sealSpaceDirectory(code, []) };
      expect(() => store.save(id, 'wrong', value)).toThrow('UNAUTHORIZED');
      expect(store.save(id, 'device', value)).toEqual({ revision: 1 });
      expect(store.save(id, 'device', value)).toEqual({ revision: 1 });
      expect(store.fetch(id, value.fetchToken).sealed).toEqual(value.sealed);
      expect(() => store.fetch(id, value.writeToken)).toThrow('BACKUP_UNAVAILABLE');
      expect(() => store.save(id, 'device', { ...value, revision: 2, writeToken: value.fetchToken })).toThrow('UNAUTHORIZED');
      expect(() => store.save(id, 'device', { ...value, revision: 3 })).toThrow('BACKUP_CONFLICT');
      expect(store.save(id, 'device', { ...value, revision: 2 })).toEqual({ revision: 2 });
      expect(db.prepare('SELECT sealed, fetch_hash, write_hash FROM space_directories').get().sealed).not.toContain(code);
    } finally { db.close(); }
  });
});
