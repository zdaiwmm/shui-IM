import { uiLiteral } from './language';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalStringify } from './canonical';
import { fromBase64Url, toBase64Url } from './base64';
import { sealJointHistoryKeyForDevice, useJointHistoryKey, type JointHistoryKeyEnvelope, type JointHistoryRelease, type VerifiedJointHistoryScope } from './joint-history-keys';
import type { PersonalDeviceBinding } from './personal-device-binding';
import type { PersonalProof, PersonalPublicIdentity } from './personal-identity';
import type { DecryptedMessage, PrivateIdentity } from './types';
import { verifyPersonalDeviceBinding } from './personal-device-binding';
import { isMessagePayload } from './message-payload';
import {normalizeGalleryCurationRecords,type GalleryCurationRecord} from './gallery-curation';

export type ChamberHistoryPayload = { v: 1; kind: 'messages'; roomId: string; ownerId: string;
  afterSeq: number; upperSeq: number; previous: { id: string; digest: string } | null;
  messages: DecryptedMessage[]; attachments: { blobId: string; index: number; unitId: string }[]; preferences?:string[]; omittedSafe?:number[] } |
  { v: 1; kind: 'attachment'; roomId: string; ownerId: string; blobId: string; index: number; bytes: string } |
  { v:1;kind:'preferences';roomId:string;ownerId:string;hiddenChatMessageIds:string[];galleryHidden:GalleryCurationRecord[] };
export type ChamberHistoryRecord = { v: 1; roomId: string; ownerId: string; id: string; revision: number;
  sealed: { iv: string; ciphertext: string }; keyEnvelope: JointHistoryKeyEnvelope };
export type ChamberHistoryHeadReference = { deviceId: string; id: string; digest: string; revision: number; afterSeq: number; upperSeq: number };
export type ChamberHistoryHead = { v: 1; purpose: 'chamber-history-head-v1'; roomId: string; ownerId: string;
  head: ChamberHistoryHeadReference; author: { binding: PersonalDeviceBinding; bundle: PrivateIdentity['publicBundle'] }; signature: string };
const bytes = (x: unknown) => new TextEncoder().encode(canonicalStringify(x));
export const chamberHistoryRecordHash = (record: ChamberHistoryRecord) => toBase64Url(sha256(bytes(record)));

export async function createChamberHistoryHead(record: ChamberHistoryRecord, afterSeq: number, upperSeq: number, device: PrivateIdentity, binding: PersonalDeviceBinding): Promise<ChamberHistoryHead> {
  const unsigned = { v: 1 as const, purpose: 'chamber-history-head-v1' as const, roomId: record.roomId, ownerId: record.ownerId,
    head: { deviceId: device.publicBundle.deviceId, id: record.id, digest: chamberHistoryRecordHash(record), revision: record.revision, afterSeq, upperSeq },
    author: { binding, bundle: device.publicBundle } };
  const key = await crypto.subtle.importKey('jwk', device.signingPrivateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return { ...unsigned, signature: toBase64Url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(unsigned))) };
}
export async function verifyChamberHistoryHead(value: ChamberHistoryHead, owner: PersonalPublicIdentity): Promise<boolean> {
  try {
    const h = value.head;
    if (Object.keys(value).sort().join(',') !== 'author,head,ownerId,purpose,roomId,signature,v' || value.v !== 1 || value.purpose !== 'chamber-history-head-v1' ||
      value.ownerId !== owner.id || !/^[0-9a-f-]{36}$/i.test(value.roomId) || Object.keys(h).sort().join(',') !== 'afterSeq,deviceId,digest,id,revision,upperSeq' ||
      !/^[A-Za-z0-9_-]{43}$/.test(h.id) || !/^[A-Za-z0-9_-]{43}$/.test(h.digest) || !Number.isSafeInteger(h.revision) || h.revision < 1 ||
      !Number.isSafeInteger(h.afterSeq) || h.afterSeq < 0 || !Number.isSafeInteger(h.upperSeq) || h.upperSeq < h.afterSeq ||
      h.deviceId !== value.author.bundle.deviceId || canonicalStringify(value.author.binding.identity) !== canonicalStringify(owner) ||
      !await verifyPersonalDeviceBinding(value.author.binding, value.author.bundle)) return false;
    const { signature, ...unsigned } = value;
    const key = await crypto.subtle.importKey('jwk', value.author.bundle.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64Url(signature), bytes(unsigned));
  } catch { return false; }
}
const scope = (roomId: string, ownerId: string, peerId: string, id: string, revision: number) =>
  bytes({ purpose: 'chamber-history-record-v1', roomId, ownerId, peerId, id, revision });
