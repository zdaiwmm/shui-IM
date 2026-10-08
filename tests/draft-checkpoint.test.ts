import { describe, expect, it } from 'vitest';
import { clearDraftCheckpoints, openDraftCheckpoint, type DraftScope } from '../src/lib/draft-checkpoint';
import { fromBase64Url } from '../src/lib/base64';
import { canonicalStringify } from '../src/lib/canonical';

class MemoryStorage implements Storage {
  data = new Map<string, string>(); blocked = false;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.blocked) throw new DOMException('Quota exceeded', 'QuotaExceededError'); this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
const scope: DraftScope = { origin: 'https://ai.shui.click', spaceId: 'slot-a', roomId: 'room-a', deviceId: 'device-a' };
const master = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

describe('encrypted draft persistence contract', () => {
  it('does not claim a writer for a cancelled or replaced unlock', async () => {
    const key = await master(), storage = new MemoryStorage();
    const active = await openDraftCheckpoint(key, scope, 'active', undefined, storage);
    const before = [...storage.data];
    await expect(openDraftCheckpoint(key, scope, 'late', undefined, storage, false, () => false)).rejects.toThrow(/replaced/);
    expect([...storage.data]).toEqual(before); active.write('still active'); active.dispose();
  });
  it('keeps an authenticated empty clear fence against an older preference fallback', async () => {
    const key = await master(), storage = new MemoryStorage();
    const old = await openDraftCheckpoint(key, scope, 'old', undefined, storage);
    const clear = await openDraftCheckpoint(key, scope, '', undefined, storage, true); clear.dispose();
    expect(() => old.write('late')).toThrow();
    const restored = await openDraftCheckpoint(key, scope, 'late old preferences', undefined, storage);
    expect(restored.draft).toBe(''); old.dispose(); restored.dispose();
  });
  it('restores the newest immediate input, replacement, and explicit empty draft without an async flush', async () => {
    const key = await master(), storage = new MemoryStorage();
    let draft = await openDraftCheckpoint(key, scope, 'old IndexedDB draft', undefined, storage);
    for (const text of ['新输入\n继续', '替换原文', '']) {
      draft.write(text); draft.dispose();
      draft = await openDraftCheckpoint(key, scope, 'old IndexedDB draft', undefined, storage);
      expect(draft.draft).toBe(text);
    }
    expect(storage.length).toBe(2); draft.dispose();
  });
  it('interoperates with WebCrypto AES-GCM and persists neither text nor the derived key', async () => {
    const key = await master(), storage = new MemoryStorage();
    const draft = await openDraftCheckpoint(key, scope, '', undefined, storage);
    draft.write('同步密文检查点');
    const records = [...storage.data.entries()]; const owner = records.find(([id]) => id.endsWith(':owner'))![1];
    const sealed = JSON.parse(records.find(([id]) => id.endsWith(`:${owner}`))![1]);
    const raw = await crypto.subtle.exportKey('raw', key);
    const hkdf = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    const derived = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(canonicalStringify(scope)), info: new TextEncoder().encode('quiet-room-composer-draft-v1') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(sealed.iv), additionalData: new TextEncoder().encode(canonicalStringify({ purpose: 'quiet-room-composer-draft-v1', ...scope, writer: owner })) }, derived, fromBase64Url(sealed.ciphertext));
    expect(JSON.parse(new TextDecoder().decode(plaintext)).draft).toBe('同步密文检查点');
    expect(JSON.stringify(records)).not.toContain('同步密文检查点');
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'iv', 'v']); draft.dispose();
  });
  it('uses a fresh nonce and revision for every changed input, including same-text ABA', async () => {
    const key = await master(), storage = new MemoryStorage(), nonces = new Set<string>();
    const draft = await openDraftCheckpoint(key, scope, '', undefined, storage);
    draft.write('same'); const submitted = draft.submission();
    for (let i = 0; i < 100; i++) {
      draft.write(i % 2 ? 'same' : 'changed');
      const record = [...storage.data.entries()].find(([id]) => !id.endsWith(':owner'))![1];
      nonces.add(JSON.parse(record).iv);
    }
    expect(nonces.size).toBe(100); expect(draft.submission()).not.toEqual(submitted);
    draft.dispose();
    const restored = await openDraftCheckpoint(key, scope, '', submitted, storage);
    expect(restored.draft).toBe('same'); restored.dispose();
  });
  it('restores empty after a committed submission, but retains input entered during that submission', async () => {
    for (const newer of [false, true]) {
      const key = await master(), storage = new MemoryStorage();
      const draft = await openDraftCheckpoint(key, scope, '', undefined, storage);
      draft.write('submitted'); const submitted = draft.submission();
      if (newer) draft.write('new input');
      draft.dispose();
      const restored = await openDraftCheckpoint(key, scope, 'submitted', submitted, storage);
      expect(restored.draft).toBe(newer ? 'new input' : ''); restored.dispose();
    }
  });
  it('rejects stale writers and disposed runtimes without changing the latest draft', async () => {
    const key = await master(), storage = new MemoryStorage();
    const old = await openDraftCheckpoint(key, scope, '', undefined, storage); old.write('before second tab');
    const next = await openDraftCheckpoint(key, scope, '', undefined, storage); next.write('second tab latest');
    expect(() => old.write('late old tab')).toThrow(/重新解锁/);
    old.dispose(); expect(old.draft).toBe(''); expect(() => old.write('locked')).toThrow();
    next.dispose(); const reopened = await openDraftCheckpoint(key, scope, '', undefined, storage);
    expect(reopened.draft).toBe('second tab latest'); reopened.dispose();
  });
  it('preserves the last successful checkpoint on quota failure and does not silently acknowledge it', async () => {
    const key = await master(), storage = new MemoryStorage();
    const draft = await openDraftCheckpoint(key, scope, 'saved', undefined, storage); const saved = draft.submission();
    storage.blocked = true; expect(() => draft.write('not saved')).toThrow(/Quota/);
    expect(draft.draft).toBe('saved'); expect(draft.submission()).toEqual(saved); draft.dispose();
    storage.blocked = false; const restored = await openDraftCheckpoint(key, scope, '', undefined, storage);
    expect(restored.draft).toBe('saved'); restored.dispose();
  });
  it('retains the previous complete draft if publishing a new unlock owner fails', async () => {
    const key = await master(), storage = new MemoryStorage();
    const active = await openDraftCheckpoint(key, scope, 'saved', undefined, storage);
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (id, value) => {
      if (id.endsWith(':owner')) throw new DOMException('Owner quota', 'QuotaExceededError');
      setItem(id, value);
    };
    await expect(openDraftCheckpoint(key, scope, 'stale', undefined, storage)).rejects.toThrow(/quota/);
    storage.setItem = setItem;
    active.write('still owned'); active.dispose();
    const restored = await openDraftCheckpoint(key, scope, 'stale', undefined, storage);
    expect(restored.draft).toBe('still owned'); restored.dispose();
  });
  it('rejects corrupted ciphertext and wrong master/origin instead of falling back to stale preferences', async () => {
    const key = await master();
    for (const fault of ['ciphertext', 'master', 'origin']) {
      const storage = new MemoryStorage(), draft = await openDraftCheckpoint(key, scope, '', undefined, storage);
      draft.write('private'); draft.dispose();
      if (fault === 'ciphertext') {
        const [id, raw] = [...storage.data.entries()].find(([id]) => !id.endsWith(':owner'))!;
        const sealed = JSON.parse(raw); sealed.ciphertext = 'A'.repeat(sealed.ciphertext.length); storage.setItem(id, JSON.stringify(sealed));
      }
      await expect(openDraftCheckpoint(fault === 'master' ? await master() : key, fault === 'origin' ? { ...scope, origin: 'https://other.test' } : scope, 'stale', undefined, storage)).rejects.toThrow(/损坏/);
    }
  });
  it('isolates spaces/devices and clearing a slot invalidates old writers without deleting other slots', async () => {
    const key = await master(), storage = new MemoryStorage();
    const a = await openDraftCheckpoint(key, scope, 'A', undefined, storage);
    const b = await openDraftCheckpoint(key, { ...scope, spaceId: 'slot-b', roomId: 'room-b' }, 'B', undefined, storage);
    const c = await openDraftCheckpoint(key, { ...scope, deviceId: 'device-c' }, 'C', undefined, storage);
    expect([a.draft, b.draft, c.draft]).toEqual(['A', 'B', 'C']);
    clearDraftCheckpoints('slot-a', storage); expect(() => a.write('late')).toThrow(); expect(() => c.write('late')).toThrow();
    b.write('still B'); b.dispose(); const reopened = await openDraftCheckpoint(key, { ...scope, spaceId: 'slot-b', roomId: 'room-b' }, '', undefined, storage);
    expect(reopened.draft).toBe('still B'); reopened.dispose(); a.dispose(); c.dispose();
  });
});
