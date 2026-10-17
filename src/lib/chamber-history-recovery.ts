import { canonicalStringify } from './canonical';
import { authorizedFetch } from './api';
import { fromBase64Url } from './base64';
import { signPersonalProof, type PersonalProof } from './personal-identity';
import { usePersonalIdentity, type StoredPersonalIdentity } from './personal-identity-vault';
import type { LocalCredentialResult } from './password-protection';
import { personalChallenge, readOwnPersonalDirectory, syncPersonalDirectory } from './personal-directory-sync';
import { jointHistoryEnvelopeHash, jointHistoryScopeHash, prepareJointHistoryScope, releaseJointHistoryLayer,
  type JointHistoryKeyEnvelope, type JointHistoryRelease, type JointHistoryScope } from './joint-history-keys';
import { chamberHistoryRecordHash, openChamberHistoryRecord, type ChamberHistoryRecord, type ChamberHistoryPayload } from './chamber-history-record';
import { importArchivedMessages, saveChamberRecoveredMediaChunk, loadCachedMediaChunk, cacheChamberHistoryCipher, loadChamberHistoryCipher, loadUiPreferences, saveUiPreferences, restoreGalleryHidden, saveVault, withVaultMutation, saveChamberRecoveryManifest, readChamberRecoveryManifest, type VaultSession } from './vault';
import { attachmentVerifier } from './local-history-backup';
import type { DecryptedMessage, ImageManifest } from './types';
import {verifyMigratedHistory} from './chamber-migrations';
import {authenticatedMlsCallMembers} from './call-membership';

export type ChamberHistoryRequest = { scope: JointHistoryScope; proof: PersonalProof; signature: string };
export type ChamberHistorySummary = { requestId:string; ownerId:string; peerId:string; targetId:string; expiresAt:string;
  scope:'chat'|'gallery'|'all'; unitCount:number; releasedCount:number; upperSeq:number };
