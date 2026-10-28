import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';

// Real encrypted archives, browser persistence and native Chromium quota; synthetic data only.
async function verifyCleanupGuards(browser,url){
 const context=await browser.newContext({locale: 'zh-CN'}),page=await context.newPage();await page.goto(url);
 try{return await page.evaluate(async()=>{
  const v=await import('/src/lib/vault.ts'),a=await import('/src/lib/room-archive.ts'),c=await import('/src/lib/crypto.ts'),k=await import('/src/lib/browser-room-key.ts'),files=await import('/src/lib/file-crypto.ts');
  const require=(condition,message)=>{if(!condition)throw Error(message);},signal=new AbortController().signal;
  const identity=await c.generateIdentity(),roomId=crypto.randomUUID();await v.selectLocalSpace(crypto.randomUUID());
  const s=await v.createVault({v:3,roomId,accessToken:'synthetic',role:'creator',pairingSecret:'',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null}],lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:'2026-10-27T00:00:00Z',creatorFingerprint:'synthetic',protocol:'mls-rfc9420'},'','platform',await k.automaticRoomCredential());
  const scope=s.vault.localDataScope??roomId,origin=crypto.randomUUID(),sourceScope=`${scope}:private:${origin}`,chunks=new Map();
  const manifest=await files.encryptFileAttachment(new File([new Uint8Array(128)],'synthetic.bin',{type:'application/octet-stream'}),{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async(_id,index,raw)=>chunks.set(index,raw),complete:async()=>{},savePlan:async()=>{}});
  const item={originRoomId:origin,sourceScope,self:true,message:{seq:1,clientMsgId:crypto.randomUUID(),senderId:identity.publicBundle.deviceId,payload:{v:1,kind:'file',file:manifest,sentAt:'2026-10-27T00:00:00Z'},acceptedAt:'2026-10-27T00:00:00Z',status:'stored'}};
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const all=async name=>new Promise((resolve,reject)=>{const tx=db.transaction(name),r=tx.objectStore(name).getAll();tx.oncomplete=()=>resolve(r.result.filter(x=>x.roomId===scope||x.roomId?.startsWith(scope+':')));tx.onabort=()=>reject(tx.error);});
  const put=async(name,row)=>new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite');tx.objectStore(name).put(row);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const collect=()=>navigator.locks.request(`quiet-room:archive-restore:${roomId}`,()=>v.collectAbandonedPrivateArchiveImports(s,`quiet-room:archive-restore:${roomId}`));
  try{
   for(const [index,raw]of chunks)await v.savePrivateMediaChunk(a.privateItemSession(s,item),manifest.blobId,index,raw,signal);await v.savePrivateArchiveItem(s,item);
   const published=(await all('privateMedia'))[0];
   // Unknown key layouts and non-private namespaces are outside collection authority.
   await v.savePrivateMediaChunk(s,crypto.randomUUID(),0,new Uint8Array(32).buffer,signal);
   const root=(await all('privateMedia')).find(x=>x.roomId===scope),unknown={...published,id:`${sourceScope}:unknown-format:0`},malformed={...published,id:`${sourceScope}:${'a'.repeat(36)}:0`};await put('privateMedia',unknown);await put('privateMedia',malformed);
   const orphanBlob=crypto.randomUUID();await v.savePrivateMediaChunk(a.privateItemSession(s,item),orphanBlob,0,new Uint8Array(32).buffer,signal);
   const run=crypto.randomUUID(),otherOrigin=crypto.randomUUID(),otherScope=`${scope}:private:${otherOrigin}`;
   await v.stagePrivateArchiveMedia(s,run,otherScope,crypto.randomUUID(),0,new Uint8Array(32).buffer,signal);await v.stagePrivateArchiveItem(s,run,{...item,originRoomId:otherOrigin,sourceScope:otherScope,message:{...item.message,clientMsgId:crypto.randomUUID()}},signal);
   const before={media:await all('privateMedia'),staging:await all('privateArchiveStaging')};await v.collectAbandonedPrivateArchiveImports(s,`quiet-room:archive-restore:${roomId}`);require(JSON.stringify({media:await all('privateMedia'),staging:await all('privateArchiveStaging')})===JSON.stringify(before),'Collection without owning the restore lock changed data');
   let release,entered;const ready=new Promise(r=>entered=r),active=navigator.locks.request(`quiet-room:archive-restore:${crypto.randomUUID()}`,async()=>{entered();await new Promise(r=>release=r);});await ready;
   try{await collect();require(JSON.stringify({media:await all('privateMedia'),staging:await all('privateArchiveStaging')})===JSON.stringify(before),'Active restore data was collected');}finally{release();await active;}
   await collect();const retained=await all('privateMedia');require(retained.length===4&&!retained.some(x=>x.id.endsWith(`:${orphanBlob}:0`)),'Legacy orphan was not collected');
   for(const expected of [published,root,unknown,malformed])require(retained.some(x=>JSON.stringify(x)===JSON.stringify(expected)),'Published or unknown original changed');require((await all('privateArchiveStaging')).length===0,'Abandoned staging survived safe collection');
   // Without lock inventory there is no proof of exclusive legacy ownership.
   await v.savePrivateMediaChunk(a.privateItemSession(s,item),orphanBlob,0,new Uint8Array(32).buffer,signal);
   const descriptor=Object.getOwnPropertyDescriptor(navigator,'locks'),ownRun=crypto.randomUUID();
   Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});try{
    const before=JSON.stringify(await all('privateMedia'));await v.collectAbandonedPrivateArchiveImports(s,'unproven');require(JSON.stringify(await all('privateMedia'))===before,'No-lock cleanup removed legacy data');
    await v.stagePrivateArchiveMedia(s,ownRun,otherScope,crypto.randomUUID(),0,new Uint8Array(32).buffer,signal);await v.discardPrivateArchiveStaging(s,ownRun);require((await all('privateArchiveStaging')).length===0,'No-lock own staging survived cancellation');require(JSON.stringify(await all('privateMedia'))===before,'No-lock cancellation left an owned original');
   }finally{if(descriptor)Object.defineProperty(navigator,'locks',descriptor);else delete navigator.locks;}
   // A concurrent permanent writer wins; the importing transaction must abort.
   const conflictRun=crypto.randomUUID(),blob=crypto.randomUUID(),raw=new Uint8Array(32).buffer;
   await v.stagePrivateArchiveMedia(s,conflictRun,otherScope,blob,0,raw,signal);await v.stagePrivateArchiveItem(s,conflictRun,{...item,originRoomId:otherOrigin,sourceScope:otherScope,message:{...item.message,clientMsgId:crypto.randomUUID()}},signal);
   await new Promise((resolve,reject)=>{const tx=db.transaction('privateMedia','readwrite');tx.objectStore('privateMedia').delete(`${otherScope}:${blob}:0`);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});await v.savePrivateMediaChunk(a.privateItemSession(s,{...item,sourceScope:otherScope}),blob,0,raw,signal);const writer=(await all('privateMedia')).find(x=>x.id===`${otherScope}:${blob}:0`),revision=(await v.readPrivateCatalogMeta(s)).revision;
   let aborted=false;try{await v.commitPrivateArchiveImport(s,conflictRun,signal);}catch{aborted=true;}require(aborted,'Concurrent media writer was overwritten');await v.discardPrivateArchiveStaging(s,conflictRun);
   require((await v.readPrivateCatalogMeta(s)).revision===revision&&(await v.loadPrivateArchiveItems(s)).length===1,'Conflict published messages');require((await all('privateMedia')).some(x=>JSON.stringify(x)===JSON.stringify(writer)),'Concurrent original changed');
   // Repairing a missing chunk of an already-published message must survive cancellation.
   await new Promise((resolve,reject)=>{const tx=db.transaction('privateMedia','readwrite');tx.objectStore('privateMedia').delete(published.id);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
   const repairRun=crypto.randomUUID();await v.stagePrivateArchiveMedia(s,repairRun,sourceScope,manifest.blobId,0,chunks.get(0),signal,true);await v.discardPrivateArchiveStaging(s,repairRun);
   const repaired=await v.loadPrivateMediaChunk(a.privateItemSession(s,item),manifest.blobId,0,chunks.get(0).byteLength);require(repaired&&new Uint8Array(repaired).every((byte,n)=>byte===new Uint8Array(chunks.get(0))[n]),'Cancelled repair removed a published original');
   // Corruption must stop collection before any ciphertext or staging deletion.
   const corruptRun=crypto.randomUUID();await v.stagePrivateArchiveMedia(s,corruptRun,otherScope,crypto.randomUUID(),0,raw,signal);
   const record=(await all('privateArchive'))[0];await put('privateArchive',{...record,ciphertext:record.ciphertext.slice(1)+record.ciphertext[0]});
   const beforeCorrupt=JSON.stringify({media:await all('privateMedia'),staging:await all('privateArchiveStaging')});let blocked=false;try{await collect();}catch{blocked=true;}require(blocked,'Corrupt published history did not stop collection');require(JSON.stringify({media:await all('privateMedia'),staging:await all('privateArchiveStaging')})===beforeCorrupt,'Corrupt history cleanup lost data');
   return {activeRestoreProtected:true,legacyCollected:true,publishedAndUnknownPreserved:true,noLocksConservative:true,concurrentWriterProtected:true,publishedRepairRetained:true,corruptionFailsClosed:true};
  }finally{db.close();}
 });}finally{await context.close();}
}

