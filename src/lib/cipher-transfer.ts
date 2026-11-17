import { authorizedFetch } from './api';
import type { ImageManifest } from './types';
import { uiLiteral } from './language';
import { staleMediaActivity } from './media-retention';

export type CipherTransfer = {
  id: string; roomId: string; blobId: string; deviceId: string; direction: 'upload' | 'download' | 'source';
  chunkCount: number; originalSize: number; chunkSize: number; token: string; expiresAt: number;
  acknowledgedChunks?:number;
  clientMsgId?:string;
  /** A durable terminal fence; distinct from user cancellation. */
  expired?:boolean;
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
  const task=await readCipherTransfer(id);
  await transact<void>('readwrite',(tx,done)=>{
    tx.objectStore('tasks').delete(id);
    const cursor=tx.objectStore('parts').index('taskId').openCursor(IDBKeyRange.only(id));
    cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}else done();};
  });
  if(task)await retireTransferGrant(task);
}

async function retireTransferGrant(task:CipherTransfer):Promise<void> {
  if(task.direction!=='source'&&task.token)await fetch(`/api/rooms/${task.roomId}/blobs/${task.blobId}/transfer`,{method:'DELETE',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(5000),headers:{Authorization:'Transfer '+task.token,'X-Transfer-Direction':task.direction}}).catch(()=>undefined);
}

/** One IDB transaction arbitrates expiry against worker writes and renewal.
 * No vault, history, outbox, attachment key or source URL is accessed here. */
