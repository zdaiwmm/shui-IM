import { Aes256Gcm, CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { canonicalStringify } from './canonical';
import { fromBase64Url, toBase64Url } from './base64';
import { verifyPersonalDeviceBinding, validPersonalPublicBundle, type PersonalDeviceBinding } from './personal-device-binding';
import { withPersonalKeys, type PersonalPublicIdentity } from './personal-identity';
import { bundleFingerprint } from './crypto';
import { validSpaceAvatar, type SpaceAvatar } from './space-avatar';
import type { PrivateIdentity, PublicBundle, RoomMember } from './types';
import type {ChamberLifecycle} from './chamber-lifecycle';
import type { ChamberHistoryHeadReference } from './chamber-history-record';

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const bytes = (x: unknown) => new TextEncoder().encode(canonicalStringify(x));
export type PersonalDirectoryEntry = { v: 1; roomId: string; role: 'creator' | 'joiner'; name: string; avatar?: SpaceAvatar;
  trustedMembers?:RoomMember[];lifecycle?:ChamberLifecycle;
  creatorFingerprint: string; heads: ChamberHistoryHeadReference[]; participants: { role: 'creator' | 'joiner'; binding: PersonalDeviceBinding; bundle: PublicBundle }[] };
export type PersonalDirectoryRecord = { v: 1; purpose: 'chamber-personal-directory-v1'; identityId: string; roomId: string; revision: number;
  sealed: { enc: string; ciphertext: string }; author: { binding: PersonalDeviceBinding; bundle: PublicBundle }; signature: string };
const context = (x: Pick<PersonalDirectoryRecord, 'identityId' | 'roomId' | 'revision'>) => bytes({ purpose: 'chamber-personal-directory-v1', identityId: x.identityId, roomId: x.roomId, revision: x.revision });

async function validateEntry(entry: PersonalDirectoryEntry, identity: PersonalPublicIdentity): Promise<void> {
  const fields = ['creatorFingerprint','heads','name','participants','role','roomId','v',...(entry?.avatar?['avatar']:[]),...(entry?.trustedMembers?['trustedMembers']:[]),...(entry?.lifecycle?['lifecycle']:[])].sort().join(',');
  if (!entry || Object.keys(entry).sort().join(',') !== fields || entry.v !== 1 || !['creator', 'joiner'].includes(entry.role) ||
    typeof entry.name !== 'string' || !entry.name.trim() || Array.from(entry.name).length > 40 ||
    !/^[0-9a-f-]{36}$/i.test(entry.roomId) || (entry.avatar && !validSpaceAvatar(entry.avatar)) ||
    !Array.isArray(entry.participants) || entry.participants.length < 1 || entry.participants.length > 2 ||
    !Array.isArray(entry.heads) || entry.heads.length > 1000 || entry.heads.some(h => !h || Object.keys(h).sort().join(',') !== 'afterSeq,deviceId,digest,id,revision,upperSeq' ||
      !/^[A-Za-z0-9_-]{43}$/.test(h.id) || !/^[A-Za-z0-9_-]{43}$/.test(h.digest) || !/^[0-9a-f-]{36}$/i.test(h.deviceId) ||
      !Number.isSafeInteger(h.revision) || h.revision < 1 || !Number.isSafeInteger(h.afterSeq) || h.afterSeq < 0 || !Number.isSafeInteger(h.upperSeq) || h.upperSeq < h.afterSeq)) throw new Error('身份目录内容不正确');
  const roles = new Set<string>(), identities = new Set<string>();
  if(entry.trustedMembers) {
    if(!Array.isArray(entry.trustedMembers)||entry.trustedMembers.length<1||entry.trustedMembers.length>1000)throw new Error('目录设备快照超过范围');
    const ids=new Set<string>();
    for(const m of entry.trustedMembers) {
      if(!m||Object.keys(m).sort().join(',')!=='addedBy,deviceId,encryptionKey,joinProof,joinReceiptSeq,joinSeq,mlsKeyPackage,role,signingKey,status'||ids.has(m.deviceId)||
        !['creator','joiner'].includes(m.role)||!['active','pending','revoked'].includes(m.status??'')||m.addedBy!==null&&!/^[0-9a-f-]{36}$/i.test(m.addedBy??'')||
        m.joinProof!==null&&!/^[A-Za-z0-9_-]{43}$/.test(m.joinProof??'')||!Number.isSafeInteger(m.joinSeq)||m.joinSeq!<0||!Number.isSafeInteger(m.joinReceiptSeq)||m.joinReceiptSeq!<0||
        !validPersonalPublicBundle({deviceId:m.deviceId,encryptionKey:m.encryptionKey,signingKey:m.signingKey,mlsKeyPackage:m.mlsKeyPackage}))throw new Error('目录设备快照无效或包含非公钥材料');
      ids.add(m.deviceId);
    }
  }
  if(entry.lifecycle&&(!Number.isSafeInteger(entry.lifecycle.version)||entry.lifecycle.version<1||!Number.isSafeInteger(entry.lifecycle.generation)||entry.lifecycle.generation<1||entry.lifecycle.closed))throw new Error('目录的密室生命周期无效');
  for (const person of entry.participants) {
    if (Object.keys(person).sort().join(',') !== 'binding,bundle,role' || !['creator', 'joiner'].includes(person.role) ||
      roles.has(person.role) || identities.has(person.binding.identity.id) || !await verifyPersonalDeviceBinding(person.binding, person.bundle)) throw new Error('身份目录的参与者绑定无法验证');
    roles.add(person.role); identities.add(person.binding.identity.id);
    if(entry.trustedMembers&&!entry.trustedMembers.some(member=>member.role===person.role&&canonicalStringify({deviceId:member.deviceId,encryptionKey:member.encryptionKey,signingKey:member.signingKey,mlsKeyPackage:member.mlsKeyPackage})===canonicalStringify(person.bundle)))throw new Error('目录参与者与设备快照不一致');
  }
  const own = entry.participants.find(p => p.role === entry.role), creator = entry.participants.find(p => p.role === 'creator');
  const anchor=entry.trustedMembers?.find(m=>m.role==='creator'&&!m.addedBy),creatorBundle=anchor?{deviceId:anchor.deviceId,encryptionKey:anchor.encryptionKey,signingKey:anchor.signingKey,mlsKeyPackage:anchor.mlsKeyPackage}:creator?.bundle;
  if (!own || !creator || canonicalStringify(own.binding.identity) !== canonicalStringify(identity) ||
    !creatorBundle||await bundleFingerprint(creatorBundle) !== entry.creatorFingerprint) throw new Error('身份目录归属无法验证');
}

/** Any already authorized local device can update its owner's encrypted directory using public keys only. */
export async function sealPersonalDirectory(entry: PersonalDirectoryEntry, revision: number, device: PrivateIdentity, binding: PersonalDeviceBinding): Promise<PersonalDirectoryRecord> {
  await validateEntry(entry, binding.identity);
  if (!Number.isSafeInteger(revision) || revision < 1 || !await verifyPersonalDeviceBinding(binding, device.publicBundle)) throw new Error('目录写入身份不正确');
  const base = { v: 1 as const, purpose: 'chamber-personal-directory-v1' as const, identityId: binding.identity.id, roomId: entry.roomId, revision };
  const raw = bytes(entry), info = context(base);
  try {
    if (raw.length > 2 * 1024 * 1024) throw new Error('身份目录超过大小限制');
    const recipientPublicKey = await suite.kem.deserializePublicKey(fromBase64Url(binding.identity.directoryKey));
    const sender = await suite.createSenderContext({ recipientPublicKey, info: info.buffer });
    const unsigned = { ...base, sealed: { enc: toBase64Url(sender.enc), ciphertext: toBase64Url(await sender.seal(raw.buffer, info.buffer)) },
      author: { binding, bundle: device.publicBundle } };
    const key = await crypto.subtle.importKey('jwk', device.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { ...unsigned, signature: toBase64Url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(unsigned))) };
  } finally { raw.fill(0); }
}

