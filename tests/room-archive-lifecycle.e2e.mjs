import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'quiet-private-archive-'));let service,vite,browser;
try{
 service=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
 vite=await createServer({root:process.cwd(),configFile:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${service.port}`}},plugins:[{name:'archive-fixture',configureServer(s){s.middlewares.use('/__archive',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><title>Private archive regression</title>');});}}]});await vite.listen();
 browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__archive`);
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
  const canvas=document.createElement('canvas');canvas.width=3;canvas.height=3;canvas.getContext('2d').fillRect(0,0,3,3);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),file=new File([blob],'original.png',{type:'image/png'}),chunks=new Map();
  const manifest=await fileCrypto.encryptImageFile(file,{reserve:async()=>{},status:async()=>({uploadedIndexes:[],completed:false}),upload:async(id,index,bytes)=>{chunks.set(index,bytes);},complete:async()=>{},savePlan:async()=>{}});
  for(const [index,bytes] of chunks)await v.saveCachedMediaChunk(first,manifest.blobId,index,bytes);
  await v.saveHistoryMessage(first,{...text,seq:2,clientMsgId:crypto.randomUUID(),payload:{v:1,kind:'image',image:manifest,sentAt:now}});
  first.vault.lastSeq=2;await v.saveVault(first);await a.syncRoomArchive(first,signal);
  if(first.vault.roomArchiveV2.cardVerified)throw new Error('Automatic backup must precede card verification');
  const sourceBackup=first.vault.archiveState.revision;
  const second=await create();const interrupted=new AbortController();let interruption=false;
  try{await a.restoreRoomArchive(second,recoveredKey,interrupted.signal,done=>{if(done===1)interrupted.abort();});}catch{interruption=true;}
  if(!interruption||(await v.loadPrivateArchiveItems(second)).length!==0)throw new Error('Interrupted restore exposed a partial history');
  await a.syncRoomArchive(second,signal);if(second.vault.archiveState.revision!==0)throw new Error('Unfinished restore entered backup');
  await a.restoreRoomArchive(second,recoveredKey,signal,()=>{});
  await a.restoreRoomArchive(second,recoveredKey,signal,()=>{});
  const privateItems=await v.loadPrivateArchiveItems(second);
  const shared=await v.loadHistoryPage(second,{limit:100});const outbox=await v.loadOutbox(second),receipts=await v.loadPendingReceipts(second);
  await a.syncRoomArchive(second,signal);
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
  const final=await create();await a.restoreRoomArchive(final,currentKey,signal,()=>{});
  return {sourceBackup,privateCount:privateItems.length,sharedCount:shared.length,outboxCount:outbox.length,receiptCount:receipts.length,finalCount:finalItems.length,originalsEqual,deleted,deletedItems:afterDeleteItems.length,deletedMedia:afterDeleteMedia===null,cloudSurvivesDelete:(await v.loadPrivateArchiveItems(final)).length,cardIsPng:png.type==='image/png'};
 });
 assert.deepEqual(result,{sourceBackup:2,privateCount:2,sharedCount:0,outboxCount:0,receiptCount:0,finalCount:2,originalsEqual:true,deleted:true,deletedItems:0,deletedMedia:true,cloudSurvivesDelete:2,cardIsPng:true});
 console.log('Private archive lifecycle passed: default backup, PNG card, independent restore, private merge/rebackup, originals, idempotence and local deletion.');
}finally{await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