const messageFields=(p:Extract<ChamberHistoryPayload,{kind:'messages'}>)=>
  ['afterSeq','attachments','kind','messages','ownerId','previous','roomId','upperSeq','v',...(p.preferences!==undefined?['preferences']:[]),...(p.omittedSafe!==undefined?['omittedSafe']:[])].sort().join(',');

export function validChamberHistoryPayload(payload: ChamberHistoryPayload): boolean {
  try {
    if (!payload || payload.v !== 1 || !/^[0-9a-f-]{36}$/i.test(payload.roomId) || !/^[A-Za-z0-9_-]{43}$/.test(payload.ownerId)) return false;
    if(payload.kind==='preferences')return Object.keys(payload).sort().join(',')==='galleryHidden,hiddenChatMessageIds,kind,ownerId,roomId,v' &&
      Array.isArray(payload.hiddenChatMessageIds)&&payload.hiddenChatMessageIds.length<=1000&&new Set(payload.hiddenChatMessageIds).size===payload.hiddenChatMessageIds.length&&payload.hiddenChatMessageIds.every(id=>/^[0-9a-f-]{36}$/i.test(id))&&
      Array.isArray(payload.galleryHidden)&&payload.galleryHidden.length<=1000&&payload.galleryHidden.every(r=>r.hidden&&r.pinnedAt===null)&&canonicalStringify(payload.galleryHidden)===canonicalStringify(normalizeGalleryCurationRecords(payload.galleryHidden));
    if (payload.kind === 'attachment') return Object.keys(payload).sort().join(',') === 'blobId,bytes,index,kind,ownerId,roomId,v' &&
      /^[0-9a-f-]{36}$/i.test(payload.blobId) && Number.isSafeInteger(payload.index) && payload.index >= 0 && payload.index < 65_536 &&
      typeof payload.bytes === 'string' && /^[A-Za-z0-9_-]{22,2796224}$/.test(payload.bytes);
    if (payload.kind !== 'messages' || Object.keys(payload).sort().join(',') !== messageFields(payload) ||
      (payload.preferences!==undefined&&(!Array.isArray(payload.preferences)||payload.preferences.length>20||new Set(payload.preferences).size!==payload.preferences.length||!payload.preferences.every(id=>/^[A-Za-z0-9_-]{43}$/.test(id)))) ||
      !Number.isSafeInteger(payload.afterSeq) || payload.afterSeq < 0 || !Number.isSafeInteger(payload.upperSeq) || payload.upperSeq < payload.afterSeq ||
      !Array.isArray(payload.messages) || payload.messages.length > 100 || !Array.isArray(payload.attachments) || payload.attachments.length > 30_000 ||
      (payload.previous !== null && (!payload.previous || Object.keys(payload.previous).sort().join(',') !== 'digest,id' ||
        !/^[A-Za-z0-9_-]{43}$/.test(payload.previous.id) || !/^[A-Za-z0-9_-]{43}$/.test(payload.previous.digest)))) return false;
    const omitted=payload.omittedSafe??[];
    if(!Array.isArray(omitted)||omitted.length>100||omitted.some((seq,i)=>!Number.isSafeInteger(seq)||seq<=payload.afterSeq||seq>payload.upperSeq||i>0&&seq<=omitted[i-1]!))return false;
    let seq = payload.afterSeq;
    for (const message of payload.messages) {
      if (!message || Object.keys(message).sort().join(',') !== 'acceptedAt,clientMsgId,payload,senderId,seq,status' ||
        !Number.isSafeInteger(message.seq)||message.seq<=seq || !/^[0-9a-f-]{36}$/i.test(message.clientMsgId) || !/^[0-9a-f-]{36}$/i.test(message.senderId) ||
        !['stored', 'sent', 'delivered', 'pending', 'failed'].includes(message.status) || !Number.isFinite(Date.parse(message.acceptedAt)) || !isMessagePayload(message.payload)) return false;
      seq=message.seq;
    }
    const coverage=[...payload.messages.map(m=>m.seq),...omitted].sort((a,b)=>a-b);
    return coverage.length===payload.upperSeq-payload.afterSeq && coverage.every((n,i)=>n===payload.afterSeq+i+1) && payload.attachments.every(ref => ref && Object.keys(ref).sort().join(',') === 'blobId,index,unitId' &&
      /^[0-9a-f-]{36}$/i.test(ref.blobId) && Number.isSafeInteger(ref.index) && ref.index >= 0 && ref.index < 65_536 && /^[A-Za-z0-9_-]{43}$/.test(ref.unitId));
  } catch { return false; }
}

