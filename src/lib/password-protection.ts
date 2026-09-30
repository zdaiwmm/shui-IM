import { argon2id } from 'hash-wasm';
import { fromBase64Url, toBase64Url } from './base64';
import type { VaultKdf, StoredPasswordVault } from './types';
import type { PlatformCredentialResult } from './platform-vault';

export type PasswordCredentialResult = { method: 'password'; kdf: VaultKdf; kek: CryptoKey };
export type LocalCredentialResult = PlatformCredentialResult | PasswordCredentialResult;
export const isPasswordCredential = (value: LocalCredentialResult): value is PasswordCredentialResult => 'method' in value && value.method === 'password';
const encoder = new TextEncoder();

/** Passwords are used exactly as entered: no trimming or Unicode normalization. */
export function passwordValidation(password: string, confirmation?: string): string {
  const length = Array.from(password).length;
  if (length < 12) return '请至少使用 12 个字符';
  if (length > 128) return '密码最多使用 128 个字符';
  if (confirmation !== undefined && password !== confirmation) return '两次输入的密码不一致';
  return '';
}

export function validPasswordKdf(kdf: VaultKdf): boolean {
  return kdf?.name === 'argon2id' && kdf.memorySize === 65_536 && kdf.iterations === 3 && kdf.parallelism === 1 &&
    typeof kdf.salt === 'string' && /^[A-Za-z0-9_-]{22}$/.test(kdf.salt) && fromBase64Url(kdf.salt).length === 16;
}

export async function derivePasswordCredential(password: string, existing?: VaultKdf): Promise<PasswordCredentialResult> {
  if (!existing && passwordValidation(password)) throw new Error(passwordValidation(password));
  const kdf: VaultKdf = existing ?? { name: 'argon2id', memorySize: 65_536, iterations: 3, parallelism: 1,
    salt: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
  if (!validPasswordKdf(kdf)) throw new Error('本机密码保护参数不受支持');
  const output = await argon2id({ password, salt: fromBase64Url(kdf.salt), memorySize: kdf.memorySize,
    iterations: kdf.iterations, parallelism: kdf.parallelism, hashLength: 32, outputType: 'binary' });
  const bytes = Uint8Array.from(output as Uint8Array);
  try {
    return { method: 'password', kdf, kek: await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  } finally { bytes.fill(0); (output as Uint8Array).fill(0); }
}

function aad(stored: Pick<StoredPasswordVault, 'kdf' | 'spaceId'>): Uint8Array<ArrayBuffer> {
  const { name, memorySize, iterations, parallelism, salt } = stored.kdf;
  return encoder.encode(JSON.stringify(['quiet-room-password-master-v3', stored.spaceId ?? 'current', name, memorySize, iterations, parallelism, salt]));
}

export async function wrapPasswordMaster(master: Uint8Array<ArrayBuffer>, credential: PasswordCredentialResult, spaceId: string): Promise<StoredPasswordVault['wrappedKey']> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad({ kdf: credential.kdf, spaceId }), tagLength: 128 }, credential.kek, master);
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(encrypted) };
}

export async function unwrapPasswordMaster(stored: StoredPasswordVault, password: string): Promise<Uint8Array<ArrayBuffer>> {
  const credential = await derivePasswordCredential(password, stored.kdf);
  const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(stored.wrappedKey.iv),
    additionalData: aad(stored), tagLength: 128 }, credential.kek, fromBase64Url(stored.wrappedKey.ciphertext)));
  if (bytes.length !== 32) { bytes.fill(0); throw new Error('INVALID_MASTER_KEY'); }
  return bytes;
}
