/** Real v1 data for migration tests. New production spaces never use this format. */
import { argon2id } from 'hash-wasm';
import { toBase64Url } from '../../src/lib/base64';
import { currentSpaceId, readStoredVault, type VaultSession } from '../../src/lib/vault';
import type { LegacyStoredVault, Vault } from '../../src/lib/types';

export async function createLegacyVault(vault: Vault, password: string): Promise<VaultSession> {
  await readStoredVault();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdf = { name: 'argon2id' as const, memorySize: 19_456, iterations: 2, parallelism: 1, salt: toBase64Url(salt) };
  const bytes = await argon2id({ password, salt, memorySize: kdf.memorySize, iterations: kdf.iterations, parallelism: 1, hashLength: 32, outputType: 'binary' });
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(bytes), 'AES-GCM', true, ['encrypt', 'decrypt']); bytes.fill(0);
  vault.v = 1;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('quiet-room-vault-v1'), tagLength: 128 }, key, new TextEncoder().encode(JSON.stringify(vault)));
  const stored: LegacyStoredVault = { v: 1, spaceId: currentSpaceId(), unlockMethod: 'password', kdf, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('quiet-room'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction('vault', 'readwrite'); tx.objectStore('vault').put(stored, stored.spaceId);
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; };
  });
  return { vault, key, stored };
}