async function verifyConcurrentRestores(browser,url,fixture){
 const context=await browser.newContext({locale: 'zh-CN'}),page=await context.newPage();await page.goto(url);
 try{return await page.evaluate(async fixture=>{
  const v=await import('/src/lib/vault.ts'),a=await import('/src/lib/room-archive.ts'),c=await import('/src/lib/crypto.ts'),k=await import('/src/lib/browser-room-key.ts'),files=await import('/src/lib/file-crypto.ts');
  const require=(value,message)=>{if(!value)throw Error(message);},identity=await c.generateIdentity(),roomId=crypto.randomUUID();await v.selectLocalSpace(crypto.randomUUID());
  const s=await v.createVault({v:3,roomId,accessToken:'synthetic',role:'creator',pairingSecret:'',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null}],lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:'2026-10-27T00:00:00Z',creatorFingerprint:'synthetic',protocol:'mls-rfc9420'},'','platform',await k.automaticRoomCredential());
  const scope=s.vault.localDataScope??roomId,descriptor=Object.getOwnPropertyDescriptor(navigator,'locks'),nativePut=IDBObjectStore.prototype.put,namespaces=new Set();
  Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
  IDBObjectStore.prototype.put=function(value,...args){if(this.name==='privateMedia'&&value?.roomId?.startsWith(`${scope}:private:`))namespaces.add(value.roomId);return nativePut.call(this,value,...args);};
  let firstError,completed;const cancelled=new AbortController();
  try{
   const first=a.restoreRoomArchive(s,fixture.key,cancelled.signal,done=>{if(done===1)cancelled.abort();}).catch(cause=>{firstError=cause.name;});
   const second=a.restoreRoomArchive(s,fixture.key,new AbortController().signal,()=>{}).then(n=>{completed=n;});await Promise.all([first,second]);
  }finally{IDBObjectStore.prototype.put=nativePut;if(descriptor)Object.defineProperty(navigator,'locks',descriptor);else delete navigator.locks;}
  require(firstError==='AbortError'&&completed===3,'Concurrent cancellation outcome mismatch');require(namespaces.size>=2,'Concurrent fixture did not allocate independent unpublished namespaces');
  const items=await v.loadPrivateArchiveItems(s);require(items.length===3,'Concurrent restores duplicated or lost messages');
  const referenced=new Set();for(const item of items){if(item.message.payload.kind!=='file')continue;const m=item.message.payload.file;for(let n=0;n<m.chunkCount;n++)referenced.add(`${item.sourceScope}:${m.blobId}:${n}`);
   const blob=await files.decryptFileAttachment(m,(id,index)=>v.loadPrivateMediaChunk(a.privateItemSession(s,item),id,index,Math.min(m.chunkSize,m.originalSize-index*m.chunkSize)+16));const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),x=>x.toString(16).padStart(2,'0')).join('');require(digest===m.sha256,'Other run cancellation damaged the successful original');
  }
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{
   const all=async name=>new Promise((resolve,reject)=>{const tx=db.transaction(name),r=tx.objectStore(name).getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});
   require((await all('privateArchiveStaging')).length===0,'Concurrent cancellation retained witnesses');const media=await all('privateMedia');require(media.length===3&&media.every(x=>referenced.has(x.id)),'Concurrent run left or removed originals');
  }finally{db.close();}
  return {distinctUnpublishedNamespaces:true,cancelledRunRemovedOnlyOwnData:true,publishedOriginalsMatch:true};
 },fixture);}finally{await context.close();}
}

