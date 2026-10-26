import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
const perf=process.env.QUIET_ROOM_PRIVATE_PERF==='1';
const baseline=perf?execFileSync('git',['show','14848e71cf0c28753045f7f77200853427797642:src/lib/vault.ts'],{encoding:'utf8'}).replace('const DB_VERSION = 15;','const DB_VERSION = 16;'):'';
const virtual=path.resolve('src/lib/__private_baseline.ts');
const vite=await createServer({root:process.cwd(),configFile:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'private-pagination',enforce:'pre',resolveId:id=>id.endsWith('/__private_baseline.ts')?virtual:null,load:id=>id===virtual?baseline:null,configureServer(s){s.middlewares.use('/__private',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');});}}]});
let browser;
try{await vite.listen();for(const engine of perf?[chromium]:[chromium,webkit]){
 browser=await engine.launch(engine===webkit?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();await page.goto(`http://localhost:${vite.httpServer.address().port}/__private`);
 const upgrade=await page.evaluate(async()=>{
  const old=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room',15);r.onupgradeneeded=()=>r.result.createObjectStore('security');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  await new Promise(resolve=>{const tx=old.transaction('security','readwrite');tx.objectStore('security').put('preserved','synthetic-upgrade');tx.oncomplete=resolve;});
  const v=await import('/src/lib/vault.ts');let blocked=false;try{await v.readPrivateCatalogMeta({vault:{roomId:'synthetic'}});}catch(cause){blocked=/关闭或刷新/.test(cause.message);}old.close();
  const meta=await v.readPrivateCatalogMeta({vault:{roomId:'synthetic'}});const db=await new Promise(resolve=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);});
  const preserved=await new Promise(resolve=>{const tx=db.transaction('security','readonly'),r=tx.objectStore('security').get('synthetic-upgrade');tx.oncomplete=()=>resolve(r.result);});db.close();
  const downgrade=await new Promise(resolve=>{const r=indexedDB.open('quiet-room',15);r.onerror=()=>resolve(r.error.name==='VersionError');r.onsuccess=()=>{r.result.close();resolve(false);};});
  return {blocked,preserved,downgrade,count:meta.rawCount};
 });assert.deepEqual(upgrade,{blocked:true,preserved:'preserved',downgrade:true,count:0});
 const result=await page.evaluate(async({perf})=>{
  const v=await import('/src/lib/vault.ts'),catalog=await import('/src/lib/private-archive-catalog.ts'),c=await import('/src/lib/crypto.ts'),keys=await import('/src/lib/browser-room-key.ts'),cryptoArchive=await import('/src/lib/room-archive-crypto.ts'),{toBase64Url}=await import('/src/lib/base64.ts');
  const signal=new AbortController().signal,encoder=new TextEncoder();
  const create=async()=>{const identity=await c.generateIdentity(),roomId=crypto.randomUUID();await v.selectLocalSpace(crypto.randomUUID());return v.createVault({v:3,roomId,accessToken:'synthetic',role:'creator',pairingSecret:'',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null}],lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:'2026-10-27T00:00:00Z',creatorFingerprint:'synthetic',protocol:'mls-rfc9420',roomArchiveV2:{key:cryptoArchive.newArchiveKey(),cardVerified:true}},'','platform',await keys.automaticRoomCredential());};
  const item=(session,origin,seq,id=crypto.randomUUID())=>({originRoomId:origin,sourceScope:session.vault.localDataScope??session.vault.roomId,self:true,message:{seq,clientMsgId:id,senderId:session.vault.identity.publicBundle.deviceId,status:'stored',acceptedAt:'2026-10-27T00:00:00Z',payload:{v:1,kind:'text',sentAt:'2026-10-27T00:00:00Z',text:'synthetic-private-'+seq}}});
  const s=await create(),origin=crypto.randomUUID(),rows=Array.from({length:205},(_,n)=>item(s,origin,n+1));
  // Seed through the real publication API; no user data or keys are used.
  for(const row of rows)await v.savePrivateArchiveItem(s,row);
  const deletion={...item(s,origin,206),message:{...rows[0].message,seq:206,clientMsgId:crypto.randomUUID(),payload:{v:1,kind:'message-delete',sentAt:'2026-10-27T00:00:00Z',target:{clientMsgId:rows[200].message.clientMsgId,serverSeq:201,senderId:rows[200].message.senderId}}}};
  await v.savePrivateArchiveItem(s,deletion);
  const invalid={...deletion,self:false,message:{...deletion.message,seq:207,clientMsgId:crypto.randomUUID(),senderId:crypto.randomUUID(),payload:{...deletion.message.payload,target:{clientMsgId:rows[100].message.clientMsgId,serverSeq:101,senderId:rows[100].message.senderId}}}};await v.savePrivateArchiveItem(s,invalid);
  const collision=item(s,crypto.randomUUID(),1,rows[0].message.clientMsgId);await v.savePrivateArchiveItem(s,collision);
  let conflict=false;try{await v.savePrivateArchiveItem(s,{...rows[0],message:{...rows[0].message,payload:{...rows[0].message.payload,text:'conflict'}}});}catch{conflict=true;}
  if(!conflict)throw new Error('HIS-05 conflict was overwritten');
  const meta=await catalog.ensurePrivateCatalog(s,signal);let next=await catalog.readPrivateHistoryPage(s,meta,signal),collected=[...next.items];
  if(meta.rawCount!==208||meta.catalog.visibleCount!==205||next.items.length!==100)throw new Error('HIS-01/02 projection count mismatch');
  while(next.start){next=await catalog.readPrivateHistoryPage(s,meta,signal,{before:next.start});collected=[...next.items,...collected];}
  const ids=collected.map(x=>`${x.originRoomId}:${x.message.clientMsgId}`);
  if(ids.length!==205||new Set(ids).size!==205||ids.includes(`${origin}:${rows[200].message.clientMsgId}`)||!ids.includes(`${collision.originRoomId}:${collision.message.clientMsgId}`)||!ids.includes(`${origin}:${rows[100].message.clientMsgId}`))throw new Error('HIS-02/05 deletion or source identity failed');
  let decryptions=0;const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:(...args)=>{if(new TextDecoder().decode(args[0].additionalData).startsWith('quiet-room-privateArchive-v1:'))decryptions++;return decrypt(...args);}});
  await catalog.readPrivateHistoryPage(s,meta,signal);Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:decrypt});if(decryptions!==100)throw new Error('HIS-13 warm page decrypted off-page bodies');
  const {PrivateHistoryController}=await import('/src/lib/private-history-controller.ts');const life=new AbortController(),controller=new PrivateHistoryController(s,life.signal,()=>!life.signal.aborted,()=>{});await controller.load();if(controller.page.items.length>100)throw new Error('Unbounded page cache');life.abort();if(controller.page.items.length)throw new Error('HIS-14 lock retained private bodies');
  // Cancellation ignores even an already-completed WebCrypto operation.
  const cancelled=new AbortController();let released,entered;const barrier=new Promise(r=>entered=r);Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:async(...args)=>{const value=await decrypt(...args);if(new TextDecoder().decode(args[0].additionalData).startsWith('quiet-room-privateArchive-v1:')){entered();await new Promise(r=>released=r);}return value;}});
  const late=catalog.readPrivateHistoryPage(s,meta,cancelled.signal).then(()=>false,cause=>cause.name==='AbortError');await barrier;cancelled.abort();released();if(!await late)throw new Error('SID-06 late page returned');Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:decrypt});
  // Adopted pages are encrypted and missing pages fail closed; originals survive.
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('quiet-room');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const saved=await new Promise(resolve=>{const tx=db.transaction('privateCatalog','readonly'),q=tx.objectStore('privateCatalog').get(`${s.vault.localDataScope??s.vault.roomId}:${meta.catalog.pages[0]}`);tx.oncomplete=()=>resolve(q.result);});
  if(JSON.stringify(saved).includes('synthetic-private')||'time'in saved||'seq'in saved)throw new Error('Plaintext catalog metadata');
  await new Promise(resolve=>{const tx=db.transaction('privateCatalog','readwrite');tx.objectStore('privateCatalog').delete(saved.id);tx.oncomplete=resolve;});
  let failed=false;try{await catalog.readPrivateHistoryPage(s,meta,signal,{after:0});}catch{failed=true;}if(!failed)throw new Error('HIS-04 incomplete catalog rendered');
  await new Promise(resolve=>{const tx=db.transaction('privateCatalog','readwrite');tx.objectStore('privateCatalog').put(saved);tx.oncomplete=resolve;});db.close();
  if((await v.loadPrivateArchiveItems(s)).length!==208)throw new Error('Catalog failure removed originals');
  // A cancelled atomic import never affects the published revision; a conflicting same-run duplicate fails.
  const staged=item(s,origin,300),run=crypto.randomUUID();await v.stagePrivateArchiveItem(s,run,staged,signal);let stagedConflict=false;try{await v.stagePrivateArchiveItem(s,run,{...staged,message:{...staged.message,payload:{...staged.message.payload,text:'staged conflict'}}},signal);}catch{stagedConflict=true;}if(!stagedConflict)throw new Error('Conflicting staged duplicate replaced');await v.discardPrivateArchiveStaging(s,run);
  if((await v.readPrivateCatalogMeta(s)).revision!==meta.revision)throw new Error('Cancelled import changed published revision');
  // Actual app page navigation and encrypted private anchor roundtrip.
  await import('/src/styles.css');await import('/src/chat-layout.css');
  const anchorId=ids[20];await v.saveUiPreferences(s,{privateArchiveAnchor:{id:anchorId,offset:-12}});
  if((await v.loadUiPreferences(s)).privateArchiveAnchor?.id!==anchorId)throw new Error('HIS-07 private anchor was dropped');
  const {QuietRoomApp}=await import('/src/app.ts'),app=new QuietRoomApp(document.querySelector('#app'));app.session=s;app.privacyCovered=false;app.runtimeAbort=new AbortController();app.scheduleIdleLock=()=>{};app.unreadCounter.ensureConfigured=async()=>false;app.connectSocket=async()=>{};app.startAutomaticBackup=()=>{};app.startOwnDirectoryServices=()=>{};app.startBrowserAccessServices=async()=>{};app.updateSafetyCode=async()=>{};
  await app.openSession();await app.privateHistory.settled;
  if(!app.privateArchiveItems.some(x=>`${x.originRoomId}:${x.message.clientMsgId}`===anchorId)||document.querySelectorAll('[data-private-archive-id]').length>100)throw new Error('HIS-07 app failed anchor or retained unbounded rows');
  await app.privateHistory.load('latest');await app.privateHistory.load('older');if(app.privateHistory.page.start!==5)throw new Error('Older page cursor failed');
  await app.privateHistory.load('older');if(app.privateHistory.page.items.length!==5)throw new Error('First boundary page failed');
  await app.privateHistory.load('newer');if(app.privateHistory.page.items.length!==100)throw new Error('Newer page failed');
  for(let n=0;n<30;n++){const life=new AbortController(),view=new PrivateHistoryController(s,life.signal,()=>!life.signal.aborted,()=>{});await view.load();life.abort();if(view.page.items.length||view.loading||!view.pageSignal.aborted)throw new Error('HIS-14 lifecycle retained private state');}
  app.lockNow();await app.preferenceSaveChain;if(app.privateArchiveItems.length||app.privateArchiveRows.size)throw new Error('Locked app retained private page');
  const metrics=[];
  if(perf){
   const previous=await import('/src/lib/__private_baseline.ts'),{visiblePrivateItems}=await import('/src/lib/private-archive-view.ts'),fileCrypto=await import('/src/lib/file-crypto.ts');
   const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;const image=await new Promise(r=>canvas.toBlob(r,'image/png'));
   const perfManifest=await fileCrypto.encryptImageFile(new File([image],'synthetic.png',{type:'image/png'}),{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async()=>{},complete:async()=>{},savePlan:async()=>{}});
   const perfId=n=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
   for(const size of [1000,10000]){
    const target=await create(),source=crypto.randomUUID(),scope=target.vault.localDataScope??target.vault.roomId;
    for(let first=0;first<size;first+=128){const batch=await Promise.all(Array.from({length:Math.min(128,size-first)},async(_,n)=>{const seq=first+n+1,row=item(target,source,seq,perfId(seq));row.message.payload.text='x'.repeat(2048);
    if(seq%10===0)row.message.payload={v:1,kind:'message-delete',sentAt:'2026-10-27T00:00:00Z',target:{clientMsgId:perfId(seq-1),serverSeq:seq-1,senderId:target.vault.identity.publicBundle.deviceId}};
    else if((seq-1)%20===0)row.message.payload={v:1,kind:'image',sentAt:'2026-10-27T00:00:00Z',image:perfManifest};const id=`${scope}:${source}:${row.message.clientMsgId}`,iv=crypto.getRandomValues(new Uint8Array(12)),ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(`quiet-room-privateArchive-v1:${id}`)},target.key,encoder.encode(JSON.stringify(row)));return {id,roomId:scope,iv:toBase64Url(iv),ciphertext:toBase64Url(ciphertext)};}));const db=await new Promise(r=>{const q=indexedDB.open('quiet-room');q.onsuccess=()=>r(q.result);});await new Promise(r=>{const tx=db.transaction('privateArchive','readwrite');for(const row of batch)tx.objectStore('privateArchive').put(row);tx.oncomplete=r;});db.close();}
    await v.writePrivateCatalogRecord(target,'meta',{revision:crypto.randomUUID(),rawCount:size},signal);
    const buildStart=performance.now(),index=await catalog.ensurePrivateCatalog(target,signal),buildMs=performance.now()-buildStart;
    const runs=[];for(let n=0;n<20;n++){for(const mode of n%2?['after','before']:['before','after']){const started=performance.now();let length,retainedBodies,heap;const heapBefore=performance.memory?.usedJSHeapSize;if(mode==='before'){const all=await previous.loadPrivateArchiveItems(target);length=visiblePrivateItems(all).slice(-100).length;retainedBodies=all.length;heap=performance.memory?.usedJSHeapSize;}else{const page=await catalog.readPrivateHistoryPage(target,index,signal);length=page.items.length;retainedBodies=page.items.length;heap=performance.memory?.usedJSHeapSize;}runs.push({mode,ms:performance.now()-started,rows:length,retainedBodies,heapBefore,observedHeap:heap});}}
    metrics.push({size,deleteEvents:size/10,mediaReferences:size/20,ordinaryTextBytes:2048,buildMs,runs});
   }
  }
  window.catalogFixture={session:s,signal};
  return {localId:v.vaultSpaceId(s.stored),visible:ids.length,warmBodyDecryptions:decryptions,sourceCollision:true,deletionHidden:true,cancelled:true,conflict:true,metrics};
 },{perf});
 const peer=await page.context().newPage();await peer.goto(`http://localhost:${vite.httpServer.address().port}/__private`);
 await page.evaluate(async()=>{const v=await import('/src/lib/vault.ts'),{session}=window.catalogFixture,stamp='2026-10-27T00:00:00Z';await v.savePrivateArchiveItem(session,{originRoomId:crypto.randomUUID(),sourceScope:session.vault.localDataScope??session.vault.roomId,self:true,message:{seq:1,clientMsgId:crypto.randomUUID(),senderId:session.vault.identity.publicBundle.deviceId,status:'stored',acceptedAt:stamp,payload:{v:1,kind:'text',sentAt:stamp,text:'synthetic-new-import'}}});});
 const [one,two]=await Promise.all([
  page.evaluate(async()=>{const c=await import('/src/lib/private-archive-catalog.ts'),{session,signal}=window.catalogFixture;const m=await c.ensurePrivateCatalog(session,signal);return {generation:m.catalog.generation,rows:m.catalog.visibleCount};}),
  peer.evaluate(async id=>{const v=await import('/src/lib/vault.ts'),k=await import('/src/lib/browser-room-key.ts'),c=await import('/src/lib/private-archive-catalog.ts');const session=await v.unlockVault(await k.browserRoomKey(),undefined,await v.readStoredRoom(id));window.catalogPeer=session;const m=await c.ensurePrivateCatalog(session,new AbortController().signal);return {generation:m.catalog.generation,rows:m.catalog.visibleCount};},result.localId)
 ]);assert.deepEqual(one,two);assert.equal(one.rows,206);
 const held=page.evaluate(async()=>{const v=await import('/src/lib/vault.ts'),c=await import('/src/lib/private-archive-catalog.ts'),{session,signal}=window.catalogFixture,meta=await c.ensurePrivateCatalog(session,signal);const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let blocked=false;Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:async(...args)=>{const value=await decrypt(...args);if(!blocked&&new TextDecoder().decode(args[0].additionalData).startsWith('quiet-room-privateArchive-v1:')){blocked=true;window.catalogBarrier=true;await new Promise(resolve=>window.releaseCatalog=resolve);}return value;}});try{await c.readPrivateHistoryPage(session,meta,signal);return false;}catch{return true;}finally{Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:decrypt});}});
 await page.waitForFunction(()=>window.catalogBarrier===true);await peer.evaluate(async()=>{const v=await import('/src/lib/vault.ts');await v.deleteNewRoomLocal(window.catalogPeer);});await page.evaluate(()=>window.releaseCatalog());assert.equal(await held,true,'SID-08 stale page survived cross-tab deletion');await peer.close();
 assert.equal(result.visible,205);console.log(`Private pagination passed (${engine.name()}): ${JSON.stringify(result)}`);await browser.close();browser=null;
}}finally{await browser?.close();await vite.close();}
