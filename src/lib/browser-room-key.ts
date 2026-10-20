import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { derivePasswordCredential, isPasswordCredential, wrapPasswordMaster, unwrapPasswordMaster, type LocalCredentialResult } from './password-protection';
import { readRoomProtection, replaceRoomProtection, withRoomUnlockThrottle } from './vault';
import type { PlatformCredentialRecord, StoredPasswordVault } from './types';

export type RoomProtection = { v: 1; revision: string } & (
  { method: 'automatic'; secret: string } |
  { method: 'platform'; platform: PlatformCredentialRecord; iv: string; ciphertext: string } |
  { method: 'password'; wrapper: Pick<StoredPasswordVault, 'spaceId' | 'kdf' | 'passwordFormat' | 'wrappedKey'> }
);
let held: { revision: string; secret: string } | undefined;
export function clearBrowserRoomKey(): void { held = undefined; }
export async function browserRoomKey(create = false): Promise<string | null> {
  let record = await readRoomProtection();
  if (!record && create) {
    const next: RoomProtection = { v: 1, revision: crypto.randomUUID(), method: 'automatic', secret: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) };
    try { await replaceRoomProtection(null, next); record = next; } catch { record = await readRoomProtection(); }
  }
  if (!record) return null;
  if (record.method === 'automatic') {
    if (!/^[A-Za-z0-9_-]{43}$/.test(record.secret)) throw new Error('本机访问材料损坏');
    return record.secret;
  }
  return held?.revision === record.revision ? held.secret : null;
}
export async function unlockBrowserRoomKey(password: string): Promise<string> {
  const record = await readRoomProtection();
  if (!record || record.method !== 'password') throw new Error('本机保护状态已改变');
  const raw = await withRoomUnlockThrottle(async () => {try{return await unwrapPasswordMaster({ ...record.wrapper, v: 3, unlockMethod: 'password', payload: { iv: '', ciphertext: '' } }, password);}catch(cause){if(cause instanceof DOMException && cause.name==='OperationError')throw new Error('应用锁密码不正确，请重试');throw cause;}});
  try {
    if (canonicalStringify(await readRoomProtection()) !== canonicalStringify(record)) throw new Error('应用锁已改变，请重试');
    const secret = toBase64Url(raw); held = { revision: record.revision, secret }; return secret;
  } finally { raw.fill(0); }
}
export async function protectBrowserRoomKey(credential: LocalCredentialResult): Promise<void> {
  const record = await readRoomProtection(), key = await browserRoomKey();
  if (!record || !key) throw new Error('请先解锁本机');
  const raw = fromBase64Url(key);
  try {
    const next: RoomProtection = isPasswordCredential(credential) ? { v: 1, revision: crypto.randomUUID(), method: 'password', wrapper: {
      spaceId: 'browser-rooms-v2', kdf: credential.kdf, ...(credential.passwordFormat ? { passwordFormat: credential.passwordFormat } : {}),
      wrappedKey: await wrapPasswordMaster(raw, credential, 'browser-rooms-v2'),
    } } : await protectWithPlatform(raw,credential);
    await replaceRoomProtection(record, next); held = { revision: next.revision, secret: key };
  } finally { raw.fill(0); if(isPasswordCredential(credential))delete credential.rootKek;else{credential.prfOutput.fill(0);credential.browserAccessPrf?.fill(0);} }
}
export async function removeBrowserRoomProtection(): Promise<void> {
  const record = await readRoomProtection(), secret = await browserRoomKey();
  if (!record || !secret) throw new Error('请先验证应用锁');
  await replaceRoomProtection(record, { v: 1, revision: crypto.randomUUID(), method: 'automatic', secret });
  held = undefined;
}
export async function automaticRoomCredential() {
  const secret = await browserRoomKey(true);
  if (!secret) throw new Error('请先解锁本机');
  const record = await readRoomProtection();
  if (!record || await browserRoomKey() !== secret) throw new Error('本机保护已改变，请重试');
  const credential = await derivePasswordCredential(secret); delete credential.rootKek;
  if ((await readRoomProtection())?.revision !== record.revision) throw new Error('本机保护已改变，请重试');
  credential.roomProtectionRevision = record.revision; return credential;
}

const encoder = new TextEncoder();
async function platformKey(proof: Uint8Array<ArrayBuffer>, platform: PlatformCredentialRecord) {
  const material=await crypto.subtle.importKey('raw',proof,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:fromBase64Url(platform.prfSalt),info:encoder.encode('quiet-room-browser-rooms-v2')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function platformAad(platform: PlatformCredentialRecord) {return encoder.encode(canonicalStringify({purpose:'browser-rooms-v2',platform}));}
async function protectWithPlatform(raw: Uint8Array<ArrayBuffer>, credential: Exclude<LocalCredentialResult,{method:'password'}>):Promise<RoomProtection> {
  const key=await platformKey(credential.prfOutput,credential.record),iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:platformAad(credential.record)},key,raw);
  return {v:1,revision:crypto.randomUUID(),method:'platform',platform:credential.record,iv:toBase64Url(iv),ciphertext:toBase64Url(ciphertext)};
}
export async function unlockBrowserRoomPlatform(proof: Uint8Array<ArrayBuffer>):Promise<string> {
  const record=await readRoomProtection();
  try {
    if(!record||record.method!=='platform')throw new Error('本机保护状态已改变');
    const key=await platformKey(proof,record.platform);
    const raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64Url(record.iv),additionalData:platformAad(record.platform)},key,fromBase64Url(record.ciphertext)));
    try {
      if(raw.length!==32||canonicalStringify(await readRoomProtection())!==canonicalStringify(record))throw new Error('应用锁已改变，请重试');
      const secret=toBase64Url(raw);held={revision:record.revision,secret};return secret;
    }finally{raw.fill(0);}
  }finally{proof.fill(0);}
}
