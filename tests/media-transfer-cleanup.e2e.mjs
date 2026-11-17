import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server=await createServer({configFile:false,appType:'custom',root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false}});
server.middlewares.use('/__cleanup',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><main id="app"></main>');});
await server.listen();
try{
  for(const engine of [chromium,webkit]){
    const browser=await engine.launch(engine===chromium&&!process.env.CI?{channel:'chrome'}:{});
    try{
      const page=await browser.newPage({locale:'zh-CN'});
      await page.goto(`http://localhost:${server.httpServer.address().port}/__cleanup`);
      const result=await page.evaluate(async()=>{
        const v=await import('/src/lib/vault.ts'),c=await import('/src/lib/cipher-transfer.ts');
        const {encryptFileAttachment}=await import('/src/lib/file-crypto.ts');
        const {TRANSFER_RETENTION_MS:day}=await import('/src/lib/media-retention.ts');
        const own={deviceId:crypto.randomUUID(),role:'creator',status:'active'};
        const session=await v.createVault({v:1,roomId:crypto.randomUUID(),accessToken:'fixture',role:'creator',protocol:'legacy-v1',lastSeq:0,members:[own],identity:{publicBundle:own}},'cleanup-fixture-password','password');
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const tx=(stores,fn)=>new Promise((resolve,reject)=>{const t=db.transaction(stores,'readwrite');fn(t);t.oncomplete=resolve;t.onabort=()=>reject(t.error);});
        const read=(store)=>new Promise((resolve,reject)=>{const t=db.transaction(store),r=t.objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const manifests=[],plans=[];
        for(let i=0;i<7;i++){
          const manifest=await encryptFileAttachment(new File([new Uint8Array([1,2,3,4])],`fixture-${i}.txt`,{type:'text/plain'}),{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async()=>{},complete:async()=>{},savePlan:async plan=>{plans[i]=plan;}});
          manifests.push(manifest);await v.saveCachedMediaChunk(session,manifest.blobId,0,new Uint8Array(20).buffer);
        }
        const payload=i=>({v:1,kind:'file',file:manifests[i],sentAt:new Date().toISOString()});
        // Chat, Safe-only, and durable outbox references are independent.
        for(const [i,seq] of [[0,1],[1,2]])await v.saveHistoryMessage(session,{seq,clientMsgId:crypto.randomUUID(),senderId:own.deviceId,payload:payload(i),status:'sent',createdAt:new Date().toISOString()});
        await tx(['history'],t=>{const r=t.objectStore('history').openCursor();r.onsuccess=()=>{if(r.result){if(r.result.value.seq===2)r.result.delete();r.result.continue();}};});
        await v.withVaultMutation(session,mutation=>v.saveOutboxItem(session,{clientMsgId:crypto.randomUUID(),payload:payload(2),createdAt:new Date().toISOString(),envelope:{v:1,clientMsgId:crypto.randomUUID(),ciphertext:'fixture-envelope'}},mutation));
        const taskIds=[];
        const transferDB=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room-cipher-transfers-v1',1);r.onupgradeneeded=()=>{r.result.createObjectStore('tasks',{keyPath:'id'});const p=r.result.createObjectStore('parts',{keyPath:'id'});p.createIndex('taskId','taskId');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const putTasks=(tasks,orphan=false)=>new Promise((resolve,reject)=>{const t=transferDB.transaction(['tasks','parts'],'readwrite');for(const task of tasks){t.objectStore('tasks').put(task);t.objectStore('parts').put({id:task.id+':0',taskId:task.id,index:0,bytes:new Uint8Array(20).buffer});}if(orphan)t.objectStore('parts').put({id:'orphan:0',taskId:'orphan',index:0,bytes:new Uint8Array(20).buffer});t.oncomplete=resolve;t.onabort=()=>reject(t.error);});
        const now=Date.now(),tasks=[];
        for(let i=0;i<7;i++){
          const id=c.cipherTransferId(session.vault.roomId,own.deviceId,manifests[i].blobId,'upload');taskIds.push(id);
          tasks.push({id,roomId:session.vault.roomId,deviceId:own.deviceId,blobId:manifests[i].blobId,direction:'upload',chunkSize:2097152,chunkCount:1,originalSize:4,token:'',expiresAt:now+day,state:i===6?'done':'paused',updated:i===4?now:now-day-1});
        }
        await putTasks(tasks,true);
        await v.saveUploadPlan(session,{...plans[3],transferIntent:{transferId:taskIds[3],clientMsgId:crypto.randomUUID(),payload:payload(3)}});
        // A fresh transfer intent protects its cached original too.
        await v.saveUploadPlan(session,{...plans[4],transferIntent:{transferId:taskIds[4],clientMsgId:crypto.randomUUID(),payload:payload(4)}});
        await tx(['mediaCacheEntries'],t=>{const r=t.objectStore('mediaCacheEntries').openCursor();r.onsuccess=()=>{if(r.result){r.result.update({...r.result.value,usedAt:now-day-1});r.result.continue();}};});
        const outboxBefore=JSON.stringify(await v.loadOutbox(session)),plansBefore=JSON.stringify(await v.loadUploadPlans(session));
        const expired=await c.cleanupCipherTransfers(now);
        const expiredTransferIds=new Set(expired.map(task=>task.id));
        const removed=await v.cleanupUnusedMediaCache(session,{signal:new AbortController().signal,now,expiredTransferIds});
        const remaining=(await read('mediaCacheEntries')).map(row=>row.id.split('\0').at(-1));
        const counts=await new Promise(resolve=>{const t=transferDB.transaction(['tasks','parts']),r=t.objectStore('parts').getAll();r.onsuccess=()=>resolve(r.result.map(row=>row.taskId));});
        let lateWriteRejected=false;try{await c.stageCipherPart(tasks[3],0,new Uint8Array(20).buffer);}catch{lateWriteRejected=true;}
        const first={expired:expired.length,remaining:remaining.map(id=>manifests.findIndex(m=>m.blobId===id)).sort(),removed:removed.length,parts:counts.length,onlyFreshPart:counts[0]===taskIds[4],lateWriteRejected,outboxIntact:outboxBefore===JSON.stringify(await v.loadOutbox(session)),plansIntact:plansBefore===JSON.stringify(await v.loadUploadPlans(session))};
        // Explicit cancel cleans immediately, including an unreferenced warm copy.
        await c.cancelCipherTransfer(taskIds[4]);await v.deleteUploadPlan(session,manifests[4].blobId);
        const cancelled=await v.cleanupUnusedMediaCache(session,{signal:new AbortController().signal,immediateBlobIds:new Set([manifests[4].blobId])});
        // Authenticated data corruption must stop collection, leaving candidates.
        await v.saveCachedMediaChunk(session,manifests[5].blobId,0,new Uint8Array(20).buffer);
        await tx(['history'],t=>{const r=t.objectStore('history').openCursor();r.onsuccess=()=>{if(r.result){r.result.update({...r.result.value,ciphertext:'broken'});}};});
        let closed=false;try{await v.cleanupUnusedMediaCache(session,{signal:new AbortController().signal,immediateBlobIds:new Set([manifests[5].blobId])});}catch{closed=true;}
        const protectedAfterCorruption=!!await v.loadCachedMediaChunk(session,manifests[5].blobId,0,20);
        // Cancelled tombstones are bounded, while their missing-task fence still
        // prevents delayed writers from putting bytes back.
        await c.cleanupCipherTransfers(now+day+1);
        let afterRemovalRejected=false;try{await c.stageCipherPart(tasks[3],0,new Uint8Array(20).buffer);}catch{afterRemovalRejected=true;}
        db.close();transferDB.close();
        return {...first,cancelled:cancelled.includes(manifests[4].blobId),closed,protectedAfterCorruption,afterRemovalRejected};
      });
      assert.deepEqual(result,{expired:6,remaining:[0,1,2,4],removed:3,parts:1,onlyFreshPart:true,lateWriteRejected:true,outboxIntact:true,plansIntact:true,cancelled:true,closed:true,protectedAfterCorruption:true,afterRemovalRejected:true});
      console.log(`${engine.name()} media transfer cleanup passed`);
    }finally{await browser.close();}
  }
}finally{await server.close();}
