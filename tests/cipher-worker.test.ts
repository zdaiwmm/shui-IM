import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Execute the production worker against an in-memory IDB adapter. Real browser
// transaction, lifecycle and quota behavior remains separate E2E acceptance.
async function worker(task: any, fetcher: (url:string,init:any)=>Promise<Response>, parts = new Map<string, any>()) {
  const tasks = new Map([[task.id,structuredClone(task)]]), listeners = new Map<string,any>();
  const db = { close() {}, transaction() {
    let pending = 0, aborted = false, version = 0;
    const tx:any = { abort() {if(aborted)return;aborted=true;queueMicrotask(()=>tx.onabort?.());}, objectStore(name:string) {
      const values=name==='tasks'?tasks:parts;
      const request=(read:()=>any)=>{
        const r:any={};pending++;const own=++version;
        queueMicrotask(()=>{if(aborted)return;r.result=read();r.onsuccess?.();pending--;const at=version;
          setTimeout(()=>{if(!aborted&&!pending&&at===version&&own<=version){aborted=true;tx.oncomplete?.();}},0);});return r;
      };
      return {get:(id:string)=>request(()=>structuredClone(values.get(id))),put:(row:any)=>request(()=>{values.set(row.id,structuredClone(row));return row.id;})};
    }};return tx;
  }};
  const indexedDB={open(){const r:any={result:db};queueMicrotask(()=>r.onsuccess?.());return r;}};
  const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt']);
  vm.runInNewContext(await readFile(new URL('../public/cipher-transfers.js',import.meta.url),'utf8'),{
    self:{location:{origin:'https://ai.shui.click'},addEventListener:(name:string,fn:any)=>listeners.set(name,fn)},
    indexedDB,fetch:fetcher,URL,Response,ArrayBuffer,Uint8Array,DataView,TextEncoder,CryptoKey:key.constructor,crypto,AbortController,Date,Error,Map,Set,
  });
  async function run(source?:unknown) {
    let wait:Promise<unknown>|undefined;
    listeners.get('message')({data:{type:'quiet-room-cipher-transfer',id:task.id,...(source?{source}:{})},source:{url:'https://ai.shui.click/'},
      waitUntil:(promise:Promise<unknown>)=>{wait=promise;}});
    await wait;
  }
  return {tasks,parts,run};
}
function task(direction='download') {
  const roomId=crypto.randomUUID(),deviceId=crypto.randomUUID(),blobId=crypto.randomUUID();
  return {id:[roomId,deviceId,blobId,direction,crypto.randomUUID()].join(':'),roomId,deviceId,blobId,direction,
    originalSize:4,chunkSize:2097152,chunkCount:1,token:'a'.repeat(43),expiresAt:Date.now()+60_000,state:'ready',updated:Date.now()};
}

describe('isolated ciphertext worker',()=>{
  it('downloads ciphertext using only a scoped grant and commits a complete task',async()=>{
    const input=task(),calls:any[]=[];
    const fixture=await worker(input,async(url,init)=>{calls.push({url,init});return new Response(new Uint8Array(20),{headers:{'Content-Length':'20'}});});
    await fixture.run();
    expect(fixture.tasks.get(input.id)).toMatchObject({state:'done',token:''});
    expect(fixture.parts.get(input.id+':0').bytes.byteLength).toBe(20);
    expect(calls).toHaveLength(2);expect(calls[1].url).toMatch(/\/done$/);
    expect(calls[0].init.headers.Authorization).toBe('Transfer '+input.token);
    expect(calls[0].init.credentials).toBe('omit');
    expect(JSON.stringify([...fixture.tasks.values()])).not.toContain('key');
  });
  it('cannot publish a chunk or resurrect a task cancelled during network I/O',async()=>{
    const input=task();let fixture:Awaited<ReturnType<typeof worker>>;
    fixture=await worker(input,async()=>{fixture.tasks.set(input.id,{...input,state:'cancelled',token:''});return new Response(new Uint8Array(20));});
    await fixture.run();expect(fixture.tasks.get(input.id).state).toBe('cancelled');expect(fixture.parts.size).toBe(0);
  });
  it('rejects a truncated encrypted chunk without marking success',async()=>{
    const input=task(),fixture=await worker(input,async()=>new Response(new Uint8Array(19)));
    await fixture.run();expect(fixture.tasks.get(input.id).state).toBe('paused');expect(fixture.parts.size).toBe(0);
  });
  it('encrypts source chunks independently without persisting source keys or URLs',async()=>{
    const input={...task('source'),chunkSize:1024**2,originalSize:0,chunkCount:0,token:''};
    const raw=crypto.getRandomValues(new Uint8Array(32)),prefix=crypto.getRandomValues(new Uint8Array(8));
    const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
    const bytes=new Uint8Array(1024**2+5);bytes.fill(73);
    const fixture=await worker(input,async()=>new Response(bytes,{headers:{'content-length':String(bytes.length),etag:'"source-a"'}}));
    await fixture.run({url:'https://video.twimg.com/example.mp4',key,ivPrefix:prefix});
    expect(fixture.tasks.get(input.id)).toMatchObject({state:'done',originalSize:bytes.length,chunkCount:2});
    expect(fixture.parts.size).toBe(2);
    const iv=new Uint8Array(12);iv.set(prefix);new DataView(iv.buffer).setUint32(8,1,false);
    const decryptKey=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(input.id+':1')},decryptKey,fixture.parts.get(input.id+':1').bytes);
    expect([...new Uint8Array(plain)]).toEqual([73,73,73,73,73]);
    const persisted=JSON.stringify([...fixture.tasks.values()]);expect(persisted).not.toContain('video.twimg.com');expect(persisted).not.toContain('ivPrefix');
  });
  it('requires a new source generation when the origin ignores Range',async()=>{
    const input={...task('source'),chunkSize:1024**2,originalSize:2*1024**2,receivedBytes:1024**2,chunkCount:0,token:'',etag:'"old"'};
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt']);
    let headers:any;
    const fixture=await worker(input,async(_url,init)=>{headers=init.headers;return new Response(new Uint8Array(4),{status:200,headers:{etag:'"new"'}});});
    await fixture.run({url:'https://video.twimg.com/example.mp4',key,ivPrefix:new Uint8Array(8)});
    expect(headers).toMatchObject({Range:`bytes=${1024**2}-`,'If-Range':'"old"'});
    expect(fixture.tasks.get(input.id).state).toBe('restart');expect(fixture.parts.size).toBe(0);
  });
  it('finishes a committed EOF checkpoint without re-encrypting or requesting an invalid Range',async()=>{
    const input={...task('source'),chunkSize:1024**2,originalSize:5,receivedBytes:5,chunkCount:0,token:'',etag:'"old"'};
    const bytes=new Uint8Array(21).buffer;
    const parts=new Map([[input.id+':0',{id:input.id+':0',taskId:input.id,index:0,bytes}]]);
    let requests=0;
    const fixture=await worker(input,async()=>{requests++;throw Error('Must not fetch at EOF');},parts);
    const key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt']);
    await fixture.run({url:'https://video.twimg.com/example.mp4',key,ivPrefix:new Uint8Array(8)});
    expect(requests).toBe(0);expect(fixture.tasks.get(input.id)).toMatchObject({state:'done',chunkCount:1});
    expect(fixture.parts.get(input.id+':0').bytes).toEqual(bytes);
  });
});
