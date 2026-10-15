import { describe, expect, it } from 'vitest';
import { derivePasswordCredential, deriveNumericPasswordCredential, numericPasswordValidation, passwordValidation, unwrapPasswordMaster, validPasswordKdf, wrapPasswordMaster } from '../src/lib/password-protection';
import type { StoredPasswordVault } from '../src/lib/types';

describe('new password wrapper', () => {
  it('accepts exactly six ASCII digits including leading zeros', () => {
    expect(numericPasswordValidation('012345', '012345')).toBe('');
    for (const invalid of ['', '12345', '1234567', '１２３４５６', '12345a', ' 123456']) expect(numericPasswordValidation(invalid)).toContain('6');
    expect(numericPasswordValidation('012345', '012346')).toContain('不一致');
  });
  it('authenticates numeric format without converting existing text wrappers', async () => {
    const credential = await deriveNumericPasswordCredential('012345');
    const master = crypto.getRandomValues(new Uint8Array(32));
    const stored: StoredPasswordVault = { v: 3, unlockMethod: 'password', passwordFormat: credential.passwordFormat,
      spaceId: 'numeric-space', kdf: credential.kdf, wrappedKey: await wrapPasswordMaster(master, credential, 'numeric-space'), payload: { iv: '', ciphertext: '' } };
    expect(stored.passwordFormat).toBe('numeric-6');
    expect(await unwrapPasswordMaster(stored, '012345')).toEqual(master);
    await expect(unwrapPasswordMaster(stored, '12345')).rejects.toThrow();
    await expect(unwrapPasswordMaster({ ...stored, passwordFormat: undefined }, '012345')).rejects.toThrow();
    await expect(unwrapPasswordMaster({ ...stored, spaceId: 'another-space' }, '012345')).rejects.toThrow();
    await expect(deriveNumericPasswordCredential('long legacy password')).rejects.toThrow('6');
    await expect(derivePasswordCredential('012345')).rejects.toThrow('12');
  });
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