/** Explicit data-only serializer. No room vault or identity checkpoint is accepted by this API. */
export async function sealChamberHistoryRecord(payload: ChamberHistoryPayload, id: string, revision: number,
  peer: PersonalPublicIdentity, device: PrivateIdentity, binding: PersonalDeviceBinding): Promise<ChamberHistoryRecord> {
  if (payload.v !== 1 || !['messages', 'attachment','preferences'].includes(payload.kind) || payload.ownerId !== binding.identity.id ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(payload.roomId) || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) throw new Error(uiLiteral('历史备份范围不正确'));
  const expected = payload.kind === 'messages' ? messageFields(payload) : payload.kind==='preferences'?'galleryHidden,hiddenChatMessageIds,kind,ownerId,roomId,v':'blobId,bytes,index,kind,ownerId,roomId,v';
  if (Object.keys(payload).sort().join(',') !== expected) throw new Error(uiLiteral('历史备份包含未许可的字段'));
  if (!validChamberHistoryPayload(payload)) throw new Error(uiLiteral('历史备份的数据记录不正确'));
  const raw = bytes(payload), dataKey = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    if (raw.length > 3 * 1024 * 1024) throw new Error(uiLiteral('历史备份分块超过大小限制'));
    const key = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['encrypt']);
    const sealed = { iv: toBase64Url(iv), ciphertext: toBase64Url(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: scope(payload.roomId, payload.ownerId, peer.id, id, revision) }, key, raw)) };
    const keyEnvelope = await sealJointHistoryKeyForDevice(dataKey, { roomId: payload.roomId, backupId: id, revision,
      contentDigest: toBase64Url(sha256(bytes(sealed))), owner: binding.identity, peer }, device, binding);
    return { v: 1, roomId: payload.roomId, ownerId: payload.ownerId, id, revision, sealed, keyEnvelope };
  } finally { dataKey.fill(0); raw.fill(0); }
}

export async function openChamberHistoryRecord(record: ChamberHistoryRecord, pinnedOwner: PersonalPublicIdentity, pinnedPeer: PersonalPublicIdentity,
  request: PersonalProof, signature: string, release: JointHistoryRelease, ownerEntropy: Uint8Array, scopeGrant?: VerifiedJointHistoryScope, target?: PrivateIdentity): Promise<ChamberHistoryPayload> {
  if (!record || Object.keys(record).sort().join(',') !== 'id,keyEnvelope,ownerId,revision,roomId,sealed,v' || record.v !== 1 ||
    record.ownerId !== pinnedOwner.id || record.roomId !== record.keyEnvelope.context.roomId || record.id !== record.keyEnvelope.context.backupId ||
    record.revision !== record.keyEnvelope.context.revision || Object.keys(record.sealed).sort().join(',') !== 'ciphertext,iv' ||
    !/^[A-Za-z0-9_-]{16}$/.test(record.sealed.iv) || !/^[A-Za-z0-9_-]{22,4194326}$/.test(record.sealed.ciphertext) ||
    toBase64Url(sha256(bytes(record.sealed))) !== record.keyEnvelope.context.contentDigest) throw new Error(uiLiteral('历史备份完整性验证失败'));
  const context = { roomId: record.roomId, backupId: record.id, revision: record.revision,
    contentDigest: record.keyEnvelope.context.contentDigest, owner: pinnedOwner, peer: pinnedPeer };
  return useJointHistoryKey(record.keyEnvelope, context, request, signature, release, ownerEntropy, async dataKey => {
    const key = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['decrypt']);
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(record.sealed.iv),
      additionalData: scope(record.roomId, record.ownerId, pinnedPeer.id, record.id, record.revision) }, key, fromBase64Url(record.sealed.ciphertext)));
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as ChamberHistoryPayload;
      if (!validChamberHistoryPayload(value) || value.roomId !== record.roomId || value.ownerId !== record.ownerId) throw new Error(uiLiteral('历史备份内容归属不正确'));
      return value;
    } finally { raw.fill(0); }
  }, scopeGrant, target);
}