export async function openPersonalDirectory(record: PersonalDirectoryRecord, identity: PersonalPublicIdentity, entropy: Uint8Array, minimumRevision = 0): Promise<PersonalDirectoryEntry> {
  if (!record || Object.keys(record).sort().join(',') !== 'author,identityId,purpose,revision,roomId,sealed,signature,v' || record.v !== 1 ||
    record.purpose !== 'chamber-personal-directory-v1' || record.identityId !== identity.id ||
    !Number.isSafeInteger(record.revision) || record.revision < Math.max(1, minimumRevision) || !/^[0-9a-f-]{36}$/i.test(record.roomId) ||
    Object.keys(record.sealed).sort().join(',') !== 'ciphertext,enc' || !/^[A-Za-z0-9_-]{43}$/.test(record.sealed.enc) ||
    !/^[A-Za-z0-9_-]{22,2796224}$/.test(record.sealed.ciphertext) || !/^[A-Za-z0-9_-]{86}$/.test(record.signature) ||
    Object.keys(record.author).sort().join(',') !== 'binding,bundle' ||
    canonicalStringify(record.author.binding.identity) !== canonicalStringify(identity) || !await verifyPersonalDeviceBinding(record.author.binding, record.author.bundle)) throw new Error('身份目录签名或版本不正确');
  const { signature, ...unsigned } = record;
  const key = await crypto.subtle.importKey('jwk', record.author.bundle.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(signature), bytes(unsigned))) throw new Error('身份目录签名不正确');
  return withPersonalKeys(entropy, async keys => {
    if (canonicalStringify(keys.publicIdentity) !== canonicalStringify(identity)) throw new Error('助记词与身份不一致');
    const recipientKey = await suite.kem.deserializePrivateKey(keys.directorySecret), info = context(record), enc = fromBase64Url(record.sealed.enc), ct = fromBase64Url(record.sealed.ciphertext);
    const recipient = await suite.createRecipientContext({ recipientKey, enc: enc.buffer, info: info.buffer });
    const raw = new Uint8Array(await recipient.open(ct.buffer, info.buffer));
    try {
      const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as PersonalDirectoryEntry;
      await validateEntry(entry, identity); if (entry.roomId !== record.roomId) throw new Error('身份目录密室不一致'); return entry;
    } finally { raw.fill(0); }
  });
}
