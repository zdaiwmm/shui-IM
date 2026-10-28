import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
for(const engine of [chromium,webkit]){
const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-private-archive-'));let service,vite,browser;
try{
 service=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
 vite=await createServer({root:process.cwd(),configFile:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${service.port}`}},plugins:[{name:'archive-fixture',configureServer(s){s.middlewares.use('/__archive',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><title>Private archive regression</title>');});}}]});await vite.listen();
 browser=await engine.launch(engine===webkit?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const page=await browser.newPage({locale: 'zh-CN'});await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__archive`);
 const result=await page.evaluate(async()=>{
  const v=await import('/src/lib/vault.ts'),a=await import('/src/lib/room-archive.ts'),c=await import('/src/lib/room-archive-crypto.ts'),k=await import('/src/lib/browser-room-key.ts'),api=await import('/src/lib/api.ts'),cryptoLib=await import('/src/lib/crypto.ts'),fileCrypto=await import('/src/lib/file-crypto.ts'),cardImage=await import('/src/lib/archive-card-image.ts');
  const {randomBase64Url}=await import('/src/lib/base64.ts');
  const signal=new AbortController().signal;
  const create=async()=>{
   const identity=await cryptoLib.generateIdentity(),token=randomBase64Url(32),roomId=crypto.randomUUID(),caps=['room-archive-v2'];
   const room=await api.createRoom(identity.publicBundle,token,randomBase64Url(32),'test',caps,undefined,roomId);
   await v.selectLocalSpace(crypto.randomUUID());
   return v.createVault({v:3,roomId,accessToken:token,role:'creator',pairingSecret:'',creatorFingerprint:'test',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null,capabilities:caps}],lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:room.createdAt,protocol:'mls-rfc9420',roomArchiveV2:{key:c.newArchiveKey()}},'','platform',await k.automaticRoomCredential());
  };
  const first=await create(),originalKey=first.vault.roomArchiveV2.key;
  const password='my independent recovery phrase';
  const encryptedCard=await c.protectArchiveCard(originalKey,password),png=await cardImage.createArchiveCardImage(encryptedCard);
  const recoveredKey=await c.unlockArchiveCard(await cardImage.readArchiveCardImage(png),password);
  const now=new Date().toISOString();
  const text={seq:1,clientMsgId:crypto.randomUUID(),senderId:first.vault.identity.publicBundle.deviceId,payload:{v:1,kind:'text',text:'Only my restored history',sentAt:now},acceptedAt:now,status:'stored'};
  await v.saveHistoryMessage(first,text);
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=768;
  const pixels=canvas.getContext('2d').createImageData(canvas.width,canvas.height);
  for(let offset=0;offset<pixels.data.length;offset+=65536)crypto.getRandomValues(pixels.data.subarray(offset,Math.min(offset+65536,pixels.data.length)));
  for(let offset=3;offset<pixels.data.length;offset+=4)pixels.data[offset]=255;
  canvas.getContext('2d').putImageData(pixels,0,0);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),file=new File([blob],'original.png',{type:'image/png'}),chunks=new Map();
  if(file.size<=2*1024*1024)throw new Error('Regression needs a full-sized attachment chunk');
  const manifest=await fileCrypto.encryptImageFile(file,{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async(id,index,bytes)=>{chunks.set(index,bytes);},complete:async()=>{},savePlan:async()=>{}});
  for(const [index,bytes] of chunks)await v.saveCachedMediaChunk(first,manifest.blobId,index,bytes);
  await v.saveHistoryMessage(first,{...text,seq:2,clientMsgId:crypto.randomUUID(),payload:{v:1,kind:'image',image:manifest,sentAt:now}});
  first.vault.lastSeq=2;await v.saveVault(first);
  const interruptedUpload=new AbortController(),fetch=window.fetch.bind(window);let uploadAccepted=false;
  window.fetch=async(input,init)=>{
   const response=await fetch(input,init);
   if(init?.method==='PUT'&&String(input).includes('/private-archives/')&&typeof init.body==='string'){
    const object=JSON.parse(init.body);
    if(response.ok&&object.ciphertext?.length>3_000_000){uploadAccepted=true;interruptedUpload.abort();}
   }
   return response;
  };
  try{await a.syncRoomArchive(first,interruptedUpload.signal);}catch(cause){if(!interruptedUpload.signal.aborted)throw cause;}finally{window.fetch=fetch;}
  if(!uploadAccepted||!first.vault.archiveState?.preparing?.next)throw new Error('Upload interruption did not retain the pending object');
  const pendingId=first.vault.archiveState.preparing.next.id,stored=await v.readStoredVault();
  if(!stored||stored.payload.ciphertext.length<=2*1024*1024)throw new Error('Full-sized backup checkpoint must remain readable above the old limit');
  const reopened=await v.unlockVault(await k.browserRoomKey(),undefined,stored);
  if(reopened.vault.archiveState.preparing.next.id!==pendingId)throw new Error('Reopening changed the pending upload identity');
  let reused=false;
  window.fetch=async(input,init)=>{if(init?.method==='PUT'&&String(input).includes('/private-archives/')&&typeof init.body==='string'&&JSON.parse(init.body).id===pendingId)reused=true;return fetch(input,init);};
  try{await a.syncRoomArchive(reopened,signal);}finally{window.fetch=fetch;}
  if(!reused)throw new Error('Resume must retry the exact persisted archive object');
  Object.assign(first,reopened);
  if(first.vault.roomArchiveV2.cardVerified)throw new Error('Automatic backup must precede card verification');
  // Bootstrap legacy counts from authenticated batch heads, without fetching
  // the full-sized media again, then use the encrypted local checkpoint.
  let countReads=0;window.fetch=async(input,init)=>{if((init?.method??'GET')==='GET'&&String(input).includes('/api/private-archives/'))countReads++;return fetch(input,init);};
  let backupCounts;try{backupCounts=await a.readRoomArchiveCounts(first,signal);if(JSON.stringify(backupCounts)!==JSON.stringify({messages:2,images:1,videos:0,audio:0,files:0}))throw new Error('Counts include uncommitted media or omit a committed record');if(countReads!==2)throw new Error('Count discovery fetched original media instead of only two batches');await a.readRoomArchiveCounts(first,signal);if(countReads!==2)throw new Error('Cached counts fetched the archive again');}finally{window.fetch=fetch;}
  const before=JSON.stringify(backupCounts);await a.syncRoomArchive(first,signal);if(JSON.stringify(await a.readRoomArchiveCounts(first,signal))!==before)throw new Error('Retry duplicated backup counts');
  await v.withVaultMutation(first,async lease=>{delete first.vault.archiveState.counts;delete first.vault.archiveState.countsRevision;await v.saveVault(first,lease);});
  window.fetch=async(input,init)=>{const response=await fetch(input,init);if((init?.method??'GET')==='GET'&&String(input).includes('/api/private-archives/')){const object=await response.json();object.id=crypto.randomUUID();return new Response(JSON.stringify(object),{status:200,headers:{'Content-Type':'application/json'}});}return response;};
  let rejectedCounts=false;try{await a.readRoomArchiveCounts(first,signal);}catch{rejectedCounts=true;}finally{window.fetch=fetch;}
  if(!rejectedCounts||first.vault.archiveState.counts)throw new Error('Corrupt count source was accepted or persisted');await a.readRoomArchiveCounts(first,signal);
  const sourceBackup=first.vault.archiveState.revision;
  const second=await create();const interrupted=new AbortController();let interruption=false;
  try{await a.restoreRoomArchive(second,recoveredKey,interrupted.signal,done=>{if(done===1)interrupted.abort();});}catch{interruption=true;}
  if(!interruption||(await v.loadPrivateArchiveItems(second)).length!==0)throw new Error('Interrupted restore exposed a partial history');
  await a.syncRoomArchive(second,signal);if(second.vault.archiveState.revision!==0)throw new Error('Unfinished restore entered backup');await a.readRoomArchiveCounts(second,signal);
  const states=[];await a.restoreRoomArchive(second,recoveredKey,signal,()=>{},state=>states.push(state));
  if(states[0].stage!=='reading'||states.at(-1).stage!=='complete'||states.at(-1).messages!==2||states.at(-1).images!==1||!states.some(s=>s.stage==='committing'))throw new Error('Restore progress does not describe verified records and original media');
  await a.restoreRoomArchive(second,recoveredKey,signal,()=>{});
  const privateItems=await v.loadPrivateArchiveItems(second);
  const shared=await v.loadHistoryPage(second,{limit:100});const outbox=await v.loadOutbox(second),receipts=await v.loadPendingReceipts(second);
  await a.syncRoomArchive(second,signal);
  const rebackupCounts=await a.readRoomArchiveCounts(second,signal);if(rebackupCounts.messages!==2||rebackupCounts.images!==1)throw new Error('Committed incremental counts were not checkpointed with the backup head');
  const currentKey=second.vault.roomArchiveV2.key;
  await api.deleteRoom(first.vault.roomId,first.vault.accessToken);
  const third=await create();await a.restoreRoomArchive(third,currentKey,signal,()=>{});
  const finalItems=await v.loadPrivateArchiveItems(third),image=finalItems.find(item=>item.message.payload.kind==='image');
  const restored=await fileCrypto.decryptImageFile(image.message.payload.image,async(id,index)=>{
   const m=image.message.payload.image;return v.loadPrivateMediaChunk(a.privateItemSession(third,image),id,index,Math.min(m.chunkSize,m.originalSize-index*m.chunkSize)+16);
  });
  const originalsEqual=await restored.arrayBuffer().then(async raw=>{const expected=new Uint8Array(await file.arrayBuffer()),actual=new Uint8Array(raw);return expected.length===actual.length&&expected.every((n,i)=>n===actual[i]);});
  await v.deleteNewRoomLocal(third);
  const deleted=(await v.readStoredRoom(v.vaultSpaceId(third.stored)))===null;
  const afterDeleteItems=await v.loadPrivateArchiveItems(third);
  const afterDeleteMedia=await v.loadPrivateMediaChunk(a.privateItemSession(third,image),manifest.blobId,0,chunks.get(0).byteLength);
  const resumeOwner=await create(),lateOrigin='f0000000-0000-4000-8000-000000000001',earlyOrigin='00000000-0000-4000-8000-000000000002';
  const privateText=originRoomId=>({originRoomId,sourceScope:resumeOwner.vault.localDataScope??resumeOwner.vault.roomId,self:true,message:{...text,clientMsgId:crypto.randomUUID()}});
  await v.savePrivateArchiveItem(resumeOwner,privateText(lateOrigin));
  const prepareAbort=new AbortController();
  const stopPrepared=()=>{if(resumeOwner.vault.archiveState?.preparing&&!resumeOwner.vault.archiveState.pending)prepareAbort.abort();};window.addEventListener('quiet-room:archive-progress',stopPrepared);
  try{await a.syncRoomArchive(resumeOwner,prepareAbort.signal);}catch(cause){if(!prepareAbort.signal.aborted)throw cause;}finally{window.removeEventListener('quiet-room:archive-progress',stopPrepared);}
  if(!resumeOwner.vault.archiveState?.preparing)throw new Error('Resume fixture did not persist a preparation checkpoint');
  await v.savePrivateArchiveItem(resumeOwner,privateText(earlyOrigin));
  await v.saveHistoryMessage(resumeOwner,{...text,seq:1,clientMsgId:crypto.randomUUID(),senderId:resumeOwner.vault.identity.publicBundle.deviceId});resumeOwner.vault.lastSeq=1;await v.saveVault(resumeOwner);
  await a.syncRoomArchive(resumeOwner,signal);
  if((resumeOwner.vault.archiveState.privateDone?.length??0)!==2||resumeOwner.vault.archiveState.cursor!==1||!resumeOwner.vault.archiveState.lastComplete)throw new Error('BAK-14 resumed preparation skipped an earlier import or a new shared record');
  const business=await create();
  for(let seq=1;seq<=12;seq++)await v.saveHistoryMessage(business,{...text,seq,clientMsgId:crypto.randomUUID(),senderId:business.vault.identity.publicBundle.deviceId});
  business.vault.lastSeq=12;await v.saveVault(business);
  const partial=await a.syncRoomArchive(business,signal);
  if(partial.kind!=='partial'||business.vault.archiveState.cursor!==10||business.vault.archiveState.lastComplete)throw new Error('BAK-04 ten-row pass falsely completed latest range');
  const {readArchiveBackupSnapshot}=await import('/src/lib/archive-backup-state.ts');
  let snapshot=await readArchiveBackupSnapshot(business,signal,{running:false,error:''});if(snapshot.coverage!=='partial'||snapshot.counts.messages!==10)throw new Error('Partial checkpoint lost committed counts');
  await a.syncRoomArchive(business,signal);snapshot=await readArchiveBackupSnapshot(business,signal,{running:false,error:''});if(snapshot.coverage!=='complete'||snapshot.counts.messages!==12)throw new Error('Current complete range lacks witness');
  await v.savePrivateArchiveItem(business,{originRoomId:crypto.randomUUID(),sourceScope:business.vault.localDataScope??business.vault.roomId,self:true,message:{...text,clientMsgId:crypto.randomUUID()}});
  snapshot=await readArchiveBackupSnapshot(business,signal,{running:false,error:''});if(snapshot.coverage!=='partial')throw new Error('BAK-14 new private import retained full coverage');
  await a.syncRoomArchive(business,signal);snapshot=await readArchiveBackupSnapshot(business,signal,{running:false,error:''});if(snapshot.coverage!=='complete'||snapshot.counts.messages!==13)throw new Error('Private rebackup was not included in completion witness');
  const priorHead=JSON.stringify(business.vault.archiveState.head);
  await v.saveHistoryMessage(business,{...text,seq:13,clientMsgId:crypto.randomUUID(),senderId:business.vault.identity.publicBundle.deviceId,payload:{v:1,kind:'image',image:manifest,sentAt:now}});business.vault.lastSeq=13;await v.saveVault(business);
  let missingOriginal=false;try{await a.syncRoomArchive(business,signal);}catch{missingOriginal=true;}
  snapshot=await readArchiveBackupSnapshot(business,signal,{running:false,error:'原文件缺失'});
  if(!missingOriginal||snapshot.coverage!=='partial'||snapshot.counts.messages!==13||JSON.stringify(business.vault.archiveState.head)!==priorHead||!business.vault.archiveState.lastComplete)throw new Error('BAK-02/07 missing original destroyed old restore point or claimed latest complete');
  const final=await create();await a.restoreRoomArchive(final,currentKey,signal,()=>{});
  const cloudSurvivesDelete=(await v.loadPrivateArchiveItems(final)).length,staleCredential=await k.automaticRoomCredential();
  await v.clearAllRoomBrowserData(await v.readRoomProtection());k.clearBrowserRoomKey();
  let staleCreate=false,staleWrite=false;
  try{await v.createVault(final.vault,'','platform',staleCredential);}catch{staleCreate=true;}
  try{await v.saveVault(final);}catch{staleWrite=true;}
  if(!staleCreate||!staleWrite||await v.readStoredVault()||await v.readRoomProtection())throw new Error('Global reset allowed stale creation or writes to resurrect data');
  return {sourceBackup,privateCount:privateItems.length,sharedCount:shared.length,outboxCount:outbox.length,receiptCount:receipts.length,finalCount:finalItems.length,originalsEqual,deleted,deletedItems:afterDeleteItems.length,deletedMedia:afterDeleteMedia===null,cloudSurvivesDelete,cardIsPng:png.type==='image/png'};
 });
 assert.deepEqual(result,{sourceBackup:2,privateCount:2,sharedCount:0,outboxCount:0,receiptCount:0,finalCount:2,originalsEqual:true,deleted:true,deletedItems:0,deletedMedia:true,cloudSurvivesDelete:2,cardIsPng:true});
 console.log(`Private archive lifecycle passed (${engine.name()}): full-sized chunks, interrupted upload/reopen/idempotent resume, default backup, PNG card, private restore/rebackup, original bytes and local deletion.`);
}finally{await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
}

// Storage rollback and quota regressions share the archive lifecycle gate.
await import('./restore-original-cleanup.e2e.mjs');