export async function cleanupCipherTransfers(now=Date.now()):Promise<CipherTransfer[]> {
  const expired=await transact<CipherTransfer[]>('readwrite',(tx,done)=>{
    const tasks=tx.objectStore('tasks'),parts=tx.objectStore('parts');
    const scan=tasks.openCursor(),retired:CipherTransfer[]=[];
    scan.onsuccess=()=>{
      const cursor=scan.result;
      if(!cursor){done(retired);return;}
      const task=cursor.value as CipherTransfer;
      if(staleMediaActivity(task.updated,now)){
        if(task.state==='cancelled')cursor.delete();
        else {retired.push(task);cursor.update({...task,state:'cancelled',expired:true,token:'',updated:now});}
      }
      cursor.continue();
    };
    // Key cursors avoid materializing potentially gigabytes of ciphertext.
    const chunks=parts.openKeyCursor();
    chunks.onsuccess=()=>{
      const cursor=chunks.result;if(!cursor)return;
      const taskId=String(cursor.primaryKey).slice(0,String(cursor.primaryKey).lastIndexOf(':'));
      const request=tasks.get(taskId);
      request.onsuccess=()=>{if(!request.result||request.result.state==='cancelled'||staleMediaActivity(request.result.updated,now))parts.delete(cursor.primaryKey);cursor.continue();};
    };
  });
  // Commit the local fence before notifying workers or awaiting the network.
  for(const task of expired)navigator.serviceWorker?.controller?.postMessage({type:'quiet-room-cipher-transfer-cancel',id:task.id});
  await Promise.all(expired.map(retireTransferGrant));
  return expired;
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
  clientMsgId?:string;
  /** Automatic recovery cannot allocate a replacement for a cancelled task. */
  expectedTaskId?:string;
}): Promise<CipherTransfer | undefined> {
  if (!navigator.serviceWorker?.controller) return;
  await cleanupCipherTransfers();
  const {manifest:m,roomId,deviceId,direction,signal}=options;
  signal.throwIfAborted();
  const id=cipherTransferId(roomId,deviceId,m.blobId,direction);
  const prior=options.expectedTaskId ? await readCipherTransfer(options.expectedTaskId) : await findCipherTransfer(roomId,deviceId,m.blobId,direction);
  if(options.expectedTaskId&&(!prior||prior.state==='cancelled'||prior.roomId!==roomId||prior.deviceId!==deviceId||prior.blobId!==m.blobId||prior.direction!==direction))throw new DOMException('Transfer cancelled','AbortError');
  if (prior && (prior.originalSize!==m.originalSize || prior.chunkCount!==m.chunkCount || prior.chunkSize!==m.chunkSize)) throw Error('Transfer manifest conflict');
  if (prior?.state==='done') return prior;
  const estimate=await navigator.storage?.estimate?.().catch(()=>undefined);
  if (!prior && estimate?.quota && Math.min(estimate.quota,10*1024**3)-(estimate.usage??0) < m.originalSize+16*m.chunkCount+64*1024**2) throw new DOMException('Insufficient transfer storage','QuotaExceededError');
  const response=await authorizedFetch(`/api/rooms/${roomId}/blobs/${m.blobId}/transfer`,options.accessToken,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({direction}),signal,
  });
  const grant=await response.json() as {token:string;expiresAt:number};
  if (!/^[A-Za-z0-9_-]{43}$/.test(grant.token) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt<=Date.now()) throw Error('Invalid transfer grant');
  signal.throwIfAborted();
  const task:CipherTransfer={id:prior?.id ?? id,roomId,deviceId,blobId:m.blobId,direction,chunkCount:m.chunkCount,originalSize:m.originalSize,chunkSize:m.chunkSize,
    token:grant.token,expiresAt:grant.expiresAt,state:direction==='upload'?'preparing':'ready',updated:Date.now(),...(options.clientMsgId?{clientMsgId:options.clientMsgId}:{})};
  await transact<void>('readwrite',(tx,done)=>{
    const store=tx.objectStore('tasks'),read=store.get(task.id);
    read.onsuccess=()=>{if(read.result?.state==='cancelled'||prior&&!read.result){tx.abort();return;}store.put(task);done();};
  });
  return task;
}
export async function stageCipherPart(task:CipherTransfer,index:number,bytes:ArrayBuffer):Promise<void> {
  const expected=Math.min(task.chunkSize,task.originalSize-index*task.chunkSize)+16;
  if(!Number.isSafeInteger(index)||index<0||index>=task.chunkCount||bytes.byteLength!==expected)throw Error('Invalid encrypted transfer chunk');
  const estimate=await navigator.storage?.estimate?.().catch(()=>undefined);
  if(estimate?.quota&&Math.min(estimate.quota,10*1024**3)-(estimate.usage??0)<bytes.byteLength+64*1024**2)throw new DOMException('Transfer storage full','QuotaExceededError');
  await transact<void>('readwrite',(tx,done)=>{
    const request=tx.objectStore('tasks').get(task.id);
    request.onsuccess=()=>{if(!request.result||request.result.state==='cancelled'){tx.abort();return;}
      tx.objectStore('tasks').put({...request.result,updated:Date.now()});
      tx.objectStore('parts').put({id:task.id+':'+index,taskId:task.id,index,bytes});done();};
  });
}
async function readyCipherWorker(signal:AbortSignal,sourceKeyBytes=false):Promise<ServiceWorker> {
  signal.throwIfAborted();
  const workers=navigator.serviceWorker;
  if(!workers?.controller)throw Error('后台传输服务尚未就绪，请刷新后重试');
  return new Promise<ServiceWorker>((resolve,reject)=>{
    let settled=false,probed:ServiceWorker|null=null,port:MessagePort|undefined;
    const cleanup=()=>{settled=true;clearTimeout(deadline);clearTimeout(updateTimer);port?.close();workers.removeEventListener('controllerchange',probe);signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(signal.reason);};
    const probe=()=>{
      const controller=workers.controller;
      if(settled||!controller||controller===probed)return;
      probed=controller;port?.close();
      const channel=new MessageChannel();port=channel.port1;
      channel.port1.onmessage=event=>{
        if(event.data?.version===1&&(!sourceKeyBytes||event.data.sourceKeyBytes===1)&&workers.controller===controller){cleanup();resolve(controller);}
      };
      // Readiness carries no task ID, source key or transfer capability. An old
      // controller may ignore it while the new release installs and claims us.
      try{controller.postMessage({type:'quiet-room-cipher-transfer-ready'},[channel.port2]);}
      catch{/* A replacing controller is retried by controllerchange. */}
    };
    const deadline=setTimeout(()=>{cleanup();reject(Error('后台传输服务尚未更新，请刷新后重试'));},15000);
    const updateTimer=setTimeout(()=>{
      void workers.getRegistration().then(registration=>{
        if(!settled&&!signal.aborted)return registration?.update();
      }).catch(()=>{/* The bounded wait retains the original task for retry. */});
    },250);
    workers.addEventListener('controllerchange',probe);
    signal.addEventListener('abort',abort,{once:true});
    probe();
  });
}

