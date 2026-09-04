import { fromBase64Url, toBase64Url } from './base64';
import type { CloudRecoveryBundle, SealedBackup } from './backup-types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const randomBackupSecret = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export function newRecoveryCode(): { id: string; code: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return { id: toBase64Url(bytes.slice(0, 16)), code: `QR3-${toBase64Url(bytes)}` };
}

export function parseCloudRecoveryCode(code: string): { id: string; secret: Uint8Array<ArrayBuffer> } {
  const normalized = code.trim();
  if (!/^QR3-[A-Za-z0-9_-]{64}$/.test(normalized)) throw new Error('请输入完整的自动备份恢复码（QR3 开头）');
  const bytes = fromBase64Url(normalized.slice(4));
  if (bytes.length !== 48 || toBase64Url(bytes) !== normalized.slice(4)) throw new Error('恢复码格式不正确');
  return { id: toBase64Url(bytes.slice(0, 16)), secret: bytes.slice(16) };
}

async function derive(code: string, purpose: string): Promise<Uint8Array<ArrayBuffer>> {
  const { id, secret } = parseCloudRecoveryCode(code);
  try {
    const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(id),
      info: encoder.encode(`quiet-room-cloud-${purpose}-v1`) }, key, 256));
  } finally { secret.fill(0); }
}

export async function recoveryFetchToken(code: string): Promise<string> {
  const bytes = await derive(code, 'fetch');
  try { return toBase64Url(bytes); } finally { bytes.fill(0); }
}

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  try { return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { raw.fill(0); }
}

export async function sealJson(value: unknown, secret: string, aad: string): Promise<SealedBackup> {
  return sealWithKey(value, await aesKey(fromBase64Url(secret)), aad);
}

async function sealWithKey(value: unknown, key: CryptoKey, aad: string): Promise<SealedBackup> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, key, plaintext);
    return { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
  } finally { plaintext.fill(0); }
}

async function openWithKey(sealed: SealedBackup, key: CryptoKey, aad: string): Promise<unknown> {
  if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ciphertext !== 'string' ||
      sealed.iv.length !== 16 || sealed.ciphertext.length > 2 * 1024 * 1024) throw new Error('备份格式不正确');
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(sealed.iv),
    additionalData: encoder.encode(aad), tagLength: 128 }, key, fromBase64Url(sealed.ciphertext)));
  try { return JSON.parse(decoder.decode(plaintext)); } finally { plaintext.fill(0); }
}

export function openJson(sealed: SealedBackup, secret: string, aad: string): Promise<unknown> {
  return aesKey(fromBase64Url(secret)).then(key => openWithKey(sealed, key, aad));
}

export async function sealRecovery(bundle: CloudRecoveryBundle, code: string): Promise<SealedBackup> {
  if (bundle.backupId !== parseCloudRecoveryCode(code).id) throw new Error('恢复码与备份不匹配');
  return sealWithKey(bundle, await aesKey(await derive(code, 'encryption')), `quiet-room-cloud-recovery-v1:${bundle.backupId}`);
}

export async function openRecovery(sealed: SealedBackup, code: string): Promise<CloudRecoveryBundle> {
  const { id } = parseCloudRecoveryCode(code);
  const value = await openWithKey(sealed, await aesKey(await derive(code, 'encryption')), `quiet-room-cloud-recovery-v1:${id}`) as CloudRecoveryBundle;
  if (value?.v !== 1 || value.backupId !== id || value.roomId !== value.checkpoint?.roomId ||
      value.deviceId !== value.checkpoint?.identity?.publicBundle?.deviceId || value.checkpoint.protocol !== 'mls-rfc9420' ||
      value.checkpoint.backup || value.checkpoint.recoverySource || !Array.isArray(value.archives) || value.archives.length > 100 ||
      value.archives.some(a => !/^[A-Za-z0-9_-]{43}$/.test(a.id) || !/^[A-Za-z0-9_-]{43}$/.test(a.key) ||
        !/^[A-Za-z0-9_-]{43}$/.test(a.token) || !Array.isArray(a.parts) || a.parts.length > 10_000 ||
        a.parts.some(p => !/^[A-Za-z0-9_-]{43}$/.test(p.id) || !/^[A-Za-z0-9_-]{43}$/.test(p.digest) ||
          !Number.isSafeInteger(p.firstSeq) || !Number.isSafeInteger(p.lastSeq) || p.firstSeq < 1 || p.lastSeq < p.firstSeq ||
          !Number.isSafeInteger(p.count) || p.count < 1 || p.count > 100))) throw new Error('恢复备份的身份或历史索引不正确');
  return value;
}

export async function backupDigest(value: SealedBackup): Promise<string> {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))));
}

export const archiveAad = (roomId: string, archiveId: string, partId: string) =>
  `quiet-room-history-archive-v1:${roomId}:${archiveId}:${partId}`;
