import { ApiError, authorizedFetch, fetchBlobChunk } from './api';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { isMessagePayload } from './message-payload';
import { attachmentVerifier } from './local-history-backup';
import { archiveObjectHash, archiveAccessToken, archiveWriterProof, openArchiveObject, sealArchiveObject, type ArchiveKey, type ArchiveObject } from './room-archive-crypto';
import { loadCachedMediaChunk, loadChamberHistoryPageAfter, saveVault, withVaultMutation, stagePrivateArchiveItem, stagePrivateArchiveMedia, loadStagedPrivateArchiveMedia, commitPrivateArchiveImport, discardPrivateArchiveStaging, collectAbandonedPrivateArchiveImports, scanPrivateArchiveItems, loadPrivateArchiveItem, readPrivateCatalogMeta, loadPrivateMediaChunk, type VaultSession } from './vault';
import type { DecryptedMessage, ImageManifest } from './types';

export type PrivateArchiveItem = { originRoomId: string; message: DecryptedMessage; self: boolean; sourceScope: string };
type Ref = { id: string; hash: string };
type Media = { manifest: ImageManifest; parts: Ref[] };
type Batch = { kind: 'batch'; v: 2; revision: number; previous: Ref | null; item: Omit<PrivateArchiveItem, 'sourceScope'>; media: Media[] };
type MediaPayload = { kind: 'media'; v: 2; blobId: string; index: number; bytes: string };
export type RoomArchiveState = { privateScan?:{revision:string;afterId:string}; lastComplete?: { archiveId:string; scope:string; sharedThrough:number; privateRevision:string; revision:number; at:string }; cursor: number; revision: number; head?: Ref; syncedAt?: string; completeAt?: string; counts?: ArchiveCounts; countsRevision?: number; preparing?: { itemId: string; privateId?:string; sharedSeq?:number; privateRevision?:string; media: Media[]; next?: ArchiveObject }; pending?: { object: ArchiveObject; cursor?: number; privateId?: string; head: Ref; privateRevision?:string }; privateDone?: string[] };
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const manifests = (message: DecryptedMessage): ImageManifest[] => {
  const p=message.payload;return 'images' in p?p.images:'image' in p?[p.image]:'file' in p?[p.file]:'audio' in p?[p.audio]:[];
};
const itemId = (item: Pick<PrivateArchiveItem,'originRoomId'|'message'>) => `${item.originRoomId}:${item.message.clientMsgId}`;
const countKinds = ['messages','images','videos','audio','files'] as const;
const emptyCounts = (): ArchiveCounts => ({messages:0,images:0,videos:0,audio:0,files:0});
function countBatch(batch: Batch): ArchiveCounts {
  const counts=emptyCounts();counts.messages=1;
  for(const {manifest} of batch.media){
    const kind=manifest.mimeType?.startsWith('image/')?'images':manifest.mimeType?.startsWith('video/')?'videos':manifest.mimeType?.startsWith('audio/')?'audio':'files';counts[kind]++;
  }
  return counts;
}
/** Count only the committed chain authenticated by this browser's saved head.
 * Older archives read batch envelopes, never re-download the original media. */