export async function runCipherTransfer(task:CipherTransfer,signal:AbortSignal,progress?:(ratio:number)=>void,source?:{url:string;keyBytes:Uint8Array<ArrayBuffer>;ivPrefix:Uint8Array<ArrayBuffer>},bytesProgress?:(bytes:number,total:number)=>void):Promise<void> {
  try {
  signal.throwIfAborted();
  await transact<void>('readwrite',(tx,done)=>{
    const store=tx.objectStore('tasks'),request=store.get(task.id);
    request.onsuccess=()=>{if(!request.result||request.result.state==='cancelled'){tx.abort();return;}
      if(request.result.state!=='done')store.put({...request.result,state:'ready',updated:Date.now()});done();};
  });
  // Ordinary ciphertext transport receives an opaque ID. Source imports also
  // receive their isolated grant, never a vault, MLS key, original File or
  // general room credential. Aborting this wait detaches
  // the locked UI; explicit cancellation is the separate durable operation.
  if((await readCipherTransfer(task.id))?.state==='done')return;
  const controller=await readyCipherWorker(signal,Boolean(source));
  signal.throwIfAborted();
  await new Promise<void>((resolve,reject)=>{
    const channel=new MessageChannel();
    const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);channel.port1.close();};
    const abort=()=>{cleanup();reject(signal.reason);};
    const timer=setTimeout(()=>{cleanup();reject(Error('后台传输服务尚未更新，请刷新后重试'));},5000);
    channel.port1.onmessage=event=>{if(event.data?.version===1){cleanup();if(event.data.error)reject(Error(uiLiteral('操作失败，请重试')));else resolve();}};
    signal.addEventListener('abort',abort,{once:true});
    try {
      // Safari cannot reliably clone CryptoKey into a Service Worker. Transfer
      // ownership of this isolated source key; the worker imports encrypt-only
      // and erases the buffer before acknowledging or queueing the source job.
      controller.postMessage({type:'quiet-room-cipher-transfer',id:task.id,...(source?{source}:{})},[channel.port2,...(source?[source.keyBytes.buffer]:[])]);
    } catch(error) {cleanup();reject(error);}
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
  } finally {if(source?.keyBytes.byteLength)source.keyBytes.fill(0);}
}
export async function cancelCipherTransfer(id:string):Promise<void> {
  const task=await transact<CipherTransfer|undefined>('readwrite',(tx,done)=>{
    const store=tx.objectStore('tasks'),read=store.get(id);
    read.onsuccess=()=>{
      const current=read.result as CipherTransfer|undefined;if(!current){done(undefined);return;}
      store.put({...current,state:'cancelled',token:'',updated:Date.now()});
      const cursor=tx.objectStore('parts').index('taskId').openCursor(IDBKeyRange.only(id));
      cursor.onsuccess=()=>{if(cursor.result){cursor.result.delete();cursor.result.continue();}else done(current);};
    };
  });
  if(!task)return;
  navigator.serviceWorker?.controller?.postMessage({type:'quiet-room-cipher-transfer-cancel',id});
  await retireTransferGrant(task);
}
