import { uiLiteral } from './language';
import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { derivePasswordCredential, passwordValidation, validPasswordKdf } from './password-protection';
import type { VaultKdf } from './types';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const bytes = (value: unknown) => encoder.encode(canonicalStringify(value));
const hash = (value: Uint8Array) => toBase64Url(sha256(value));
const secret = (seed: string, purpose: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(seed)) throw new Error(uiLiteral('恢复材料不完整'));
  return Uint8Array.from(hkdf(sha256, fromBase64Url(seed), new Uint8Array(), encoder.encode(`quiet-room-archive-v2:${purpose}`), 32));
};
export type ArchiveDescriptor = { v: 2; id: string; encryptionKey: string; signingKey: string; readHash: string };
export type ArchiveKey = { v: 2; seed: string; descriptor: ArchiveDescriptor; readToken?: string };
export type ArchiveObject = { v: 2; archiveId: string; id: string; enc: string; ciphertext: string; signature: string };
export type ProtectedArchiveCard = { format: 'quiet-room-private-archive'; v: 2; kdf: VaultKdf; iv: string; ciphertext: string };
export const MAX_ARCHIVE_OBJECT_BYTES = 4_300_000;
export const MAX_CARD_BYTES = 4096;
export function archiveReadToken(seed: string): string { const raw = secret(seed, 'read'); try { return toBase64Url(raw); } finally { raw.fill(0); } }
export const archiveAccessToken = (key: ArchiveKey): string => key.readToken ?? archiveReadToken(key.seed);
export const archiveAccessHash = (token: string): string => hash(encoder.encode(token));
export function archiveAccessProof(key: ArchiveKey, room: string, device: string, expected: string, next: string): string {
  validateArchiveKey(key); const signing = secret(key.seed, 'sign');
  try { return toBase64Url(ed25519.sign(bytes(['quiet-room-archive-access-v1', key.descriptor.id, room, device, expected, next]), signing)); }
  finally { signing.fill(0); }
}
export function descriptorForSeed(seed: string): ArchiveDescriptor {
  const encryption = secret(seed, 'decrypt'), signing = secret(seed, 'sign');
  try {
    const encryptionKey = toBase64Url(x25519.getPublicKey(encryption)), signingKey = toBase64Url(ed25519.getPublicKey(signing));
    const readHash = hash(encoder.encode(archiveReadToken(seed)));
    return { v: 2, id: hash(bytes({ encryptionKey, signingKey, readHash })), encryptionKey, signingKey, readHash };
  } finally { encryption.fill(0); signing.fill(0); }
}
export function newArchiveKey(): ArchiveKey {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try { const seed = toBase64Url(raw); return { v: 2, seed, descriptor: descriptorForSeed(seed) }; } finally { raw.fill(0); }
}
export function validateArchiveKey(value: unknown): asserts value is ArchiveKey {
  const key = value as ArchiveKey;
  if (!key || !['descriptor,seed,v','descriptor,readToken,seed,v'].includes(Object.keys(key).sort().join(',')) || (Object.hasOwn(key,'readToken') && !/^[A-Za-z0-9_-]{43}$/.test(key.readToken!)) || key.v !== 2 || canonicalStringify(descriptorForSeed(key.seed)) !== canonicalStringify(key.descriptor)) throw new Error(uiLiteral('恢复材料校验失败'));
}
/** Only archive data enters this envelope. Device credentials and MLS state are never inputs. */
export async function sealArchiveObject(key: ArchiveKey, payload: unknown): Promise<ArchiveObject> {
  validateArchiveKey(key);
  const raw = bytes(payload);
  if (raw.length > 3_000_000) throw new Error(uiLiteral('归档分块过大'));
  const id = crypto.randomUUID(), info = bytes(['quiet-room-private-archive-object-v2', key.descriptor.id, id]);
  const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64Url(key.descriptor.encryptionKey));
  const sender = await suite.createSenderContext({ recipientPublicKey, info: info.buffer });
  const signing = secret(key.seed, 'sign');
  try {
    const unsigned = { v: 2 as const, archiveId: key.descriptor.id, id, enc: toBase64Url(sender.enc), ciphertext: toBase64Url(await sender.seal(raw.buffer, info.buffer)) };
    return { ...unsigned, signature: toBase64Url(ed25519.sign(bytes(unsigned), signing)) };
  } finally { raw.fill(0); signing.fill(0); }
}
export function verifyArchiveObject(descriptor: ArchiveDescriptor, object: ArchiveObject): boolean {
  try {
    if (Object.keys(object).sort().join(',') !== 'archiveId,ciphertext,enc,id,signature,v' || object.v !== 2 || object.archiveId !== descriptor.id ||
      !/^[0-9a-f-]{36}$/.test(object.id) || !/^[A-Za-z0-9_-]{43}$/.test(object.enc) ||
      typeof object.ciphertext !== 'string' || object.ciphertext.length > MAX_ARCHIVE_OBJECT_BYTES || !/^[A-Za-z0-9_-]{22,}$/.test(object.ciphertext) ||
      !/^[A-Za-z0-9_-]{86}$/.test(object.signature)) return false;
    const { signature, ...unsigned } = object;
    return ed25519.verify(fromBase64Url(signature), bytes(unsigned), fromBase64Url(descriptor.signingKey), { zip215: false });
  } catch { return false; }
}
export async function openArchiveObject(key: ArchiveKey, object: ArchiveObject): Promise<unknown> {
  validateArchiveKey(key);
  if (!verifyArchiveObject(key.descriptor, object)) throw new Error(uiLiteral('归档分块的来源或完整性校验失败'));
  const encryption = secret(key.seed, 'decrypt');
  let raw: Uint8Array | undefined;
  try {
    const recipientKey = await suite.kem.deserializePrivateKey(encryption);
    const info = bytes(['quiet-room-private-archive-object-v2', key.descriptor.id, object.id]);
    const recipient = await suite.createRecipientContext({ recipientKey, enc: fromBase64Url(object.enc).buffer, info: info.buffer });
    raw = new Uint8Array(await recipient.open(fromBase64Url(object.ciphertext).buffer, info.buffer));
    return JSON.parse(decoder.decode(raw));
  } finally { encryption.fill(0); raw?.fill(0); }
}
export const archiveObjectHash = (object: ArchiveObject) => hash(bytes(object));
export async function protectArchiveCard(key: ArchiveKey, password: string): Promise<string> {
  validateArchiveKey(key);
  const invalid = passwordValidation(password); if (invalid) throw new Error(invalid);
  const credential = await derivePasswordCredential(password), iv = crypto.getRandomValues(new Uint8Array(12));
  delete credential.rootKek;
  const header = { format: 'quiet-room-private-archive' as const, v: 2 as const, kdf: credential.kdf, iv: toBase64Url(iv) };
  const raw = bytes(key);
  try { return canonicalStringify({ ...header, ciphertext: toBase64Url(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes(header) }, credential.kek, raw)) }); }
  finally { raw.fill(0); }
}
export async function unlockArchiveCard(text: string, password: string): Promise<ArchiveKey> {
  if (typeof password!=='string'||Array.from(password).length>128) throw new Error(uiLiteral('恢复口令过长'));
  if (encoder.encode(text).length > MAX_CARD_BYTES) throw new Error(uiLiteral('恢复图片内容过大'));
  let card: ProtectedArchiveCard;
  try { card = JSON.parse(text); } catch { throw new Error(uiLiteral('无法识别这张恢复图片')); }
  if (!card || Object.keys(card).sort().join(',') !== 'ciphertext,format,iv,kdf,v' || card.format !== 'quiet-room-private-archive' || card.v !== 2 ||
    !validPasswordKdf(card.kdf) || !/^[A-Za-z0-9_-]{16}$/.test(card.iv) || typeof card.ciphertext !== 'string' || card.ciphertext.length > MAX_CARD_BYTES) throw new Error(uiLiteral('恢复图片格式或保护参数不受支持'));
  const credential = await derivePasswordCredential(password, card.kdf); delete credential.rootKek;
  const { ciphertext, ...header } = card;
  let raw: Uint8Array | undefined;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(card.iv), additionalData: bytes(header) }, credential.kek, fromBase64Url(ciphertext)));
    const key: unknown = JSON.parse(decoder.decode(raw)); validateArchiveKey(key); return key;
  } catch { throw new Error(uiLiteral('恢复口令不正确，或图片已经损坏')); }
  finally { raw?.fill(0); }
}

/** A retained local archive can follow an authenticated replacement of its
 * own participant, without granting that power to the peer's room token. */
export function archiveWriterProof(key:ArchiveKey,roomId:string,deviceId:string):string {
  validateArchiveKey(key);const signing=secret(key.seed,'sign');
  try{return toBase64Url(ed25519.sign(bytes(['quiet-room-archive-writer-v2',key.descriptor.id,roomId,deviceId]),signing));}
  finally{signing.fill(0);}
}
