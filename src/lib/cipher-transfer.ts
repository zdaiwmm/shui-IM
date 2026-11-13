import { authorizedFetch } from './api';
import type { ImageManifest } from './types';

export type CipherTransfer = {
  id: string; roomId: string; blobId: string; deviceId: string; direction: 'upload' | 'download' | 'source';
  chunkCount: number; originalSize: number; chunkSize: number; token: string; expiresAt: number;
  acknowledgedChunks?:number;
  receivedBytes?:number; etag?:string;
  state: 'preparing' | 'ready' | 'running' | 'done' | 'paused' | 'restart' | 'cancelled'; updated: number;
};
const database = 'quiet-room-cipher-transfers-v1';
export const cipherTransferId = (room: string, device: string, blob: string, direction: string) => [room,device,blob,direction].join(':') + ':' + crypto.randomUUID();

function open(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open(database,1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('tasks',{keyPath:'id'});
      const parts = request.result.createObjectStore('parts',{keyPath:'id'});
      parts.createIndex('taskId','taskId');
    };
    request.onerror = () => reject(request.error); request.onblocked = () => reject(Error('Transfer storage blocked'));
    request.onsuccess = () => resolve(request.result);
  });
}
async function transact<T>(mode: IDBTransactionMode, operation: (tx: IDBTransaction, finish: (value:T) => void) => void): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve,reject) => {
    const tx = db.transaction(['tasks','parts'],mode); let result:T;
    tx.oncomplete = () => {db.close();resolve(result);};
    tx.onabort = () => {db.close();reject(tx.error ?? Error('Transfer cancelled'));};
    tx.onerror = () => {};
    try {operation(tx,value => {result=value;});} catch(error) {tx.abort();db.close();reject(error);}
  });
}
export async function listCipherTransfers(roomId:string,deviceId:string):Promise<CipherTransfer[]> {
  const rows=await transact<CipherTransfer[]>('readonly',(tx,done)=>{const r=tx.objectStore('tasks').getAll();r.onsuccess=()=>done(r.result);});
  return rows.filter(row=>row.roomId===roomId&&row.deviceId===deviceId);
}
export async function findCipherTransfer(roomId:string,deviceId:string,blobId:string,direction:string):Promise<CipherTransfer|undefined> {
  return (await listCipherTransfers(roomId,deviceId)).filter(row=>row.blobId===blobId&&row.direction===direction&&row.state!=='cancelled')
    .sort((a,b)=>b.updated-a.updated)[0];
}
export async function discardCipherTransfer(id:string):Promise<void> {
  await transact<void>('readwrite',(tx,done)=>{
    tx.objectStore('tasks').delete(id);
    const cursor=tx.objectStore('parts').index('taskId').openCursor(IDBKeyRange.only(id));
    cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}else done();};
  });
}
export function readCipherTransfer(id: string): Promise<CipherTransfer | undefined> {
  return transact('readonly',(tx,done) => {const request=tx.objectStore('tasks').get(id);request.onsuccess=()=>done(request.result);});
}
export async function createSourceCipherTransfer(roomId:string,deviceId:string,blobId:string):Promise<CipherTransfer> {
  const task:CipherTransfer={id:cipherTransferId(roomId,deviceId,blobId,'source'),roomId,deviceId,blobId,direction:'source',
    originalSize:0,chunkCount:0,chunkSize:1024**2,token:'',expiresAt:Date.now()+24*3600_000,state:'ready',updated:Date.now()};
  await transact<void>('readwrite',(tx,done)=>{tx.objectStore('tasks').add(task);done();});return task;
}
export function readCipherPart(id: string,index: number): Promise<ArrayBuffer | undefined> {
  return transact('readonly',(tx,done) => {
    const task=tx.objectStore('tasks').get(id);
    task.onsuccess=()=>{
      if (!task.result || task.result.state==='cancelled') {done(undefined);return;}
      const part=tx.objectStore('parts').get(id+':'+index);part.onsuccess=()=>done(part.result?.bytes);
    };
  });
}
export async function prepareCipherTransfer(options: {
  roomId:string;deviceId:string;accessToken:string;manifest:Pick<ImageManifest,'blobId'|'chunkCount'|'originalSize'|'chunkSize'>;
  direction:'upload'|'download';signal:AbortSignal;
}): Promise<CipherTransfer | undefined> {
  if (!navigator.serviceWorker?.controller) return;
  const {manifest:m,roomId,deviceId,direction,signal}=options;
  signal.throwIfAborted();
  const id=cipherTransferId(roomId,deviceId,m.blobId,direction);
  const prior=await findCipherTransfer(roomId,deviceId,m.blobId,direction);
  if (prior && (prior.originalSize!==m.originalSize || prior.chunkCount!==m.chunkCount || prior.chunkSize!==m.chunkSize)) throw Error('Transfer manifest conflict');
  if (prior?.state==='done') return prior;
  const estimate=await navigator.storage?.estimate?.().catch(()=>undefined);
  if (!prior && estimate?.quota && estimate.quota-(estimate.usage??0) < m.originalSize+16*m.chunkCount+64*1024**2) throw new DOMException('Insufficient transfer storage','QuotaExceededError');
  const response=await authorizedFetch(`/api/rooms/${roomId}/blobs/${m.blobId}/transfer`,options.accessToken,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({direction}),signal,
  });
  const grant=await response.json() as {token:string;expiresAt:number};
  if (!/^[A-Za-z0-9_-]{43}$/.test(grant.token) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt<=Date.now()) throw Error('Invalid transfer grant');
  signal.throwIfAborted();
  const task:CipherTransfer={id:prior?.id ?? id,roomId,deviceId,blobId:m.blobId,direction,chunkCount:m.chunkCount,originalSize:m.originalSize,chunkSize:m.chunkSize,
    token:grant.token,expiresAt:grant.expiresAt,state:direction==='upload'?'preparing':'ready',updated:Date.now()};
  await transact<void>('readwrite',(tx,done)=>{
    const store=tx.objectStore('tasks'),read=store.get(task.id);
    read.onsuccess=()=>{if(read.result?.state==='cancelled'){tx.abort();return;}store.put(task);done();};
  });
  return task;
}
export async function stageCipherPart(task:CipherTransfer,index:number,bytes:ArrayBuffer):Promise<void> {
  const expected=Math.min(task.chunkSize,task.originalSize-index*task.chunkSize)+16;
  if(!Number.isSafeInteger(index)||index<0||index>=task.chunkCount||bytes.byteLength!==expected)throw Error('Invalid encrypted transfer chunk');
  await transact<void>('readwrite',(tx,done)=>{
    const request=tx.objectStore('tasks').get(task.id);
    request.onsuccess=()=>{if(!request.result||request.result.state==='cancelled'){tx.abort();return;}
      tx.objectStore('parts').put({id:task.id+':'+index,taskId:task.id,index,bytes});done();};
  });
}
export async function runCipherTransfer(task:CipherTransfer,signal:AbortSignal,progress?:(ratio:number)=>void,source?:{url:string;key:CryptoKey;ivPrefix:Uint8Array<ArrayBuffer>},bytesProgress?:(bytes:number,total:number)=>void):Promise<void> {
  signal.throwIfAborted();
  await transact<void>('readwrite',(tx,done)=>{
    const store=tx.objectStore('tasks'),request=store.get(task.id);
    request.onsuccess=()=>{if(!request.result||request.result.state==='cancelled'){tx.abort();return;}
      if(request.result.state!=='done')store.put({...request.result,state:'ready',updated:Date.now()});done();};
  });
  // The worker receives an opaque ID only. No vault, MLS key, original File or
  // general room credential crosses this boundary. Aborting this wait detaches
  // the locked UI; explicit cancellation is the separate durable operation.
  if((await readCipherTransfer(task.id))?.state==='done')return;
  const controller=navigator.serviceWorker.controller;
  if(!controller)throw Error('后台传输服务尚未就绪，请刷新后重试');
  await new Promise<void>((resolve,reject)=>{
    const channel=new MessageChannel();
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);channel.port1.close();};
    const abort=()=>{cleanup();reject(signal.reason);};
    const timer=setTimeout(()=>{cleanup();reject(Error('后台传输服务尚未更新，请刷新后重试'));},5000);
    channel.port1.onmessage=event=>{if(event.data?.version===1){cleanup();resolve();}};
    signal.addEventListener('abort',abort,{once:true});
    controller.postMessage({type:'quiet-room-cipher-transfer',id:task.id,...(source?{source}:{})},[channel.port2]);
  });
  await new Promise<void>((resolve,reject)=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason);};
    const poll=async()=>{
      try {
        signal.throwIfAborted();const current=await readCipherTransfer(task.id);signal.throwIfAborted();
        if(!current||current.state==='cancelled')throw new DOMException('Transfer cancelled','AbortError');
        if(current.state==='done'){cleanup();resolve();return;}
        if(current.state==='paused')throw Error('传输已暂停，解锁后可继续');
        if(current.state==='restart')throw Error('SOURCE_RESTART_REQUIRED');
        const count=await transact<number>('readonly',(tx,done)=>{const r=tx.objectStore('parts').index('taskId').count(task.id);r.onsuccess=()=>done(r.result);});
        if(task.direction==='source'){bytesProgress?.(current.receivedBytes??0,current.originalSize);if(current.originalSize>0)progress?.((current.receivedBytes??0)/current.originalSize);}
        else progress?.(task.direction==='download'?count/task.chunkCount:(current.acknowledgedChunks??0)/task.chunkCount);
        timer=setTimeout(()=>void poll(),500);
      } catch(error){cleanup();reject(error);}
    };
    signal.addEventListener('abort',abort,{once:true});void poll();
  });
}
export async function cancelCipherTransfer(id:string):Promise<void> {
  const task=await readCipherTransfer(id);if(!task)return;
  await transact<void>('readwrite',(tx,done)=>{
    tx.objectStore('tasks').put({...task,state:'cancelled',token:'',updated:Date.now()});
    const cursor=tx.objectStore('parts').index('taskId').openCursor(IDBKeyRange.only(id));
    cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}else done();};
  });
  navigator.serviceWorker?.controller?.postMessage({type:'quiet-room-cipher-transfer-cancel',id});
  if(task.direction==='source')return;
  await fetch(`/api/rooms/${task.roomId}/blobs/${task.blobId}/transfer`,{method:'DELETE',credentials:'omit',cache:'no-store',
    headers:{Authorization:'Transfer '+task.token,'X-Transfer-Direction':task.direction}}).catch(()=>undefined);
}
