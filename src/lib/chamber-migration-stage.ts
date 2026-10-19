import {sha256} from '@noble/hashes/sha2.js';
import {fromBase64Url,toBase64Url} from './base64';
import {canonicalStringify} from './canonical';
import {loadChamberHistoryPageAfter,loadCachedMediaChunk,loadUiPreferences,saveVault,withVaultMutation,discardChamberMigrationStage,type VaultSession} from './vault';
import {attachmentVerifier} from './local-history-backup';
import type {ChamberHistoryRequest} from './chamber-history-recovery';

const hash=(value:unknown)=>toBase64Url(sha256(new TextEncoder().encode(canonicalStringify(value))));
const projection=async(session:VaultSession)=>{
  const p=await loadUiPreferences(session);
  return {hiddenChatMessageIds:[...(p.hiddenChatMessageIds??[])].sort(),galleryHidden:session.vault.role==='creator'?
    (p.galleryCuration??[]).filter(r=>r.hidden).map(r=>({...r,pinnedAt:null})).sort((a,b)=>canonicalStringify(a).localeCompare(canonicalStringify(b))):[]};
};
async function snapshot(session:VaultSession,upperSeq:number,signal:AbortSignal,verifyAttachments=false) {
  const digest=sha256.create(),verifiedFiles=new Set<string>();let after=0,count=0;
  for(;;){
    signal.throwIfAborted();const rows=await loadChamberHistoryPageAfter(session,after,signal);
    for(const row of rows){after=row.seq;if(row.seq>upperSeq)continue;
      if(session.vault.role==='joiner'&&['gallery-image','gallery-file'].includes(row.payload.kind))continue;
      if(verifyAttachments){
        const p=row.payload,files='images'in p?p.images:'image'in p?[p.image]:'file'in p?[p.file]:'audio'in p?[p.audio]:[];
        for(const file of files){
          const identity=canonicalStringify(file);if(verifiedFiles.has(identity))continue;
          const verifier=await attachmentVerifier(file);
          for(let index=0;index<file.chunkCount;index++){
            signal.throwIfAborted();const size=Math.min(file.chunkSize,file.originalSize-index*file.chunkSize)+16;
            const bytes=await loadCachedMediaChunk(session,file.blobId,index,size);
            if(!bytes)throw new Error('暂存原文件未能完整回读，请腾出本机容量后继续验证');
            await verifier.chunk(index,bytes);
          }
          verifier.finish();verifiedFiles.add(identity);
        }
      }
      digest.update(new TextEncoder().encode(canonicalStringify({seq:row.seq,clientMsgId:row.clientMsgId,senderId:row.senderId,acceptedAt:row.acceptedAt,payload:row.payload})));count++;
    }
    if(rows.length<20||after>=upperSeq)break;
  }
  return hash({records:toBase64Url(digest.digest()),count,projection:await projection(session),upperSeq});
}
/** Independent empty namespace and random key. Its contents can only come from
 * the jointly opened cloud records, never a copy of the source plaintext. */
export async function migrationRecoveryDestination(source:VaultSession,request:ChamberHistoryRequest,signal:AbortSignal):Promise<VaultSession> {
  if(!source.vault.personalMigration||request.scope.scope!==(source.vault.role==='creator'?'all':'chat'))return source;
  await withVaultMutation(source,async mutation=>{
    const migration=source.vault.personalMigration!;
    if(migration.stage?.requestId===request.proof.requestId&&migration.stage.scopeHash===request.proof.payloadHash)return;
    await discardChamberMigrationStage(source,mutation);
    signal.throwIfAborted();migration.stage={requestId:request.proof.requestId,scopeHash:request.proof.payloadHash,dataScope:crypto.randomUUID(),master:toBase64Url(crypto.getRandomValues(new Uint8Array(32)))};
    source.vault.chamberHistoryRestoreProgress=undefined;await saveVault(source,mutation);
  });
  return openMigrationStage(source);
}
export async function openMigrationStage(source:VaultSession):Promise<VaultSession> {
  const stage=source.vault.personalMigration?.stage;if(!stage)throw new Error('本机迁移暂存区缺失，请重新验证历史');
  const bytes=fromBase64Url(stage.master);
  try{return {get stored(){return source.stored;},key:await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']),
    vault:{...source.vault,localDataScope:stage.dataScope}};}finally{bytes.fill(0);}
}
export async function verifyMigrationStage(source:VaultSession,destination:VaultSession,request:ChamberHistoryRequest,signal:AbortSignal):Promise<string> {
  const upperSeq=Math.max(...request.scope.heads.map(h=>h.upperSeq));
  if(source.vault.lastSeq!==upperSeq)throw new Error('聊天记录已变化，请完成备份后重新验证同一最新快照');
  const expected=await snapshot(source,upperSeq,signal),actual=await snapshot(destination,upperSeq,signal,true);
  if(expected!==actual)throw new Error('云端恢复与原设备的聊天、保险箱或删除记录不完整，已保留原数据，请补齐备份后重试');
  await withVaultMutation(source,async mutation=>{signal.throwIfAborted();source.vault.personalMigration!.stage!.digest=actual;await saveVault(source,mutation);});
  return actual;
}
export async function assertMigrationSourceCurrent(session:VaultSession,signal:AbortSignal):Promise<void> {
  const source=session.vault.migrationSource??session.vault,stage=source.personalMigration?.stage;
  if(!stage?.digest)throw new Error('请先在原设备完成云端历史完整性验证');
  const upper=source.lastSeq,current=await snapshot({...session,vault:source},upper,signal);
  if(current!==stage.digest)throw new Error('本机历史或删除记录已变化，请返回原空间重新备份和验证');
}
