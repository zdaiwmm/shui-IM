import { ApiError, authorizedFetch, fetchBlobChunk } from './api';
import { fromBase64Url, toBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { isMessagePayload } from './message-payload';
import { attachmentVerifier } from './local-history-backup';
import { archiveObjectHash, archiveAccessToken, archiveWriterProof, openArchiveObject, sealArchiveObject, type ArchiveKey, type ArchiveObject } from './room-archive-crypto';
import { loadCachedMediaChunk, loadChamberHistoryPageAfter, saveVault, withVaultMutation, stagePrivateArchiveItem, commitPrivateArchiveImport, discardPrivateArchiveStaging, loadPrivateArchiveItems, savePrivateMediaChunk, loadPrivateMediaChunk, type VaultSession } from './vault';
import type { DecryptedMessage, ImageManifest } from './types';

export type PrivateArchiveItem = { originRoomId: string; message: DecryptedMessage; self: boolean; sourceScope: string };
type Ref = { id: string; hash: string };
type Media = { manifest: ImageManifest; parts: Ref[] };
type Batch = { kind: 'batch'; v: 2; revision: number; previous: Ref | null; item: Omit<PrivateArchiveItem, 'sourceScope'>; media: Media[] };
type MediaPayload = { kind: 'media'; v: 2; blobId: string; index: number; bytes: string };
export type RoomArchiveState = { cursor: number; revision: number; head?: Ref; syncedAt?: string; completeAt?: string; preparing?: { itemId: string; media: Media[]; next?: ArchiveObject }; pending?: { object: ArchiveObject; cursor?: number; privateId?: string; head: Ref }; privateDone?: string[] };
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestamp=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const manifests = (message: DecryptedMessage): ImageManifest[] => {
  const p=message.payload;return 'images' in p?p.images:'image' in p?[p.image]:'file' in p?[p.file]:'audio' in p?[p.audio]:[];
};
const itemId = (item: Pick<PrivateArchiveItem,'originRoomId'|'message'>) => `${item.originRoomId}:${item.message.clientMsgId}`;
function sourceSession(session: VaultSession, scope: string): VaultSession { return {...session,get stored(){return session.stored;},vault:{...session.vault,localDataScope:scope}}; }
export const privateItemSession = (session:VaultSession,item:PrivateArchiveItem) => sourceSession(session,item.sourceScope);
async function update(session:VaultSession,signal:AbortSignal,change:(state:RoomArchiveState)=>void) {
  await withVaultMutation(session,async mutation=>{
    signal.throwIfAborted();const previous=session.vault.archiveState;
    const next=structuredClone(previous??{cursor:session.vault.historyUnavailableBeforeSeq??0,revision:0});change(next);session.vault.archiveState=next;
    try{await saveVault(session,mutation);}catch(e){session.vault.archiveState=previous;throw e;}
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
  if(localOnly)throw new Error('原图片尚未完整恢复，请先完成恢复后重试备份');
  return fetchBlobChunk(session.vault.roomId,session.vault.accessToken,manifest.blobId,index,signal);
}
async function prepare(session:VaultSession,key:ArchiveKey,item:PrivateArchiveItem,signal:AbortSignal,localOnly:boolean):Promise<RoomArchiveState['pending']> {
  const source=sourceSession(session,item.sourceScope);
  const identity=itemId(item);
  if (!session.vault.archiveState?.preparing) await update(session,signal,s=>{s.preparing={itemId:identity,media:[]};delete s.completeAt;});
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
  return {object,head:{id:object.id,hash:archiveObjectHash(object)},...(localOnly?{privateId:itemId(item)}:{cursor:item.message.seq})};
}
/** Foreground-only. A durable encrypted pending batch precedes every network write. */
export async function syncRoomArchive(session:VaultSession,signal:AbortSignal):Promise<void> {
  const key=session.vault.roomArchiveV2?.key;if(!key||session.vault.roomArchiveV2?.rotation||session.vault.pairingState!=='ready')return;
  await put(session,key,undefined,signal);
  for(let pass=0;pass<10;pass++) {
    signal.throwIfAborted();
    if(!session.vault.archiveState?.pending) {
      const after=session.vault.archiveState?.cursor??session.vault.historyUnavailableBeforeSeq??0;
      const rows=await loadChamberHistoryPageAfter(session,after,signal);
      const row=rows[0];let item:PrivateArchiveItem|undefined;let localOnly=false;
      if(row) {
        if(row.seq!==after+1){const boundary=session.vault.historyUnavailableBeforeSeq??0;if(after<boundary){await update(session,signal,s=>{s.cursor=Math.min(row.seq-1,boundary);});continue;}throw new Error('部分记录尚未备份，请保留本机数据后重试');}
        if(session.vault.role!=='creator'&&['gallery-image','gallery-file'].includes(row.payload.kind)) {await update(session,signal,s=>{s.cursor=row.seq;});continue;}
        const sender=session.vault.members.find(m=>m.deviceId===row.senderId);if(!sender)throw new Error('记录发送者身份不完整，请保留本机记录');
        item={originRoomId:session.vault.roomId,message:row,self:sender.role===session.vault.role,sourceScope:session.vault.localDataScope??session.vault.roomId};
      } else {
        if(after<session.vault.lastSeq){const boundary=session.vault.historyUnavailableBeforeSeq??0;if(after<boundary){await update(session,signal,s=>{s.cursor=boundary;});continue;}throw new Error('部分记录尚未备份，请保留本机数据后重试');}
        const done=new Set(session.vault.archiveState?.privateDone??[]);
        item=(await loadPrivateArchiveItems(session)).find(x=>!done.has(itemId(x)));localOnly=true;
      }
      if(!item){if(!session.vault.archiveState?.completeAt)await update(session,signal,s=>{s.completeAt=new Date().toISOString();});return;}
      const pending=await prepare(session,key,item,signal,localOnly);
      await update(session,signal,s=>{s.pending=pending;delete s.preparing;});
    }
    const pending=session.vault.archiveState!.pending!;
    signal.throwIfAborted();await put(session,key,pending.object,signal);
    await update(session,signal,s=>{
      if(s.pending?.head.id!==pending.head.id)throw new Error('备份任务已改变');
      s.head=pending.head;s.revision++;if(pending.cursor!==undefined)s.cursor=pending.cursor;
      if(pending.privateId)s.privateDone=[...new Set([...(s.privateDone??[]),pending.privateId])];
      s.syncedAt=new Date().toISOString();delete s.pending;
    });
  }
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
  const runId=crypto.randomUUID();
  const run=async()=>{try{return await restoreArchiveContents(session,key,signal,progress,runId,detail);}finally{await discardPrivateArchiveStaging(session,runId).catch(()=>undefined);}};
  if(navigator.locks)return navigator.locks.request(`quiet-room:archive-restore:${session.vault.roomId}`,{signal},async()=>{await discardPrivateArchiveStaging(session);return run();});
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
  const totals:ArchiveCounts={messages:0,images:0,videos:0,files:0,audio:0};let count=0;
  for(const discovering of [true,false]) {
  if(!discovering){state.stage='restoring';state.objects=0;state.totals={...totals};detail?.({...state});}
  let after=0,revision=0;let previous:Ref|null=null;
  const existing=await loadPrivateArchiveItems(session);
  const existingById=new Map(existing.map(item=>[itemId(item),item]));
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
    const scope=`${session.vault.localDataScope??session.vault.roomId}:private:${payload.item.originRoomId}`;
    const prior=existingById.get(itemId(payload.item)),item={...payload.item,sourceScope:scope};
    if(prior&&canonicalStringify(prior)!==canonicalStringify(item))throw new Error('导入记录与已保存的历史冲突');
    const destination=sourceSession(session,scope),expected=manifests(payload.item.message);
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
        else {await savePrivateMediaChunk(destination,manifest.blobId,index,raw.buffer,signal);const saved=await loadPrivateMediaChunk(destination,manifest.blobId,index,raw.length);if(!saved||toBase64Url(saved)!==media.bytes)throw new Error('本机密室不足，请腾出密室后重试');}
      }
    }
    for(const {manifest} of payload.media){const kind=manifest.mimeType?.startsWith('image/')?'images':manifest.mimeType?.startsWith('video/')?'videos':manifest.mimeType?.startsWith('audio/')?'audio':'files';state[kind]++;}
    state.messages++;state.objects++;detail?.({...state});
    await stagePrivateArchiveItem(session,runId,item,signal);existingById.set(itemId(item),item);
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
