import { uiLiteral } from './language';
import { canonicalStringify } from './canonical';
import { toBase64Url } from './base64';
import { isMessagePayload } from './message-payload';
import { reduceMessageDeletions } from './message-deletions';
import { withVaultMutation, adoptPrivateCatalog, discardUnpublishedPrivateCatalog, discardPrivateCatalogGeneration, loadPrivateArchiveItem, readPrivateCatalogMeta, readPrivateCatalogRecord, scanPrivateArchiveItems, writePrivateCatalogRecord, type PrivateCatalogMeta, type VaultSession } from './vault';
import type { PrivateArchiveItem } from './room-archive';
import type { RoomMember } from './types';

export type PrivateIndexEntry = { id: string; origin: string; messageId: string; seq: number; time: string; digest: string; bytes: number };
const PAGE = 128;
const encoder = new TextEncoder();
const identity = (item: PrivateArchiveItem) => `${item.originRoomId}:${item.message.clientMsgId}`;
const hash = async (item: PrivateArchiveItem) => toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalStringify(item))));
export const comparePrivateEntries = (a: PrivateIndexEntry,b: PrivateIndexEntry) => a.time.localeCompare(b.time)||a.origin.localeCompare(b.origin)||a.seq-b.seq||a.messageId.localeCompare(b.messageId);
const contentKinds=new Set(['text','image','image-album','audio','file']);
function fail():never{throw new Error(uiLiteral('私有历史完整性检查失败，请保留本机数据后重试'));}

/** Metadata-only external merge. At most eight 128-entry pages are decoded at once. */
async function* readRun(session:VaultSession,pages:string[],signal:AbortSignal):AsyncGenerator<PrivateIndexEntry>{
  let previous:PrivateIndexEntry|undefined;
  for(const id of pages){
    signal.throwIfAborted();const entries=await readPrivateCatalogRecord<PrivateIndexEntry[]>(session,id,signal);
    if(!Array.isArray(entries)||entries.length>PAGE)fail();
    for(const entry of entries){if(!entry||typeof entry.id!=='string'||typeof entry.digest!=='string'||!Number.isSafeInteger(entry.seq)||typeof entry.time!=='string'||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||previous&&comparePrivateEntries(previous,entry)>0)fail();previous=entry;yield entry;}
  }
}
async function writeRun(session:VaultSession,entries:AsyncIterable<PrivateIndexEntry>,prefix:string,signal:AbortSignal):Promise<string[]>{
  const pages:string[]=[];let buffer:PrivateIndexEntry[]=[];
  const flush=async()=>{if(!buffer.length)return;const id=`${prefix}:${pages.length}`;await writePrivateCatalogRecord(session,id,buffer,signal);pages.push(id);buffer=[];};
  for await(const entry of entries){signal.throwIfAborted();buffer.push(entry);if(buffer.length===PAGE)await flush();}await flush();return pages;
}
async function* mergeRuns(session:VaultSession,runs:string[][],signal:AbortSignal):AsyncGenerator<PrivateIndexEntry>{
  const readers=runs.map(run=>readRun(session,run,signal)[Symbol.asyncIterator]());
  const heads=await Promise.all(readers.map(reader=>reader.next()));
  try{for(;;){signal.throwIfAborted();let chosen=-1;
    for(let n=0;n<heads.length;n++)if(!heads[n]!.done&&(chosen<0||comparePrivateEntries(heads[n]!.value!,heads[chosen]!.value!)<0))chosen=n;
    if(chosen<0)return;yield heads[chosen]!.value!;heads[chosen]=await readers[chosen]!.next();
  }}finally{for(const reader of readers)await reader.return?.(undefined);}
}

