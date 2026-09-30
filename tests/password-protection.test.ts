import { describe, expect, it } from 'vitest';
import { derivePasswordCredential, passwordValidation, unwrapPasswordMaster, validPasswordKdf, wrapPasswordMaster } from '../src/lib/password-protection';
import type { StoredPasswordVault } from '../src/lib/types';

describe('new password wrapper', () => {
  it('counts code points and preserves spaces, case and exact Unicode', () => {
    expect(passwordValidation('🔐'.repeat(12), '🔐'.repeat(12))).toBe('');
    expect(passwordValidation('🔐'.repeat(129))).toContain('128');
    expect(passwordValidation('  twelve chars  ', 'twelve chars')).toContain('不一致');
    expect(passwordValidation('Short')).toContain('12');
  });
  it('authenticates a random master and target slot, rejects wrong passwords and tampering', async () => {
    const password = ' 雨天的 quiet room 🔐 ';
    const credential = await derivePasswordCredential(password);
    const master = crypto.getRandomValues(new Uint8Array(32));
    const stored: StoredPasswordVault = { v: 3, unlockMethod: 'password', spaceId: 'space-a', kdf: credential.kdf,
      wrappedKey: await wrapPasswordMaster(master, credential, 'space-a'), payload: { iv: '', ciphertext: '' } };
    expect(await unwrapPasswordMaster(stored, password)).toEqual(master);
    await expect(unwrapPasswordMaster(stored, password.trim())).rejects.toThrow();
    await expect(unwrapPasswordMaster({ ...stored, spaceId: 'space-b' }, password)).rejects.toThrow();
    const changed = structuredClone(stored); changed.wrappedKey.ciphertext = 'A' + changed.wrappedKey.ciphertext.slice(1);
    if (changed.wrappedKey.ciphertext === stored.wrappedKey.ciphertext) changed.wrappedKey.ciphertext = 'B' + stored.wrappedKey.ciphertext.slice(1);
    await expect(unwrapPasswordMaster(changed, password)).rejects.toThrow();
    expect(validPasswordKdf({ ...stored.kdf, memorySize: 8_192 })).toBe(false);
    await expect(derivePasswordCredential(password, { ...stored.kdf, iterations: 10_000 })).rejects.toThrow('参数');
  });
});