export async function readRoomArchiveCounts(session:VaultSession,signal:AbortSignal):Promise<ArchiveCounts> {
  const archive=session.vault.roomArchiveV2;if(!archive)throw new Error('此密室不支持本人归档');
  const snapshot=structuredClone(session.vault.archiveState??{cursor:0,revision:0});
  if(snapshot.countsRevision===snapshot.revision&&snapshot.counts&&countKinds.every(kind=>Number.isSafeInteger(snapshot.counts![kind])&&snapshot.counts![kind]>=0))return snapshot.counts;
  const counts=emptyCounts();let ref=snapshot.head,revision=snapshot.revision;
  if(!Number.isSafeInteger(revision)||revision<0||Boolean(ref)!==(revision>0))throw new Error('备份状态暂不可用');
  while(ref){
    signal.throwIfAborted();
    if(!uuid.test(ref.id)||typeof ref.hash!=='string')throw new Error('备份状态暂不可用');
    const object=await get<ArchiveObject>(archive.key,`/${ref.id}`,signal);
    if(archiveObjectHash(object)!==ref.hash)throw new Error('备份统计校验失败');
    const batch=await openArchiveObject(archive.key,object) as Batch;
    if(batch?.v!==2||batch.kind!=='batch'||batch.revision!==revision||!batch.item||typeof batch.item.self!=='boolean'||!uuid.test(batch.item.originRoomId)||!isMessagePayload(batch.item.message?.payload)||!Array.isArray(batch.media)||batch.media.length>100||canonicalStringify(manifests(batch.item.message))!==canonicalStringify(batch.media.map(media=>media.manifest)))throw new Error('备份统计校验失败');
    const next=countBatch(batch);for(const kind of Object.keys(counts) as Array<keyof ArchiveCounts>)counts[kind]+=next[kind];
    revision--;
    if(revision===0){if(batch.previous!==null)throw new Error('备份链不完整');ref=undefined;}
    else {if(!batch.previous||!uuid.test(batch.previous.id)||typeof batch.previous.hash!=='string')throw new Error('备份链不完整');ref=batch.previous;}
  }
  if(revision!==0)throw new Error('备份链不完整');
  await update(session,signal,state=>{
    if(state.revision!==snapshot.revision||state.head?.id!==snapshot.head?.id)throw new DOMException('备份状态已更新','AbortError');
    state.counts=counts;state.countsRevision=state.revision;
  });
  return counts;
}
function sourceSession(session: VaultSession, scope: string): VaultSession { return {...session,get stored(){return session.stored;},vault:{...session.vault,localDataScope:scope}}; }
export const privateItemSession = (session:VaultSession,item:PrivateArchiveItem) => sourceSession(session,item.sourceScope);
async function update(session:VaultSession,signal:AbortSignal,change:(state:RoomArchiveState)=>void|Promise<void>) {
  await withVaultMutation(session,async mutation=>{
    signal.throwIfAborted();const previous=session.vault.archiveState;
    const next=structuredClone(previous??{cursor:session.vault.historyUnavailableBeforeSeq??0,revision:0});await change(next);signal.throwIfAborted();session.vault.archiveState=next;
    try{await saveVault(session,mutation);}catch(e){session.vault.archiveState=previous;throw e;}
    if(typeof window!=='undefined')window.dispatchEvent(new Event('quiet-room:archive-progress'));
  });
}
async function put(session:VaultSession,key:ArchiveKey,object:ArchiveObject|undefined,signal:AbortSignal) {
  const path=`/api/rooms/${session.vault.roomId}/private-archives/${key.descriptor.id}${object?`/${object.id}`:''}`;
  await authorizedFetch(path,session.vault.accessToken,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(object??{descriptor:key.descriptor,proof:archiveWriterProof(key,session.vault.roomId,session.vault.identity.publicBundle.deviceId)}),signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)])});
  if(object){const readback=await get<ArchiveObject>(key,`/${object.id}`,signal);if(archiveObjectHash(readback)!==archiveObjectHash(object))throw new Error('备份回读校验失败，请保留本机数据后重试');}
}
async function readPart(session:VaultSession,manifest:ImageManifest,index:number,signal:AbortSignal,localOnly:boolean) {
  const size=Math.min(manifest.chunkSize,manifest.originalSize-index*manifest.chunkSize)+16;
  const cached=await (localOnly?loadPrivateMediaChunk:loadCachedMediaChunk)(session,manifest.blobId,index,size);
  if(cached)return cached;
  if(localOnly)throw new Error('原文件尚未完整恢复，请先完成恢复后重试备份');
  return fetchBlobChunk(session.vault.roomId,session.vault.accessToken,manifest.blobId,index,signal);
}
async function prepare(session:VaultSession,key:ArchiveKey,item:PrivateArchiveItem,signal:AbortSignal,localOnly:boolean,privateRevision:string):Promise<NonNullable<RoomArchiveState['pending']>> {
  const source=sourceSession(session,item.sourceScope);
  const identity=itemId(item);
  if (!session.vault.archiveState?.preparing) await update(session,signal,s=>{s.preparing={itemId:identity,media:[],...(localOnly?{privateId:identity,privateRevision}:{sharedSeq:item.message.seq})};delete s.completeAt;});
  if (session.vault.archiveState!.preparing!.itemId!==identity) throw new Error('备份来源已改变，请保留本机数据');
  for (const [mediaIndex,manifest] of manifests(item.message).entries()) {
    // Verify the original incrementally before publishing a manifest. Only one
    // encrypted chunk is retained in the vault during crash-safe upload.
    const verifier=await attachmentVerifier(manifest);
    for(let index=0;index<manifest.chunkCount;index++) {
      signal.throwIfAborted();await verifier.chunk(index,await readPart(source,manifest,index,signal,localOnly));
    }
    verifier.finish();
    if(!session.vault.archiveState!.preparing!.media[mediaIndex]) await update(session,signal,s=>{s.preparing!.media.push({manifest,parts:[]});});
    for(let index=session.vault.archiveState!.preparing!.media[mediaIndex]!.parts.length;index<manifest.chunkCount;index++) {
      signal.throwIfAborted();
      if(!session.vault.archiveState!.preparing!.next) {
        const raw=await readPart(source,manifest,index,signal,localOnly);
        const next=await sealArchiveObject(key,{v:2,kind:'media',blobId:manifest.blobId,index,bytes:toBase64Url(raw)} satisfies MediaPayload);
        await update(session,signal,s=>{s.preparing!.next=next;});
      }
      const next=session.vault.archiveState!.preparing!.next!;
      await put(session,key,next,signal);
      await update(session,signal,s=>{s.preparing!.media[mediaIndex]!.parts.push({id:next.id,hash:archiveObjectHash(next)});delete s.preparing!.next;});
    }
  }
  const media=session.vault.archiveState!.preparing!.media;
  const state=session.vault.archiveState;
  const object=await sealArchiveObject(key,{v:2,kind:'batch',revision:(state?.revision??0)+1,previous:state?.head??null,
    item:{originRoomId:item.originRoomId,message:{...item.message,status:'stored'},self:item.self},media} satisfies Batch);
  return {object,head:{id:object.id,hash:archiveObjectHash(object)},...(localOnly?{privateId:itemId(item),privateRevision:session.vault.archiveState!.preparing!.privateRevision}:{cursor:item.message.seq})};
}
/** Foreground-only. A durable encrypted pending batch precedes every network write. */
export async function syncRoomArchive(session:VaultSession,signal:AbortSignal):Promise<import('./archive-backup-state').BackupOutcome> {
  const key=session.vault.roomArchiveV2?.key;if(!key||session.vault.roomArchiveV2?.rotation||session.vault.pairingState!=='ready')return {kind:'paused',reason:session.vault.roomArchiveV2?.rotation?'凭证更新待完成':'会话尚未就绪'};
  const privateMeta=await readPrivateCatalogMeta(session,signal);
  await put(session,key,undefined,signal);
  for(let pass=0;pass<10;pass++) {
    signal.throwIfAborted();
    if(!session.vault.archiveState?.pending) {
      const after=session.vault.archiveState?.cursor??session.vault.historyUnavailableBeforeSeq??0;
      const preparation=session.vault.archiveState?.preparing;
      const rows=preparation?.privateId?[]:await loadChamberHistoryPageAfter(session,after,signal);
      const row=rows[0];let item:PrivateArchiveItem|undefined;let localOnly=false;
      if(preparation?.privateId){item=await loadPrivateArchiveItem(session,preparation.privateId,signal)??undefined;localOnly=true;if(!item)throw new Error('待传私有记录缺失，请保留本机数据');}
      else if(row) {
        if(row.seq!==after+1){const boundary=session.vault.historyUnavailableBeforeSeq??0;if(after<boundary){await update(session,signal,s=>{s.cursor=Math.min(row.seq-1,boundary);});continue;}throw new Error('部分记录尚未备份，请保留本机数据后重试');}
        if(session.vault.role!=='creator'&&['gallery-image','gallery-file'].includes(row.payload.kind)) {await update(session,signal,s=>{s.cursor=row.seq;});continue;}
        const sender=session.vault.members.find(m=>m.deviceId===row.senderId);if(!sender)throw new Error('记录发送者身份不完整，请保留本机记录');
        item={originRoomId:session.vault.roomId,message:row,self:sender.role===session.vault.role,sourceScope:session.vault.localDataScope??session.vault.roomId};
      } else {
        if(after<session.vault.lastSeq){const boundary=session.vault.historyUnavailableBeforeSeq??0;if(after<boundary){await update(session,signal,s=>{s.cursor=boundary;});continue;}throw new Error('部分记录尚未备份，请保留本机数据后重试');}
        const done=new Set(session.vault.archiveState?.privateDone??[]);
        for await(const candidate of scanPrivateArchiveItems(session,{signal,exclude:done,afterId:session.vault.archiveState?.privateScan?.revision===privateMeta.revision?session.vault.archiveState.privateScan.afterId:undefined})){item=candidate;break;}localOnly=true;
      }
      if(preparation&&(!item||itemId(item)!==preparation.itemId)){const original=await loadPrivateArchiveItem(session,preparation.itemId,signal);if(original&&!preparation.sharedSeq){item=original;localOnly=true;}else throw new Error('备份来源已改变，请保留本机数据');}
      if(item&&preparation?.sharedSeq!==undefined&&(localOnly||item.message.seq!==preparation.sharedSeq))throw new Error('备份共享记录序号不一致，请保留本机数据');
      if(!item){
        await update(session,signal,async s=>{
          if((await readPrivateCatalogMeta(session,signal)).revision!==privateMeta.revision)throw new DOMException('私有历史已更新，请继续备份','AbortError');
          if(s.cursor<session.vault.lastSeq)throw new DOMException('新增记录等待备份','AbortError');
          s.completeAt=new Date().toISOString();s.lastComplete={archiveId:key.descriptor.id,scope:session.vault.localDataScope??session.vault.roomId,sharedThrough:session.vault.lastSeq,privateRevision:privateMeta.revision,revision:s.revision,at:s.completeAt};
        });return {kind:'complete'};
      }
      const pending=await prepare(session,key,item,signal,localOnly,privateMeta.revision);
      await update(session,signal,s=>{s.pending=pending;delete s.preparing;});
    }
    const pending=session.vault.archiveState!.pending!;
    signal.throwIfAborted();await put(session,key,pending.object,signal);
    const delta=countBatch(await openArchiveObject(key,pending.object) as Batch);
    await update(session,signal,s=>{
      if(s.pending?.head.id!==pending.head.id)throw new Error('备份任务已改变');
      if(s.counts&&s.countsRevision===s.revision){for(const kind of Object.keys(delta) as Array<keyof ArchiveCounts>)s.counts[kind]+=delta[kind];s.countsRevision=s.revision+1;}
      s.head=pending.head;s.revision++;if(pending.cursor!==undefined)s.cursor=pending.cursor;
      if(pending.privateId){s.privateDone=[...new Set([...(s.privateDone??[]),pending.privateId])];if(pending.privateRevision)s.privateScan={revision:pending.privateRevision,afterId:pending.privateId};}
      s.syncedAt=new Date().toISOString();delete s.pending;
    });
  }
  return {kind:'partial'};
}
async function get<T>(key:ArchiveKey,suffix:string,signal:AbortSignal):Promise<T> {
  for(let attempt=0;;attempt++) {
    try {
      const response=await authorizedFetch(`/api/private-archives/${key.descriptor.id}${suffix}`,archiveAccessToken(key),{cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)])});return await response.json();
    }catch(cause){
      if(signal.aborted||!(cause instanceof ApiError)||!cause.retryable||attempt>=8)throw cause;
      const delay=Math.min(30_000,Math.max(cause.retryAfterMs,1000*2**attempt));
      await new Promise<void>((resolve,reject)=>{const cancel=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},delay);signal.addEventListener('abort',cancel,{once:true});});
    }
  }
}
/** No source-room token, member approval, device credential or MLS state is loaded. */
export type ArchiveCounts = {messages:number;images:number;videos:number;files:number;audio:number};
export type ArchiveRestoreProgress = ArchiveCounts & { stage: 'reading' | 'restoring' | 'committing' | 'complete'; objects: number; totalObjects: number; totals?: ArchiveCounts };
export async function restoreRoomArchive(session:VaultSession,key:ArchiveKey,signal:AbortSignal,progress:(done:number)=>void,detail?:(state:ArchiveRestoreProgress)=>void):Promise<number> {
  const runId=crypto.randomUUID(),lockName=`quiet-room:archive-restore:${session.vault.roomId}`;
  const run=async()=>{try{return await restoreArchiveContents(session,key,signal,progress,runId,detail);}finally{await discardPrivateArchiveStaging(session,runId).catch(()=>undefined);}};
  if(navigator.locks)return navigator.locks.request(lockName,{signal},async()=>{await collectAbandonedPrivateArchiveImports(session,lockName);signal.throwIfAborted();return run();});
  return run();
}
async function restoreArchiveContents(session:VaultSession,key:ArchiveKey,signal:AbortSignal,progress:(done:number)=>void,runId:string,detail?:(state:ArchiveRestoreProgress)=>void):Promise<number> {
  const state:ArchiveRestoreProgress={stage:'reading',objects:0,totalObjects:0,messages:0,images:0,videos:0,files:0,audio:0};
  detail?.({...state});
  const snapshot=await get<{descriptor:ArchiveKey['descriptor'];end:number;count?:number}>(key,'',signal);
  if(canonicalStringify(snapshot.descriptor)!==canonicalStringify(key.descriptor)||!Number.isSafeInteger(snapshot.end)||snapshot.end<0)throw new Error('归档来源校验失败');
  // Cursor IDs are global across archives; only this snapshot's actual count
  // is a valid denominator. Older servers retain indeterminate progress.
  state.totalObjects=Number.isSafeInteger(snapshot.count)&&snapshot.count!>=0&&snapshot.count!<=snapshot.end?snapshot.count!:0;detail?.({...state});
  const totals:ArchiveCounts={messages:0,images:0,videos:0,files:0,audio:0},destinationScopes=new Map<string,string>();let count=0;
  for(const discovering of [true,false]) {
  if(!discovering){state.stage='restoring';state.objects=0;state.totals={...totals};detail?.({...state});}
  let after=0,revision=0;let previous:Ref|null=null;

  for(;;) {
    const page=await get<{cursor:number;id:string;bytes:number}[]>(key,`?after=${after}&end=${snapshot.end}`,signal);
    if(!Array.isArray(page)||page.length>100)throw new Error('备份目录不正确');
    for(const row of page) {
      if(!Number.isSafeInteger(row.cursor)||row.cursor<=after||row.cursor>snapshot.end||!/^[0-9a-f-]{36}$/.test(row.id))throw new Error('备份目录不正确');
      after=row.cursor;
      const object=await get<ArchiveObject>(key,`/${row.id}`,signal);
      if(object.id!==row.id)throw new Error('归档分块被替换');
      const payload=await openArchiveObject(key,object) as Batch|MediaPayload;
      if(payload?.v!==2||!['batch','media'].includes(payload.kind))throw new Error('不支持的归档内容');
      if(payload.kind!=='batch'){state.objects++;detail?.({...state});continue;}
    signal.throwIfAborted();
    if(payload.revision!==++revision||canonicalStringify(payload.previous)!==canonicalStringify(previous)||
      !payload.item||typeof payload.item.self!=='boolean'||!uuid.test(payload.item.originRoomId)||!isMessagePayload(payload.item.message?.payload)||
      !uuid.test(payload.item.message.clientMsgId)||!uuid.test(payload.item.message.senderId)||!Number.isSafeInteger(payload.item.message.seq)||payload.item.message.seq<1||!timestamp(payload.item.message.acceptedAt)||!['sent','stored','delivered'].includes(payload.item.message.status)||!Array.isArray(payload.media)||payload.media.length>100)throw new Error('历史来源或完整性校验失败');
    const prior=await loadPrivateArchiveItem(session,itemId(payload.item),signal);
    // Only published copies may be reused. Fresh per-run/source namespaces keep
    // another restore (including old clients) from borrowing unfinished chunks.
    let scope=prior?.sourceScope??destinationScopes.get(payload.item.originRoomId);
    if(!scope){scope=`${session.vault.localDataScope??session.vault.roomId}:private:${crypto.randomUUID()}`;destinationScopes.set(payload.item.originRoomId,scope);}
    const item={...payload.item,sourceScope:scope};
    if(prior&&canonicalStringify(prior)!==canonicalStringify(item))throw new Error('导入记录与已保存的历史冲突');
    const expected=manifests(payload.item.message);
    if(canonicalStringify(expected)!==canonicalStringify(payload.media.map(x=>x.manifest)))throw new Error('原图片清单不完整');
    if(discovering){
      totals.messages++;for(const {manifest} of payload.media){const kind=manifest.mimeType?.startsWith('image/')?'images':manifest.mimeType?.startsWith('video/')?'videos':manifest.mimeType?.startsWith('audio/')?'audio':'files';totals[kind]++;}
      previous={id:object.id,hash:archiveObjectHash(object)};state.objects++;detail?.({...state});continue;
    }
    for(const {manifest,parts} of payload.media) {
      if(!Array.isArray(parts)||parts.length!==manifest.chunkCount)throw new Error('原图片分块缺失');
      const verifier=await attachmentVerifier(manifest);
      // Verify a whole original before publishing any message that references it.
      for(let pass=0;pass<2;pass++)for(let index=0;index<parts.length;index++) {
        const ref=parts[index]!;
        if(!ref||!/^[0-9a-f-]{36}$/.test(ref.id))throw new Error('原图片分块不正确');
        const part=await get<ArchiveObject>(key,`/${ref.id}`,signal);
        if(archiveObjectHash(part)!==ref.hash)throw new Error('原图片分块被替换');
        const media=await openArchiveObject(key,part) as MediaPayload;
        if(media.kind!=='media'||media.v!==2||media.blobId!==manifest.blobId||media.index!==index||typeof media.bytes!=='string')throw new Error('原图片分块归属不正确');
        const raw=fromBase64Url(media.bytes);
        if(pass===0){await verifier.chunk(index,raw.buffer);if(index===parts.length-1)verifier.finish();}
        else {await stagePrivateArchiveMedia(session,runId,scope,manifest.blobId,index,raw.buffer,signal,Boolean(prior));const saved=await loadStagedPrivateArchiveMedia(session,runId,scope,manifest.blobId,index,raw.length);if(!saved||toBase64Url(saved)!==media.bytes)throw new Error('本机密室不足，请腾出密室后重试');}
      }
    }
    for(const {manifest} of payload.media){const kind=manifest.mimeType?.startsWith('image/')?'images':manifest.mimeType?.startsWith('video/')?'videos':manifest.mimeType?.startsWith('audio/')?'audio':'files';state[kind]++;}
    state.messages++;state.objects++;detail?.({...state});
    await stagePrivateArchiveItem(session,runId,item,signal);
    previous={id:object.id,hash:archiveObjectHash(object)};progress(++count);
    }
    if(page.length<100){if(after!==snapshot.end)throw new Error('备份目录不完整，请重试');break;}
  }
  if(snapshot.count!==undefined&&state.objects!==snapshot.count)throw new Error('备份目录数量不一致');
  }
  state.stage='committing';detail?.({...state});
  await commitPrivateArchiveImport(session,runId,signal);
  state.stage='complete';detail?.({...state});
  return count;
}
