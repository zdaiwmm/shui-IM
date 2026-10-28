import { uiLiteral } from './language';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { isPasswordCredential, validPasswordKdf, type LocalCredentialResult } from './password-protection';
import type { PlatformCredentialRecord, VaultKdf } from './types';
import { isPersonalPublicIdentity, withPersonalKeys, type PersonalPublicIdentity } from './personal-identity';

type Envelope = { iv: string; ciphertext: string };
type Protection = { method: 'password'; kdf: VaultKdf; passwordFormat?: 'numeric-6' } |
  { method: 'passkey'; platform: PlatformCredentialRecord; dailyPlatform: PlatformCredentialRecord };
export type StoredPersonalIdentity = { v: 1; identity: PersonalPublicIdentity; protection: Protection; wrappedKey: Envelope; payload: Envelope };
const encode = (value: unknown) => new TextEncoder().encode(canonicalStringify(value));
const aad = (identity: PersonalPublicIdentity, protection: Protection, layer: string) => encode({ purpose: 'chamber-personal-vault-v1', layer, identity, protection });

function validPlatform(p: PlatformCredentialRecord): boolean {
  const allowed = new Set(['credentialId', 'userId', 'userName', 'rpId', 'origin', 'prfSalt', 'transports', 'authenticatorAttachment', 'backupEligible', 'createdAt']);
  return !!p && Object.keys(p).every(k => allowed.has(k)) &&
    typeof p.credentialId === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(p.credentialId) &&
    typeof p.prfSalt === 'string' && /^[A-Za-z0-9_-]{43}$/.test(p.prfSalt) &&
    Array.isArray(p.transports) && p.transports.every(t => ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'].includes(t)) &&
    (p.authenticatorAttachment === null || ['platform', 'cross-platform'].includes(p.authenticatorAttachment)) &&
    typeof p.backupEligible === 'boolean' && typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)) &&
    ['userId', 'userName', 'rpId', 'origin'].every(k => p[k as keyof PlatformCredentialRecord] === undefined || typeof p[k as keyof PlatformCredentialRecord] === 'string');
}
const samePlatform = (root:PlatformCredentialRecord,daily:PlatformCredentialRecord) => root.credentialId===daily.credentialId && root.rpId===daily.rpId && root.origin===daily.origin && root.prfSalt!==daily.prfSalt;

function assertCredential(credential: LocalCredentialResult): void {
  if (!credential) throw new Error(uiLiteral('请先设置应用锁'));
  if (isPasswordCredential(credential)) {
    if (!validPasswordKdf(credential.kdf) || credential.kek?.type !== 'secret' ||
        credential.kek.algorithm.name !== 'AES-GCM' || (credential.kek.algorithm as AesKeyAlgorithm).length !== 256 ||
        !credential.kek.usages.includes('encrypt') || !credential.kek.usages.includes('decrypt') ||
        (credential.passwordFormat !== undefined && credential.passwordFormat !== 'numeric-6')) throw new Error(uiLiteral('本机密码保护尚未准备完成'));
    if (credential.rootKek?.algorithm.name !== 'AES-GCM' || (credential.rootKek.algorithm as AesKeyAlgorithm).length !== 256 ||
      credential.rootKek.extractable || !credential.rootKek.usages.includes('encrypt') || !credential.rootKek.usages.includes('decrypt')) throw new Error(uiLiteral('请为本次身份操作重新验证应用锁'));
  } else if (!validPlatform(credential.record) || credential.prfOutput?.length !== 32) throw new Error(uiLiteral('通行密钥保护尚未准备完成'));
}

async function seal(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, bytes);
  return { iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
}

async function open(key: CryptoKey, envelope: Envelope, additionalData: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(envelope.iv), additionalData, tagLength: 128 }, key, fromBase64Url(envelope.ciphertext)));
}

async function protectionKey(credential: LocalCredentialResult, identity: PersonalPublicIdentity, dailyPlatform?: PlatformCredentialRecord): Promise<{ key: CryptoKey; protection: Protection }> {
  assertCredential(credential);
  if (isPasswordCredential(credential)) {
    if (!validPasswordKdf(credential.kdf) || credential.kek.algorithm.name !== 'AES-GCM') throw new Error(uiLiteral('本机密码保护尚未准备完成'));
    return { key: credential.rootKek!, protection: { method: 'password', kdf: structuredClone(credential.kdf),
      ...(credential.passwordFormat ? { passwordFormat: credential.passwordFormat } : {}) } };
  }
  if (!credential?.record?.credentialId || credential.prfOutput?.length !== 32) throw new Error(uiLiteral('通行密钥保护尚未准备完成'));
  if (!dailyPlatform || !validPlatform(dailyPlatform) || !samePlatform(credential.record,dailyPlatform)) throw new Error(uiLiteral('助记词保管须使用独立的通行密钥PRF输入'));
  const material = await crypto.subtle.importKey('raw', credential.prfOutput, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(credential.record.prfSalt),
    info: encode({ purpose: 'chamber-personal-vault-kek-v1', identityId: identity.id }) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, protection: { method: 'passkey', platform: structuredClone(credential.record), dailyPlatform: structuredClone(dailyPlatform) } };
}

