import { fromBase64Url, toBase64Url } from './base64';
import { createSourceCipherTransfer, readCipherTransfer, readCipherPart, runCipherTransfer, cancelCipherTransfer, discardCipherTransfer } from './cipher-transfer';
import { listPendingLinkDownloads, savePendingLinkDownload, deletePendingLinkDownload, type PendingLinkDownload, type VaultSession } from './vault';
import type { LinkClip } from './link-video';

function sourceUrl(value:string):boolean {
  try {const url=new URL(value);return url.origin==='https://video.twimg.com'&&!url.username&&!url.password&&url.pathname.endsWith('.mp4');} catch{return false;}
}
export async function launchLinkSourceDownload(plan:PendingLinkDownload,signal:AbortSignal):Promise<void> {
  const task=await readCipherTransfer(plan.taskId);if(!task||task.state==='done')return;
  signal.throwIfAborted();
  const key=await crypto.subtle.importKey('raw',fromBase64Url(plan.key),'AES-GCM',false,['encrypt']);
  await runCipherTransfer(task,signal,undefined,{url:plan.clip.url,key,ivPrefix:fromBase64Url(plan.ivPrefix)});
}
export async function prepareLinkSourceDownload(session:VaultSession,clip:LinkClip,id:string,share:boolean,signal:AbortSignal):Promise<PendingLinkDownload|undefined> {
  if(!navigator.serviceWorker?.controller)return;
  if(!sourceUrl(clip.url))throw Error('Invalid video source');
  const existing=(await listPendingLinkDownloads(session,signal)).find(row=>row.id===id);
  if(existing)return existing;
  const task=await createSourceCipherTransfer(session.vault.roomId,session.vault.identity.publicBundle.deviceId,id);
  const plan:PendingLinkDownload={kind:'link-source-v1',id,taskId:task.id,clip,share,created:Date.now(),
    key:toBase64Url(crypto.getRandomValues(new Uint8Array(32))),ivPrefix:toBase64Url(crypto.getRandomValues(new Uint8Array(8)))};
  signal.throwIfAborted();await savePendingLinkDownload(session,plan);signal.throwIfAborted();return plan;
}
export async function downloadLinkSource(session:VaultSession,clip:LinkClip,id:string,share:boolean,signal:AbortSignal,
  progress:(bytes:number,total:number)=>void):Promise<Blob|undefined> {
  let plan=await prepareLinkSourceDownload(session,clip,id,share,signal);if(!plan)return;
  for(let attempt=0;attempt<2;attempt++){
    const task=await readCipherTransfer(plan.taskId);
    if(!task||task.state==='cancelled')throw new DOMException('Download cancelled','AbortError');
    if(task.roomId!==session.vault.roomId||task.deviceId!==session.vault.identity.publicBundle.deviceId||task.blobId!==id||task.direction!=='source'||!sourceUrl(plan.clip.url))throw Error('Source scope mismatch');
    try{
      if(task.state!=='done'){
        const key=await crypto.subtle.importKey('raw',fromBase64Url(plan.key),'AES-GCM',false,['encrypt']);
        await runCipherTransfer(task,signal,undefined,{url:plan.clip.url,key,ivPrefix:fromBase64Url(plan.ivPrefix)},progress);
      }
      const complete=await readCipherTransfer(plan.taskId);signal.throwIfAborted();
      if(!complete||complete.state!=='done'||complete.originalSize<=0||complete.originalSize>2*1024**3||complete.chunkCount!==Math.ceil(complete.originalSize/complete.chunkSize))throw Error('Incomplete source download');
      const key=await crypto.subtle.importKey('raw',fromBase64Url(plan.key),'AES-GCM',false,['decrypt']);
      const parts:Blob[]=[];
      for(let index=0;index<complete.chunkCount;index++){
        signal.throwIfAborted();const encrypted=await readCipherPart(plan.taskId,index);signal.throwIfAborted();
        const size=Math.min(complete.chunkSize,complete.originalSize-index*complete.chunkSize);
        if(!encrypted||encrypted.byteLength!==size+16)throw Error('Incomplete source chunk');
        const iv=new Uint8Array(12);iv.set(fromBase64Url(plan.ivPrefix));new DataView(iv.buffer).setUint32(8,index,false);
        const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(plan.taskId+':'+index)},key,encrypted);
        signal.throwIfAborted();parts.push(new Blob([plaintext]));
      }
      return new Blob(parts,{type:'video/mp4'});
    }catch(error){
      signal.throwIfAborted();
      if(!(error instanceof Error)||error.message!=='SOURCE_RESTART_REQUIRED'||attempt>0)throw error;
      // A source changed or declined Range. New task/key/nonce before reading
      // byte zero: never reuse an AES-GCM nonce with changed plaintext.
      await cancelCipherTransfer(plan.taskId);
      await deletePendingLinkDownload(session,id);
      const old=plan.taskId;plan=await prepareLinkSourceDownload(session,clip,id,share,signal);
      if(!plan)throw Error('Background download unavailable');
      await discardCipherTransfer(old);progress(0,0);
    }
  }
}
export async function finishLinkSourceDownload(session:VaultSession,id:string,signal:AbortSignal):Promise<void> {
  const plan=(await listPendingLinkDownloads(session,signal)).find(row=>row.id===id);if(!plan)return;
  await deletePendingLinkDownload(session,id);await discardCipherTransfer(plan.taskId);
}
export async function cancelLinkSourceDownload(session:VaultSession,id:string,signal:AbortSignal):Promise<void> {
  const plan=(await listPendingLinkDownloads(session,signal)).find(row=>row.id===id);if(!plan)return;
  await cancelCipherTransfer(plan.taskId);await deletePendingLinkDownload(session,id);
}