type Unit = {id:string;envelope:JointHistoryKeyEnvelope;release?:JointHistoryRelease};
const base = (session:VaultSession) => `/api/rooms/${session.vault.roomId}/chamber-history-recovery`;
const same = (a:unknown,b:unknown) => canonicalStringify(a) === canonicalStringify(b);
async function api<T>(session:VaultSession,path:string,signal:AbortSignal,body?:unknown):Promise<T> {
  const response = await authorizedFetch(path,session.vault.accessToken,{signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),cache:'no-store',
    ...(body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  return response.json();
}
export const listChamberHistoryRequests = (session:VaultSession,signal:AbortSignal) => api<ChamberHistorySummary[]>(session,base(session),signal);
export const readChamberHistoryRequest = (session:VaultSession,id:string,signal:AbortSignal) => api<ChamberHistoryRequest>(session,`${base(session)}/${id}?manifest=1`,signal);
function participants(session:VaultSession) {
  const owner = session.vault.personalBinding?.identity, peer = session.vault.personalPeers?.find(p=>p.identity.id !== owner?.id)?.identity;
  if (!owner || !peer) throw new Error('双方身份尚未确认'); return {owner,peer};
}
export async function startChamberHistoryRecovery(session:VaultSession,stored:StoredPersonalIdentity,credential:LocalCredentialResult,
  scope:'chat'|'gallery'|'all',signal:AbortSignal):Promise<ChamberHistoryRequest> {
  const {owner,peer} = participants(session);
  if (!same(owner,stored.identity) || session.vault.role !== 'creator' && scope !== 'chat') throw new Error('恢复范围与本人权限不一致');
  const pending = session.vault.pendingChamberHistoryRecovery;
  if (pending) {
    const request = await readChamberRecoveryManifest<ChamberHistoryRequest>(session,pending);
    if (Date.parse(request.proof.expiresAt) > Date.now()) {
      if(request.scope.scope!==scope)throw new Error('已有其他范围的恢复申请，请先完成或等待本次申请结束');
      prepareJointHistoryScope(request.scope,request.proof,request.signature,owner,peer);
      await api(session,base(session),signal,request); return request;
    }
  }
  await syncPersonalDirectory(session,signal);
  const directory = await readOwnPersonalDirectory(stored,credential,signal,new Map([[session.vault.roomId,session.vault.personalDirectoryRevision ?? 0]]));
  const entry = directory.find(e=>e.roomId === session.vault.roomId);
  if (!entry?.heads.length) throw new Error('尚无已验证的本人历史备份');
  const heads = new Map(entry.heads.map(head=>[head.deviceId,head]));
  const units:JointHistoryScope['units'] = []; let after = 0;
  for (;;) {
    const rows = await api<{cursor:number;id:string;deviceId:string;revision:number;envelope:JointHistoryKeyEnvelope}[]>(session,`/api/rooms/${session.vault.roomId}/chamber-history?after=${after}`,signal);
    if (!Array.isArray(rows) || rows.length > 100) throw new Error('备份列表不正确');
    for (const row of rows) {
      if (!Number.isSafeInteger(row.cursor) || row.cursor <= after) throw new Error('备份列表顺序不正确'); after = row.cursor;
      if (row.revision <= (heads.get(row.deviceId)?.revision ?? 0)) units.push({id:row.id,deviceId:row.deviceId,revision:row.revision,envelopeHash:jointHistoryEnvelopeHash(row.envelope)});
      if (units.length > 50_000) throw new Error('本次恢复超过分块上限');
    }
    if (rows.length < 100) break;
  }
  const generation=session.vault.chamberLifecycle?.generation??1;
  const snapshot:JointHistoryScope = {v:1,purpose:'chamber-joint-history-scope-v1',roomId:session.vault.roomId,ownerId:owner.id,peerId:peer.id,
    scope,generation,target:session.vault.identity.publicBundle,heads:entry.heads,units};
  const proof = await personalChallenge(owner.id,{action:'restore-history',roomId:session.vault.roomId,deviceId:snapshot.target.deviceId,version:generation,payloadHash:jointHistoryScopeHash(snapshot)},signal);
  const signature = await usePersonalIdentity(stored,credential,entropy=>signPersonalProof(entropy,proof));
  const request = {scope:snapshot,proof,signature}; prepareJointHistoryScope(snapshot,proof,signature,owner,peer);
  await saveChamberRecoveryManifest(session,proof.requestId,request,signal);
  await withVaultMutation(session,async mutation=> {
    signal.throwIfAborted(); const before = session.vault.pendingChamberHistoryRecovery; session.vault.pendingChamberHistoryRecovery = proof.requestId;
    try { await saveVault(session,mutation); } catch(cause) { session.vault.pendingChamberHistoryRecovery=before; throw cause; }
  });
  await api(session,base(session),signal,request); return request;
}
async function verifyRequest(session:VaultSession,request:ChamberHistoryRequest,peerOperation:boolean) {
  const roots = participants(session), owner = peerOperation ? roots.peer : roots.owner, peer = peerOperation ? roots.owner : roots.peer;
  const members=await authenticatedMlsCallMembers(session.vault);
  if (request.scope.roomId !== session.vault.roomId || request.scope.generation !== (session.vault.chamberLifecycle?.generation??1) ||
    ((peerOperation ? session.vault.role === 'creator' : session.vault.role === 'joiner') && request.scope.scope !== 'chat') ||
    !members.some(m=>m.status === 'active' && m.deviceId === request.scope.target.deviceId &&
      same(m.encryptionKey,request.scope.target.encryptionKey) && same(m.signingKey,request.scope.target.signingKey) && m.mlsKeyPackage === request.scope.target.mlsKeyPackage &&
      m.role === (peerOperation ? session.vault.role === 'creator' ? 'joiner' : 'creator' : session.vault.role))) throw new Error('恢复申请的接收设备未获双方批准');
  return {owner,peer,grant:prepareJointHistoryScope(request.scope,request.proof,request.signature,owner,peer)};
}
export async function approveChamberHistoryRecovery(session:VaultSession,request:ChamberHistoryRequest,stored:StoredPersonalIdentity,credential:LocalCredentialResult,
  signal:AbortSignal,progress:(count:number,total:number)=>void):Promise<void> {
  const {owner,peer,grant} = await verifyRequest(session,request,true);
  if (!same(stored.identity,peer)) throw new Error('请使用对方原始参与者身份批准');
  let count=0;
  for (let after=0;after<request.scope.units.length;after+=100) {
    const rows = await api<Unit[]>(session,`${base(session)}/${request.proof.requestId}?after=${after}`,signal);
    if (rows.length !== Math.min(100,request.scope.units.length-after)) throw new Error('恢复分块缺失');
    for (const row of rows) {
      signal.throwIfAborted();
      if (!row.release) {
        const release = await usePersonalIdentity(stored,credential,entropy=>releaseJointHistoryLayer(row.envelope,{...row.envelope.context,owner,peer},request.proof,request.signature,entropy,grant));
        await api(session,`${base(session)}/${request.proof.requestId}`,signal,{unitId:row.id,release});
      }
      progress(++count,request.scope.units.length);
    }
  }
}
const manifests = (message:DecryptedMessage):ImageManifest[] => {
  const p=message.payload; return 'images' in p ? p.images : 'image' in p ? [p.image] : 'file' in p ? [p.file] : 'audio' in p ? [p.audio] : [];
};
/** Walk authenticated predecessor links. Each message block and all its original
 * attachments are verified before importing it. Missing earlier blocks leave
 * already verified local content intact and report incomplete restoration. */
export async function completeChamberHistoryRecovery(session:VaultSession,request:ChamberHistoryRequest,stored:StoredPersonalIdentity,credential:LocalCredentialResult,
  signal:AbortSignal,progress:(count:number,total:number)=>void):Promise<number> {
  const {owner,peer,grant}=await verifyRequest(session,request,false);
  if (!same(stored.identity,owner) || !same(request.scope.target,session.vault.identity.publicBundle)) throw new Error('恢复结果只交给申请的本机设备');
  const releases=new Map<string,JointHistoryRelease>();
  for (let after=0;after<request.scope.units.length;after+=100) {
    const rows=await api<Unit[]>(session,`${base(session)}/${request.proof.requestId}?after=${after}`,signal);
    for (const row of rows) { if (!row.release) throw new Error('等待对方共同解密，请联系对方在30分钟内完成'); releases.set(row.id,row.release); }
  }
  const units=new Map(request.scope.units.map(unit=>[unit.id,unit])), seen=new Set<string>();
  let checkpoint=session.vault.chamberHistoryRestoreProgress;
  if(checkpoint?.requestId!==request.proof.requestId||checkpoint.scopeHash!==request.proof.payloadHash)checkpoint={requestId:request.proof.requestId,scopeHash:request.proof.payloadHash,doneHeads:[],count:0,imported:0};
  let imported=checkpoint.imported,count=checkpoint.count;
  const saveProgress=async()=>withVaultMutation(session,async mutation=>{
    signal.throwIfAborted();const previous=session.vault.chamberHistoryRestoreProgress;session.vault.chamberHistoryRestoreProgress=structuredClone(checkpoint!);
    try{await saveVault(session,mutation);}catch(cause){session.vault.chamberHistoryRestoreProgress=previous;throw cause;}
  });
  const open=async (id:string):Promise<{record:ChamberHistoryRecord;payload:ChamberHistoryPayload}> => {
    signal.throwIfAborted(); const unit=units.get(id), release=releases.get(id);
    if (!unit || !release) throw new Error('历史备份链不完整');
    const cached=await loadChamberHistoryCipher(session,id);
    const record=cached??await api<ChamberHistoryRecord>(session,`/api/rooms/${session.vault.roomId}/chamber-history/${id}`,signal);
    if (record.id !== id || record.revision !== unit.revision || jointHistoryEnvelopeHash(record.keyEnvelope) !== unit.envelopeHash) throw new Error('历史备份分块被替换');
    const payload=await usePersonalIdentity(stored,credential,entropy=>openChamberHistoryRecord(record,owner,peer,request.proof,request.signature,release,entropy,grant,session.vault.identity));
    if(!cached)await cacheChamberHistoryCipher(session,record,signal);
    return {record,payload};
  };
  for (const head of request.scope.heads) {
    if(checkpoint.doneHeads.includes(head.id))continue;
    let next:{id:string;digest:string}|null=checkpoint.current?.headId===head.id?checkpoint.current.next:{id:head.id,digest:head.digest};
    let upper:number=checkpoint.current?.headId===head.id?checkpoint.current.upper:head.upperSeq;
    while(next) {
      if (seen.has(next.id)) throw new Error('历史备份链出现重复'); seen.add(next.id);
      const {record,payload}=await open(next.id);
      if (chamberHistoryRecordHash(record) !== next.digest || payload.kind !== 'messages' || payload.upperSeq !== upper || record.keyEnvelope.author?.bundle.deviceId !== head.deviceId) throw new Error('历史备份链或范围不完整');
      for(const id of payload.preferences??[]) {
        const metadata=(await open(id)).payload;
        if(metadata.kind!=='preferences'||session.vault.role!=='creator'&&metadata.galleryHidden.length)throw new Error('历史备份删除标记的归属不正确');
        if(request.scope.scope!=='gallery') {
          const preferences=await loadUiPreferences(session),hiddenChatMessageIds=[...new Set([...(preferences.hiddenChatMessageIds??[]),...metadata.hiddenChatMessageIds].map(id=>id.toLowerCase()))];
          if(hiddenChatMessageIds.length>20_000)throw new Error('聊天删除标记超过本版恢复上限，已保留本机已有记录');
          await saveUiPreferences(session,{...preferences,hiddenChatMessageIds});
        }
        if(request.scope.scope!=='chat')await restoreGalleryHidden(session,metadata.galleryHidden,signal);
      }
      const chunks=new Map(payload.attachments.map(ref=>[`${ref.blobId}:${ref.index}`,ref.unitId]));
      for (const message of payload.messages) for (const manifest of manifests(message)) {
        if (request.scope.scope === 'chat' && ['gallery-image','gallery-file'].includes(message.payload.kind)) continue;
        const verifier=await attachmentVerifier(manifest);
        // First pass verifies the entire original; second pass persists only
        // verified encrypted chunks, with no reconstructed plaintext file.
        for(let pass=0;pass<2;pass++) for(let index=0;index<manifest.chunkCount;index++) {
          const id=chunks.get(`${manifest.blobId}:${index}`); if(!id) throw new Error('历史备份原文件分块缺失');
          const part=(await open(id)).payload;
          if(part.kind !== 'attachment' || part.blobId !== manifest.blobId || part.index !== index) throw new Error('历史备份原文件归属不正确');
          const raw=fromBase64Url(part.bytes);
          if(pass===0) { await verifier.chunk(index,raw.buffer); if(index===manifest.chunkCount-1) verifier.finish(); }
          else {
            await saveChamberRecoveredMediaChunk(session,manifest.blobId,index,raw.buffer,signal);
            const readback=await loadCachedMediaChunk(session,manifest.blobId,index,raw.length);
            if(!readback||new Uint8Array(readback).some((byte,i)=>byte!==raw[i]))throw new Error('本机容量不足，原文件未能完整回读。已保留经过验证的旧记录，请腾出空间后继续恢复');
          }
        }
      }
      imported+=await importArchivedMessages(session,payload.messages,request.scope.scope,signal);
      progress(++count,request.scope.units.length); upper=payload.afterSeq; next=payload.previous;
      if(count>request.scope.units.length)throw new Error('恢复进度超出已批准范围');
      checkpoint={...checkpoint,current:{headId:head.id,next,upper},count,imported};await saveProgress();
    }
    checkpoint={...checkpoint,doneHeads:[...checkpoint.doneHeads,head.id],current:undefined,count,imported};await saveProgress();
  }
  await verifyMigratedHistory(session,request,stored,credential,signal);
  await withVaultMutation(session,async mutation=>{signal.throwIfAborted(); session.vault.pendingChamberHistoryRecovery=undefined;session.vault.chamberHistoryRestoreProgress=undefined; await saveVault(session,mutation);});
  return imported;
}