const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-restore-validation-'));
const results=[];let service,vite,browser;
const output=process.env.RESTORE_VALIDATION_OUTPUT;
try{
 const selection=process.env.RESTORE_VALIDATION_CASE;
 for(const engine of selection==='real-quota'||selection==='quota-followup'?[chromium]:selection==='cancel-two-archives'?[webkit]:[chromium,webkit]){
  service=await startServer({port:0,host:'127.0.0.1',dataDir:path.join(dataDir,engine.name()),quiet:true});
  vite=await createServer({root:process.cwd(),configFile:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${service.port}`}},plugins:[{name:'local-restore-validation',configureServer(s){s.middlewares.use('/__restore_validation',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');});}}]});
  await vite.listen();const url=`http://127.0.0.1:${vite.httpServer.address().port}/__restore_validation`;
  browser=await engine.launch(engine===webkit?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
  const sourceContext=await browser.newContext({locale: 'zh-CN'}),source=await sourceContext.newPage();await source.goto(url);
  const fixtures=await source.evaluate(async({withSmall})=>{
   const v=await import('/src/lib/vault.ts'),a=await import('/src/lib/room-archive.ts'),c=await import('/src/lib/room-archive-crypto.ts'),k=await import('/src/lib/browser-room-key.ts'),api=await import('/src/lib/api.ts'),cryptoLib=await import('/src/lib/crypto.ts'),files=await import('/src/lib/file-crypto.ts'),{randomBase64Url}=await import('/src/lib/base64.ts');
   const create=async()=>{const identity=await cryptoLib.generateIdentity(),token=randomBase64Url(32),roomId=crypto.randomUUID(),caps=['room-archive-v2'];const room=await api.createRoom(identity.publicBundle,token,randomBase64Url(32),'synthetic',caps,undefined,roomId);await v.selectLocalSpace(crypto.randomUUID());return v.createVault({v:3,roomId,accessToken:token,role:'creator',pairingSecret:'',creatorFingerprint:'synthetic',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null,capabilities:caps}],lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:room.createdAt,protocol:'mls-rfc9420',roomArchiveV2:{key:c.newArchiveKey()}},'','platform',await k.automaticRoomCredential());};
   const make=async(label,small=false)=>{const session=await create(),expected=[];const stamp=new Date().toISOString();
    for(const [seq,size] of small?[[1,1024*1024+17]]:[[1,3*1024*1024+321],[3,64*1024+17]]){const raw=new Uint8Array(size);for(let n=0;n<raw.length;n+=65536)crypto.getRandomValues(raw.subarray(n,Math.min(n+65536,raw.length)));const file=new File([raw],`synthetic-${label}-${seq}.bin`,{type:'application/octet-stream'}),chunks=new Map();const manifest=await files.encryptFileAttachment(file,{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async(_id,index,bytes)=>chunks.set(index,bytes),complete:async()=>{},savePlan:async()=>{}});for(const [index,bytes]of chunks)await v.saveCachedMediaChunk(session,manifest.blobId,index,bytes);await v.saveHistoryMessage(session,{seq,clientMsgId:crypto.randomUUID(),senderId:session.vault.identity.publicBundle.deviceId,payload:{v:1,kind:'file',file:manifest,sentAt:stamp},acceptedAt:stamp,status:'stored'});expected.push({size,sha256:manifest.sha256});}
    await v.saveHistoryMessage(session,{seq:2,clientMsgId:crypto.randomUUID(),senderId:session.vault.identity.publicBundle.deviceId,payload:{v:1,kind:'text',text:'Synthetic restored text',sentAt:stamp},acceptedAt:stamp,status:'stored'});session.vault.lastSeq=small?2:3;await v.saveVault(session);const outcome=await a.syncRoomArchive(session,new AbortController().signal);if(outcome.kind!=='complete')throw Error('Source fixture backup incomplete');return {key:session.vault.roomArchiveV2.key,roomId:session.vault.roomId,expected};
   };return [await make('A'),await make('B'),...(withSmall?[await make('small',true)]:[])];
  },{withSmall:true});await sourceContext.close();
  const cases=selection==='quota-followup'?['real-quota-blocks-smaller','real-quota-small-control']:selection==='cancel-two-archives'?['cancel-two-archives']:selection==='real-quota'?['real-quota']:selection==='legacy-published-reimport'?['legacy-published-reimport']:['success','cancel-before-write','cancel-after-media','network-after-media','quota-first-media','quota-second-media','abort-final-commit','cancel-two-archives','cancel-existing','legacy-published-reimport',...(engine===chromium?['real-quota-small-control','real-quota','real-quota-blocks-smaller','real-quota-fit','real-quota-legacy']:[])];
  for(const scenario of cases){
   // Native quota accounting uses an on-disk profile, as normal retained
   // browser data do. Chromium's incognito in-memory backing store has different
   // compaction/close behavior; ordinary fault cases still cover that context.
   const nativeQuota=scenario.startsWith('real-quota');
   const context=nativeQuota?await engine.launchPersistentContext(path.join(dataDir,`quota-${scenario}`),process.env.CHROME_PATH?{locale:'zh-CN',executablePath:process.env.CHROME_PATH}:process.env.CI?{locale:'zh-CN',headless:true}:{locale:'zh-CN',channel:'chrome',headless:true}):await browser.newContext({locale: 'zh-CN'}),page=nativeQuota?context.pages()[0]:await context.newPage();await page.goto(url);let cdp;
   if(scenario.startsWith('real-quota')){cdp=await context.newCDPSession(page);await cdp.send('Storage.overrideQuotaForOrigin',{origin:new URL(url).origin,quotaSize:(scenario==='real-quota-fit'?8:5)*1024*1024});}
   const row=await page.evaluate(async({fixtures,scenario})=>{
    const v=await import('/src/lib/vault.ts'),a=await import('/src/lib/room-archive.ts'),c=await import('/src/lib/room-archive-crypto.ts'),k=await import('/src/lib/browser-room-key.ts'),api=await import('/src/lib/api.ts'),cryptoLib=await import('/src/lib/crypto.ts'),files=await import('/src/lib/file-crypto.ts'),catalog=await import('/src/lib/private-archive-catalog.ts'),{randomBase64Url}=await import('/src/lib/base64.ts');
    const identity=await cryptoLib.generateIdentity(),token=randomBase64Url(32),roomId=crypto.randomUUID(),caps=['room-archive-v2'];const room=await api.createRoom(identity.publicBundle,token,randomBase64Url(32),'synthetic',caps,undefined,roomId);await v.selectLocalSpace(crypto.randomUUID());const target=await v.createVault({v:3,roomId,accessToken:token,role:'creator',pairingSecret:'',creatorFingerprint:'synthetic',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null,capabilities:caps}],lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:room.createdAt,protocol:'mls-rfc9420',roomArchiveV2:{key:c.newArchiveKey()}},'','platform',await k.automaticRoomCredential());
    const scope=target.vault.localDataScope??roomId,stamp=new Date().toISOString();
    await v.saveHistoryMessage(target,{seq:1,clientMsgId:crypto.randomUUID(),senderId:identity.publicBundle.deviceId,payload:{v:1,kind:'text',sentAt:stamp,text:'Existing shared synthetic data'},acceptedAt:stamp,status:'stored'});target.vault.lastSeq=1;await v.saveVault(target);
    const oldBytes=new Uint8Array(1024);crypto.getRandomValues(oldBytes);const oldChunks=new Map(),oldManifest=await files.encryptFileAttachment(new File([oldBytes],'existing.bin',{type:'application/octet-stream'}),{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async(_id,index,raw)=>oldChunks.set(index,raw),complete:async()=>{},savePlan:async()=>{}}),oldOrigin=crypto.randomUUID();
    const oldItem={originRoomId:oldOrigin,sourceScope:`${scope}:private:${oldOrigin}`,self:true,message:{seq:1,clientMsgId:crypto.randomUUID(),senderId:identity.publicBundle.deviceId,payload:{v:1,kind:'file',file:oldManifest,sentAt:stamp},acceptedAt:stamp,status:'stored'}};
    for(const [index,bytes]of oldChunks)await v.savePrivateMediaChunk(a.privateItemSession(target,oldItem),oldManifest.blobId,index,bytes,new AbortController().signal);await v.savePrivateArchiveItem(target,oldItem);
    const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    const readStore=async name=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction(name),r=tx.objectStore(name).getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});}finally{db.close();}};
    const snapshot=async()=>{const items=await v.loadPrivateArchiveItems(target),media=(await readStore('privateMedia')).filter(r=>r.id.startsWith(scope+':')),staged=(await readStore('privateArchiveStaging')).filter(r=>r.roomId===scope);const referenced=new Set();for(const item of items)if(item.message.payload.kind==='file'){const m=item.message.payload.file;for(let n=0;n<m.chunkCount;n++)referenced.add(`${item.sourceScope}:${m.blobId}:${n}`);}const orphan=media.filter(r=>!referenced.has(r.id));return {published:items.length,staged:staged.length,media:media.length,unreferencedMedia:orphan.length,unreferencedCipherRecordBytes:orphan.reduce((n,r)=>n+new TextEncoder().encode(JSON.stringify(r)).length,0),revision:(await v.readPrivateCatalogMeta(target)).revision};};
    const oldShared=JSON.stringify(await v.loadHistoryPage(target,{limit:100})),oldPrivate=JSON.stringify(oldItem),oldVault=JSON.stringify(await v.readStoredRoom(v.vaultSpaceId(target.stored))),baseline=await snapshot();
    const intact=async()=>{const items=await v.loadPrivateArchiveItems(target),item=items.find(x=>x.originRoomId===oldOrigin);let original=false;if(item){const blob=await files.decryptFileAttachment(item.message.payload.file,(id,index)=>v.loadPrivateMediaChunk(a.privateItemSession(target,item),id,index,oldChunks.get(index).byteLength));original=await digest(await blob.arrayBuffer())===await digest(oldBytes.buffer);}return {sharedUnchanged:JSON.stringify(await v.loadHistoryPage(target,{limit:100}))===oldShared,privateUnchanged:JSON.stringify(item)===oldPrivate,originalUnchanged:original};};
    // Legacy releases wrote originals before publication. Seed only synthetic
    // unreferenced ciphertext, never a real archive or user's storage.
    if(scenario==='real-quota-legacy')await v.savePrivateMediaChunk(a.privateItemSession(target,{...oldItem,sourceScope:`${scope}:private:${crypto.randomUUID()}`}),crypto.randomUUID(),0,new Uint8Array(2*1024*1024+16).buffer,new AbortController().signal);
    if(scenario==='cancel-existing')await a.restoreRoomArchive(target,fixtures[0].key,new AbortController().signal,()=>{});
    if(scenario==='legacy-published-reimport'){
     await a.restoreRoomArchive(target,fixtures[0].key,new AbortController().signal,()=>{});
     const items=(await v.loadPrivateArchiveItems(target)).filter(x=>x.originRoomId===fixtures[0].roomId),legacy=[],removeMedia=[];
     for(const item of items){const copy={...item,sourceScope:`${scope}:private:${item.originRoomId}`};legacy.push(copy);if(item.message.payload.kind==='file'){const m=item.message.payload.file;for(let index=0;index<m.chunkCount;index++){
      const bytes=await v.loadPrivateMediaChunk(a.privateItemSession(target,item),m.blobId,index,Math.min(m.chunkSize,m.originalSize-index*m.chunkSize)+16);await v.savePrivateMediaChunk(a.privateItemSession(target,copy),m.blobId,index,bytes,new AbortController().signal);removeMedia.push(`${item.sourceScope}:${m.blobId}:${index}`);
     }}}
     // Synthetic fixture conversion only: reseed via the real vault API using
     // the origin-based namespace published by the previous production version.
     const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{await new Promise((resolve,reject)=>{const tx=db.transaction(['privateArchive','privateMedia','privateCatalog'],'readwrite');for(const item of items)tx.objectStore('privateArchive').delete(`${scope}:${item.originRoomId}:${item.message.clientMsgId}`);for(const id of removeMedia)tx.objectStore('privateMedia').delete(id);tx.objectStore('privateCatalog').delete(`${scope}:meta`);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
     for(const item of legacy)await v.savePrivateArchiveItem(target,item);
    }
    const beforeAttempt=await snapshot();
    const nativePut=IDBObjectStore.prototype.put,nativeFetch=window.fetch.bind(window);let active,stage='',mediaAttempts=0,mediaCommitted=0,triggered=0,commitAborts=0;
    const install=(controller,fixture)=>{active=controller;
     IDBObjectStore.prototype.put=function(value,...args){const importedMedia=(this.name==='privateMedia'&&value?.roomId?.startsWith(`${scope}:private:`)&&value.roomId!==oldItem.sourceScope)||(this.name==='privateArchiveStaging'&&value?.kind==='media'&&value.record?.roomId===`${scope}:private:${fixture.roomId}`);const importedRecord=this.name==='privateArchive'&&value?.id?.startsWith(`${scope}:${fixture.roomId}:`);const request=nativePut.call(this,value,...args);const tx=this.transaction;
      if(importedMedia){mediaAttempts++;if((scenario==='quota-first-media'&&mediaAttempts>=1)||(scenario==='quota-second-media'&&mediaAttempts>=2)){request.addEventListener('success',()=>{triggered++;Object.defineProperty(tx,'error',{value:new DOMException('Synthetic storage quota exceeded','QuotaExceededError')});tx.abort();},{once:true});}else tx.addEventListener('complete',()=>{mediaCommitted++;if((scenario==='cancel-after-media'||scenario==='cancel-two-archives')&&mediaCommitted===1){triggered++;controller.abort();}},{once:true});}
      if(importedRecord&&scenario==='abort-final-commit'&&!commitAborts)request.addEventListener('success',()=>{commitAborts++;triggered++;tx.abort();},{once:true});return request;
     };
     window.fetch=async(input,init)=>{if(scenario==='network-after-media'&&stage==='restoring'&&mediaCommitted>=1&&(init?.method??'GET')==='GET'&&String(input).includes('/api/private-archives/')){triggered++;throw new TypeError('Synthetic archive read interruption');}return nativeFetch(input,init);};
    };
    const restore=async fixture=>{const controller=new AbortController();stage='';mediaAttempts=0;mediaCommitted=0;install(controller,fixture);if(scenario==='cancel-before-write'){triggered++;controller.abort();}let error=null;try{await a.restoreRoomArchive(target,fixture.key,controller.signal,done=>{if(scenario==='cancel-existing'&&done===1){triggered++;controller.abort();}},s=>{stage=s.stage;});}catch(cause){error={name:cause.name,message:cause.message};}finally{IDBObjectStore.prototype.put=nativePut;window.fetch=nativeFetch;}return error;};
    const error=await restore(scenario==='real-quota-small-control'||scenario==='real-quota-legacy'?fixtures[2]:fixtures[0]),after=await snapshot(),preserved=await intact(),vaultUnchanged=JSON.stringify(await v.readStoredRoom(v.vaultSpaceId(target.stored)))===oldVault;
    const smallerAttempt=null;
    let secondFailure=null,afterSecond=null;
    if(scenario==='cancel-two-archives'){secondFailure=await restore(fixtures[1]);afterSecond=await snapshot();}
    let visibleAfterFailure=null;try{const m=await catalog.ensurePrivateCatalog(target,new AbortController().signal);visibleAfterFailure=(await catalog.readPrivateHistoryPage(target,m,new AbortController().signal)).items.length;}catch(cause){visibleAfterFailure={error:cause.name};}
    let stillInsufficient=null;if(scenario.startsWith('quota-'))stillInsufficient=await restore(fixtures[0]);
    window.restoreValidation={target,fixtures,scope,oldShared,oldPrivate,oldOrigin,oldManifest,oldDigest:await digest(oldBytes.buffer),baseline,readStore,snapshot,intact,scenario};
    return {scenario,error,baseline,beforeAttempt,after,preserved,vaultUnchanged,visibleAfterFailure,triggered,mediaAttempts,mediaCommitted,commitAborts,secondFailure,afterSecond,stillInsufficient,smallerAttempt};
   },{fixtures,scenario});
   // Finish the first browser operation before the next restore, as two
   // separate user actions do. Keep the same page, database and native quota;
   // no reload, garbage-collection request or relaxed logical-data assertion.
   if(scenario==='real-quota-blocks-smaller'){
    const started=Date.now(),samples=[];let usage;
    // Deletion and physical reclamation are distinct in Chromium. Do not open
    // IDB while observing its real quota accounting: connections reset the
    // backend's close/compaction grace period. Assert bounded real reclamation
    // before a single subsequent restore; never retry or increase the quota.
    do{usage=await cdp.send('Storage.getUsageAndQuota',{origin:new URL(url).origin});samples.push({ms:Date.now()-started,usage:usage.usage});if(usage.usage<1024*1024)break;await new Promise(resolve=>setTimeout(resolve,250));}while(Date.now()-started<15000);
    row.quotaAfterLargeFailure={usage:usage.usage,breakdown:usage.usageBreakdown,elapsedMs:Date.now()-started,samples};
    assert.ok(usage.usage<1024*1024,`Browser did not reclaim deleted synthetic import within 15s: ${JSON.stringify(row.quotaAfterLargeFailure)}`);
    row.smallerAttempt=await page.evaluate(async()=>{
     const f=window.restoreValidation,a=await import('/src/lib/room-archive.ts');let error=null;
     try{await a.restoreRoomArchive(f.target,f.fixtures[2].key,new AbortController().signal,()=>{});}catch(cause){error={name:cause.name,message:cause.message};}
     return {error,after:await f.snapshot(),preserved:await f.intact()};
    });
   }
   if(cdp){const usage=await cdp.send('Storage.getUsageAndQuota',{origin:new URL(url).origin});row.browserQuota={limit:(scenario==='real-quota-fit'?8:5)*1024*1024,usage:usage.usage};await cdp.send('Storage.overrideQuotaForOrigin',{origin:new URL(url).origin,quotaSize:64*1024*1024});}
   // Reopen through the actual vault path, then retry without the injected fault.
   const persisted=await page.evaluate(async()=>{const f=window.restoreValidation;return {beforeReload:await f.snapshot(),oldOrigin:f.oldOrigin,oldDigest:f.oldDigest,expected:f.fixtures.map(x=>x.expected)};});
   await page.reload();
   const recovery=await page.evaluate(async({fixtures,persisted,scenario})=>{
    const v=await import('/src/lib/vault.ts'),a=await import('/src/lib/room-archive.ts'),k=await import('/src/lib/browser-room-key.ts'),files=await import('/src/lib/file-crypto.ts'),catalog=await import('/src/lib/private-archive-catalog.ts');const target=await v.unlockVault(await k.browserRoomKey(),undefined,await v.readStoredVault()),scope=target.vault.localDataScope??target.vault.roomId;
    const readStore=async name=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});try{return await new Promise((resolve,reject)=>{const tx=db.transaction(name),r=tx.objectStore(name).getAll();tx.oncomplete=()=>resolve(r.result);tx.onabort=()=>reject(tx.error);});}finally{db.close();}};
    const count=async()=>({published:(await v.loadPrivateArchiveItems(target)).length,media:(await readStore('privateMedia')).filter(r=>r.id.startsWith(scope+':')).length,staged:(await readStore('privateArchiveStaging')).filter(r=>r.roomId===scope).length});const reopened=await count();const publishedBeforeRetry=await v.loadPrivateArchiveItems(target);
    let beforeRetryBackup=null;if(scenario!=='success'){const outcome=await a.syncRoomArchive(target,new AbortController().signal);beforeRetryBackup={outcome:outcome.kind,counts:await a.readRoomArchiveCounts(target,new AbortController().signal)};}
    await a.restoreRoomArchive(target,fixtures[0].key,new AbortController().signal,()=>{});if(scenario==='cancel-two-archives')await a.restoreRoomArchive(target,fixtures[1].key,new AbortController().signal,()=>{});const afterRetry=await count();
    const checks=[];for(const item of await v.loadPrivateArchiveItems(target)){if(item.message.payload.kind!=='file')continue;const m=item.message.payload.file,blob=await files.decryptFileAttachment(m,(id,index)=>v.loadPrivateMediaChunk(a.privateItemSession(target,item),id,index,Math.min(m.chunkSize,m.originalSize-index*m.chunkSize)+16));const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),x=>x.toString(16).padStart(2,'0')).join('');checks.push({bytes:blob.size,matching:digest===(item.originRoomId===persisted.oldOrigin?persisted.oldDigest:m.sha256)});}
    await a.restoreRoomArchive(target,fixtures[0].key,new AbortController().signal,()=>{});const afterDuplicateRetry=await count();const meta=await catalog.ensurePrivateCatalog(target,new AbortController().signal),visible=(await catalog.readPrivateHistoryPage(target,meta,new AbortController().signal)).total;
    return {reopened,publishedBeforeRetry:{messages:1+publishedBeforeRetry.length,files:publishedBeforeRetry.filter(x=>x.message.payload.kind==='file').length},beforeRetryBackup,afterRetry,afterDuplicateRetry,originals:checks,visible};
   },{fixtures:scenario==='real-quota-blocks-smaller'||scenario==='real-quota-small-control'||scenario==='real-quota-legacy'?[fixtures[2]]:fixtures,persisted,scenario});
   row.recovery=recovery;row.engine=engine.name();
   if(cdp)console.log(JSON.stringify({nativeQuotaDiagnostic:{scenario,after:row.after,quotaAfterLargeFailure:row.quotaAfterLargeFailure,smallerAttempt:row.smallerAttempt,browserQuota:row.browserQuota}}));
   assert.ok(Object.values(row.preserved).every(Boolean),'Existing shared/private/original data changed');
   assert.equal(row.after.staged,0,'Import retained its staging rows');
   assert.equal(row.after.unreferencedMedia,0,'Unpublished originals survived import');
   const success=['success','legacy-published-reimport','real-quota-small-control','real-quota-fit','real-quota-legacy'].includes(scenario);
   if(success)assert.equal(row.error,null);else{assert.ok(row.error,'Fault was not reached');if(!scenario.startsWith('real-quota'))assert.ok(row.triggered);}
   if(scenario==='real-quota'||scenario==='real-quota-blocks-smaller')assert.equal(row.error?.name,'QuotaExceededError');
   if(!success&&scenario!=='cancel-existing'){assert.equal(row.after.published,row.baseline.published);assert.equal(row.after.media,row.baseline.media);assert.equal(row.after.revision,row.baseline.revision);assert.equal(row.vaultUnchanged,true);}
   if(scenario==='legacy-published-reimport')assert.deepEqual(row.after,row.beforeAttempt,'Legacy published reimport changed namespaces or originals');
   if(scenario==='cancel-existing')assert.deepEqual(row.after,row.beforeAttempt,'Cancelled reimport changed published originals');
   if(row.afterSecond){assert.equal(row.afterSecond.media,row.baseline.media);assert.equal(row.afterSecond.unreferencedMedia,0);assert.equal(row.afterSecond.staged,0);assert.ok(row.secondFailure);}
   if(row.smallerAttempt){assert.equal(row.smallerAttempt.error,null,'Failed large restore blocked a fitting smaller restore');assert.equal(row.smallerAttempt.after.unreferencedMedia,0);assert.ok(Object.values(row.smallerAttempt.preserved).every(Boolean));}
   if(recovery.beforeRetryBackup){assert.equal(recovery.beforeRetryBackup.outcome,'complete');assert.equal(recovery.beforeRetryBackup.counts.messages,recovery.publishedBeforeRetry.messages);assert.equal(recovery.beforeRetryBackup.counts.files,recovery.publishedBeforeRetry.files);}
   assert.deepEqual(recovery.reopened,{published:persisted.beforeReload.published,media:persisted.beforeReload.media,staged:0},'Reload changed saved data or retained staging');
   if(row.stillInsufficient)assert.equal(row.stillInsufficient.name,'QuotaExceededError');
   assert.ok(recovery.originals.every(x=>x.matching),'Recovered original mismatch');
   assert.deepEqual(recovery.afterDuplicateRetry,recovery.afterRetry,'Retry duplicated records or originals');
   assert.equal(recovery.visible,scenario==='real-quota-blocks-smaller'||scenario==='real-quota-small-control'||scenario==='real-quota-legacy'?3:scenario==='cancel-two-archives'?7:4);
   results.push(row);if(output)await writeFile(output,JSON.stringify({version:2,scope:'synthetic restore cleanup regression',results},null,2)+'\n');
   console.log(JSON.stringify({engine:row.engine,scenario,error:row.error?.name??null,after:row.after,visibleAfterFailure:row.visibleAfterFailure,afterSecond:row.afterSecond,smallerAttempt:row.smallerAttempt,reopened:recovery.reopened,afterRetry:recovery.afterRetry,originalsMatch:recovery.originals.every(x=>x.matching)}));await context.close();
  }
  if(!selection){console.log(JSON.stringify({engine:engine.name(),guards:await verifyCleanupGuards(browser,url)}));console.log(JSON.stringify({engine:engine.name(),concurrent:await verifyConcurrentRestores(browser,url,fixtures[0])}));}
  await browser.close();browser=null;await vite.close();vite=null;await service.close();service=null;
 }
 console.log(`RESTORE_CLEANUP_COMPLETE cases=${results.length} output=${output}`);
}finally{await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