/** Never publish a partial deletion projection. Raw authenticated records remain authoritative. */
export async function ensurePrivateCatalog(session:VaultSession,signal:AbortSignal):Promise<PrivateCatalogMeta>{
  if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request(`quiet-room:private-catalog:${session.vault.localDataScope??session.vault.roomId}`,{signal},()=>buildPrivateCatalog(session,signal,true));
  return buildPrivateCatalog(session,signal,false);
}
async function buildPrivateCatalog(session:VaultSession,signal:AbortSignal,exclusive:boolean):Promise<PrivateCatalogMeta>{
  const expected=await readPrivateCatalogMeta(session,signal);
  if(expected.catalog){const c=expected.catalog;if(c.version!==1||typeof c.generation!=='string'||!Array.isArray(c.pages)||!Number.isSafeInteger(c.visibleCount)||c.visibleCount<0||c.visibleCount>expected.rawCount||c.pages.length!==Math.ceil(c.visibleCount/PAGE))fail();return expected;}
  if(exclusive)await discardUnpublishedPrivateCatalog(session,signal);
  const generation=crypto.randomUUID(),prefix=`catalog:${generation}`,deletions:PrivateArchiveItem[]=[],roles=new Map<string,Map<string,RoomMember['role']>>(),sequences=new Map<string,string>();
  let count=0,buffer:PrivateIndexEntry[]=[],runs:string[][]=[];
  const flush=async()=>{if(!buffer.length)return;buffer.sort(comparePrivateEntries);const id=`${prefix}:initial:${runs.length}`;await writePrivateCatalogRecord(session,id,buffer,signal);runs.push([id]);buffer=[];};
  let adopted=false;
  try{
    for await(const item of scanPrivateArchiveItems(session,{signal})){
      if(!item?.message||!isMessagePayload(item.message.payload)||!Number.isSafeInteger(item.message.seq)||item.message.seq<1||typeof item.originRoomId!=='string'||typeof item.sourceScope!=='string'||typeof item.self!=='boolean')fail();
      count++;const id=identity(item),roomRoles=roles.get(item.originRoomId)??new Map<string,RoomMember['role']>();
      const role=item.self?'creator':'joiner',previous=roomRoles.get(item.message.senderId);if(previous&&previous!==role)fail();roomRoles.set(item.message.senderId,role);roles.set(item.originRoomId,roomRoles);
      if(contentKinds.has(item.message.payload.kind)){
        const seqKey=`${item.originRoomId}:${item.message.seq}`,prior=sequences.get(seqKey);sequences.set(seqKey,prior&&prior!==id?'ambiguous':id);
        buffer.push({id,origin:item.originRoomId,messageId:item.message.clientMsgId,seq:item.message.seq,time:item.message.payload.sentAt,digest:await hash(item),bytes:encoder.encode(JSON.stringify(item)).length});
        if(buffer.length===PAGE)await flush();
      }else if(item.message.payload.kind==='message-delete')deletions.push(item);
    }
    if(count!==expected.rawCount)fail();await flush();
    const deleted=new Set<string>();
    for(const deletion of deletions){
      signal.throwIfAborted();const payload=deletion.message.payload;if(payload.kind!=='message-delete')continue;
      const id=`${deletion.originRoomId}:${payload.target.clientMsgId}`,seq=sequences.get(`${deletion.originRoomId}:${payload.target.serverSeq}`);
      if(seq!==id)continue;
      const target=await loadPrivateArchiveItem(session,id,signal);if(!target)fail();
      if(reduceMessageDeletions([target.message,deletion.message],roles.get(deletion.originRoomId)!).has(payload.target.clientMsgId))deleted.add(id);
    }
    // Bounded fan-in, with encrypted intermediate runs. No array of all bodies or all sort entries.
    for(let pass=0;runs.length>1;pass++){
      const next:string[][]=[];for(let n=0;n<runs.length;n+=8)next.push(await writeRun(session,mergeRuns(session,runs.slice(n,n+8),signal),`${prefix}:merge:${pass}:${n}`,signal));runs=next;
    }
    let visibleCount=0;
    async function* visible(){if(runs[0])for await(const entry of readRun(session,runs[0],signal)){if(!deleted.has(entry.id)){visibleCount++;yield entry;}}}
    const pages=await writeRun(session,visible(),`${prefix}:visible`,signal);
    const next:PrivateCatalogMeta={revision:expected.revision,rawCount:count,catalog:{generation,pages,visibleCount,version:1}};
    await adoptPrivateCatalog(session,expected,next,signal);adopted=true;
    await discardPrivateCatalogGeneration(session,generation,new Set(pages));
    for(const old of expected.retired??[])if(old!==generation)await discardPrivateCatalogGeneration(session,old);
    return next;
  }catch(cause){if(!adopted)await discardPrivateCatalogGeneration(session,generation).catch(()=>undefined);throw cause;}
}
export type PrivateHistoryPage={items:PrivateArchiveItem[];start:number;end:number;total:number;revision:string};
export async function readPrivateHistoryPage(session:VaultSession,meta:PrivateCatalogMeta,signal:AbortSignal,{before,after,anchorId}:{before?:number;after?:number;anchorId?:string}={}):Promise<PrivateHistoryPage>{
  const catalog=meta.catalog;if(!catalog)fail();
  let start=Math.max(0,(before??catalog.visibleCount)-100),end=Math.min(catalog.visibleCount,before??catalog.visibleCount);
  if(after!==undefined){start=after;end=Math.min(catalog.visibleCount,start+100);}
  if(anchorId){let offset=0;for(const id of catalog.pages){const page=await readPrivateCatalogRecord<PrivateIndexEntry[]>(session,id,signal);if(!Array.isArray(page))fail();const n=page.findIndex(entry=>entry.id===anchorId);if(n>=0){start=Math.max(0,offset+n-50);end=Math.min(catalog.visibleCount,start+100);break;}offset+=page.length;}}
  const entries:PrivateIndexEntry[]=[];
  for(let page=Math.floor(start/PAGE);page<Math.ceil(end/PAGE);page++){
    const list=await readPrivateCatalogRecord<PrivateIndexEntry[]>(session,catalog.pages[page]!,signal);
    if(!Array.isArray(list)||list.length!==Math.min(PAGE,catalog.visibleCount-page*PAGE))fail();
    entries.push(...list.slice(Math.max(0,start-page*PAGE),Math.min(PAGE,end-page*PAGE)));
  }
  const reverse=after===undefined,selected=reverse?[...entries].reverse():entries,items:PrivateArchiveItem[]=[];let bytes=0;
  for(const entry of selected){
    signal.throwIfAborted();if(items.length&&bytes+entry.bytes>8*1024*1024)break;
    const item=await loadPrivateArchiveItem(session,entry.id,signal);if(!item||await hash(item)!==entry.digest)fail();items.push(item);bytes+=entry.bytes;
  }
  if(reverse){items.reverse();start=end-items.length;}else end=start+items.length;
  await withVaultMutation(session,async()=>{signal.throwIfAborted();});
  if(canonicalStringify(await readPrivateCatalogMeta(session,signal))!==canonicalStringify(meta))throw new DOMException(uiLiteral('私有历史已更新'),'AbortError');
  return {items,start,end,total:catalog.visibleCount,revision:meta.revision};
}
