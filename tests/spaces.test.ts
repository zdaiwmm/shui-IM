import { describe, it, expect, vi } from 'vitest';
import { newSpaceRecoveryCode, spaceCodeId, spaceCapability, sealSpaceDirectory, openSpaceDirectory, recoveryDirectoryEntries, spaceMessagePreview, refreshSpaceUnread, type PrivateSpace } from '../src/lib/spaces';
import type { MessagePayload } from '../src/lib/types';
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


describe('local-only space summaries', () => {
  it('keeps previews and observer capabilities encrypted locally and strips every entry for recovery', async () => {
    const code = newSpaceRecoveryCode();
    const spaces: PrivateSpace[] = [1,2].map(i => ({ roomId: crypto.randomUUID(), name: `空间 ${i}`, localId: crypto.randomUUID(), code: newRecoveryCode().code,
      preview: '只保留在本机的消息', previewDeviceId: crypto.randomUUID(), observer: { deviceId: crypto.randomUUID(), token: 'o'.repeat(43), count: 4 }, unread: 4 }));
    const sealed = await sealSpaceDirectory(code, spaces);
    expect(JSON.stringify(sealed)).not.toContain(spaces[0]!.preview);
    expect(JSON.stringify(sealed)).not.toContain(spaces[0]!.observer!.token);
    expect(await openSpaceDirectory(code, sealed)).toEqual(spaces);
    expect(recoveryDirectoryEntries(spaces)).toEqual(spaces.map(({roomId,name,code}) => ({roomId,name,code})));
    await expect(sealSpaceDirectory(code, [{...spaces[0]!, preview: 'x'.repeat(161)}])).rejects.toThrow();
    await expect(sealSpaceDirectory(code, [{...spaces[0]!, observer: {...spaces[0]!.observer!, count: -1}}])).rejects.toThrow();
  });
  it('uses labels for media and never previews control or gallery payloads', () => {
    const preview = (payload: object) => spaceMessagePreview(payload as MessagePayload);
    expect(preview({kind:'text',text:'a\n  b'})).toBe('a b');
    expect(preview({kind:'text',text:'x'.repeat(4000)})).toHaveLength(160);
    expect(preview({kind:'image',image:{sha256:'unknown'}})).toBe('[图片]');
    expect(preview({kind:'image',presentation:'expression-hidden',image:{sha256:'unknown'}})).toBe('[表情]');
    expect(preview({kind:'file',file:{mimeType:'video/mp4',originalName:'x'}})).toBe('[视频]');
    expect(preview({kind:'file',file:{mimeType:'application/pdf',originalName:'x.mp4'}})).toBe('[文件]');
    for (const kind of ['gallery-file','gallery-image','reaction','message-read','media-read','message-delete']) expect(preview({kind})).toBeUndefined();
  });
  it('only GETs a number, retains it offline, drops revoked observers and ignores late results after close', async () => {
    const space: PrivateSpace = { roomId:crypto.randomUUID(), name:'本机', observer:{deviceId:crypto.randomUUID(),token:'o'.repeat(43),count:3}, unread:3 };
    const request = vi.fn().mockResolvedValue({ok:true,json:async()=>({count:8})});
    vi.stubGlobal('fetch',request);
    try {
      await refreshSpaceUnread([space],new AbortController().signal);
      expect(space.unread).toBe(8);
      const options = request.mock.calls[0]![1];
      expect(options.headers.Authorization).toBe('Bearer '+'o'.repeat(43));
      expect(options.method).toBeUndefined(); expect(options.body).toBeUndefined();
      request.mockRejectedValueOnce(new TypeError('offline'));
      await refreshSpaceUnread([space],new AbortController().signal); expect(space.unread).toBe(8);
      const abort = new AbortController();
      request.mockImplementationOnce(async()=>{abort.abort();return {ok:true,json:async()=>({count:99})};});
      await refreshSpaceUnread([space],abort.signal); expect(space.unread).toBe(8);
      request.mockResolvedValueOnce({ok:false,status:401});
      await refreshSpaceUnread([space],new AbortController().signal);
      expect(space.unread).toBeUndefined(); expect(space.observer).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
});