/** Generate no root entropy until the caller has prepared an actual local credential. */
export async function preparePersonalIdentity(credential: LocalCredentialResult, importedEntropy?: Uint8Array, dailyPlatform?: PlatformCredentialRecord): Promise<StoredPersonalIdentity> {
  assertCredential(credential);
  if (!isPasswordCredential(credential) && (!dailyPlatform || !validPlatform(dailyPlatform) ||
    !samePlatform(credential.record,dailyPlatform))) throw new Error(uiLiteral('助记词保管须使用独立的通行密钥PRF输入'));
  if (importedEntropy && importedEntropy.length !== 16) throw new Error(uiLiteral('身份熵长度不正确'));
  const entropy = importedEntropy ? new Uint8Array(importedEntropy) : crypto.getRandomValues(new Uint8Array(16));
  const master = crypto.getRandomValues(new Uint8Array(32));
  try {
    const identity = await withPersonalKeys(entropy, keys => keys.publicIdentity);
    const { key: kek, protection } = await protectionKey(credential, identity, dailyPlatform);
    const key = await crypto.subtle.importKey('raw', master, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const stored: StoredPersonalIdentity = { v: 1, identity, protection,
      wrappedKey: await seal(kek, master, aad(identity, protection, 'master')),
      payload: await seal(key, entropy, aad(identity, protection, 'root')) };
    await usePersonalIdentity(stored, credential, restored => {
      if (restored.length !== entropy.length || restored.some((byte, i) => byte !== entropy[i])) throw new Error(uiLiteral('身份加密回读校验失败'));
    });
    return stored;
  } finally { entropy.fill(0); master.fill(0); }
}

export function validStoredPersonalIdentity(value: unknown): value is StoredPersonalIdentity {
  if (!value || typeof value !== 'object') return false;
  const x = value as StoredPersonalIdentity;
  if (Object.keys(x).sort().join(',') !== 'identity,payload,protection,v,wrappedKey' || x.v !== 1 || !isPersonalPublicIdentity(x.identity)) return false;
  const envelope = (e: Envelope, length: number) => !!e && Object.keys(e).sort().join(',') === 'ciphertext,iv' &&
    typeof e.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(e.iv) && typeof e.ciphertext === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(e.ciphertext) && fromBase64Url(e.ciphertext).length === length;
  try {
    if (!envelope(x.wrappedKey, 48) || !envelope(x.payload, 32)) return false;
    if (x.protection?.method === 'password') return validPasswordKdf(x.protection.kdf) &&
      Object.keys(x.protection).sort().join(',') === (x.protection.passwordFormat ? 'kdf,method,passwordFormat' : 'kdf,method') &&
      (x.protection.passwordFormat === undefined || x.protection.passwordFormat === 'numeric-6');
    if (x.protection?.method !== 'passkey' || Object.keys(x.protection).sort().join(',') !== 'dailyPlatform,method,platform') return false;
    return validPlatform(x.protection.platform) && validPlatform(x.protection.dailyPlatform) &&
      samePlatform(x.protection.platform,x.protection.dailyPlatform);
  } catch { return false; }
}

/** Never returns plaintext entropy to a long-lived session; wipe it after the operation. */
export async function usePersonalIdentity<T>(stored: StoredPersonalIdentity, credential: LocalCredentialResult,
  operation: (entropy: Uint8Array<ArrayBuffer>) => T | Promise<T>): Promise<T> {
  if (!validStoredPersonalIdentity(stored)) throw new Error(uiLiteral('本机身份保管数据损坏'));
  const { key: kek, protection } = await protectionKey(credential, stored.identity, stored.protection.method === 'passkey' ? stored.protection.dailyPlatform : undefined);
  if (canonicalStringify(protection) !== canonicalStringify(stored.protection)) throw new Error(uiLiteral('请使用原应用锁验证身份'));
  const master = await open(kek, stored.wrappedKey, aad(stored.identity, stored.protection, 'master'));
  let entropy: Uint8Array<ArrayBuffer> | undefined;
  try {
    const key = await crypto.subtle.importKey('raw', master, 'AES-GCM', false, ['encrypt', 'decrypt']);
    entropy = await open(key, stored.payload, aad(stored.identity, stored.protection, 'root'));
    const identity = await withPersonalKeys(entropy, keys => keys.publicIdentity);
    if (canonicalStringify(identity) !== canonicalStringify(stored.identity)) throw new Error(uiLiteral('本机身份归属校验失败'));
    return await operation(entropy);
  } finally { entropy?.fill(0); master.fill(0); }
}
