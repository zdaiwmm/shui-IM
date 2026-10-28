import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
const vite=await createServer({root:process.cwd(),configFile:false,appType:'custom',logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'runtime-isolation',configureServer(s){s.middlewares.use('/__runtime',(_q,r)=>{r.setHeader('Content-Type','text/html');r.end('<!doctype html><div id="app"></div>');});}}]});let browser;
try{await vite.listen();for(const engine of [chromium,webkit]){
 browser=await engine.launch(engine===webkit?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
 const page=await browser.newPage({locale: 'zh-CN'});await page.goto(`http://localhost:${vite.httpServer.address().port}/__runtime`);
 const result=await page.evaluate(async()=>{
  const {QuietRoomApp}=await import('/src/app.ts'),v=await import('/src/lib/vault.ts'),c=await import('/src/lib/crypto.ts'),k=await import('/src/lib/browser-room-key.ts'),a=await import('/src/lib/room-archive-crypto.ts');
  const create=async(label)=>{const identity=await c.generateIdentity(),roomId=crypto.randomUUID(),originRoomId=crypto.randomUUID(),stamp=new Date().toISOString();await v.selectLocalSpace(crypto.randomUUID());
   const session=await v.createVault({v:3,roomId,accessToken:'synthetic',creatorFingerprint:'synthetic',role:'creator',pairingSecret:'',identity,members:[{...identity.publicBundle,role:'creator',status:'active',joinProof:null}],lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:stamp,protocol:'mls-rfc9420',roomArchiveV2:{key:a.newArchiveKey()}},'','platform',await k.automaticRoomCredential());
   const item={originRoomId,sourceScope:session.vault.localDataScope??roomId,self:true,message:{seq:1,clientMsgId:crypto.randomUUID(),senderId:identity.publicBundle.deviceId,acceptedAt:stamp,status:'stored',payload:{v:1,kind:'text',sentAt:stamp,text:label}}};await v.savePrivateArchiveItem(session,item);return session;
  };
  const A=await create('synthetic-A-only'),B=await create('synthetic-B-only');
  const app=new QuietRoomApp(document.querySelector('#app'));app.scheduleIdleLock=()=>{};app.unreadCounter.ensureConfigured=async()=>false;app.connectSocket=async()=>{};app.startAutomaticBackup=()=>{};app.startOwnDirectoryServices=()=>{};app.startBrowserAccessServices=async()=>{};app.updateSafetyCode=async()=>{};
  let errors=0;app.operationalError=()=>errors++;
  const fresh=session=>{app.session=session;app.privacyCovered=false;app.runtimeAbort=new AbortController();};
  const results=[];
  for(const mode of ['lock','switch','reopen','repeat','late-failure']){
   fresh(A);const decrypt=crypto.subtle.decrypt.bind(crypto.subtle);let release,arrived,held=false;const entered=new Promise(r=>arrived=r);
   Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:async(...args)=>{const value=await decrypt(...args);if(!held&&new TextDecoder().decode(args[0].additionalData).startsWith(`quiet-room-privateArchive-v1:${A.vault.localDataScope??A.vault.roomId}:`)){held=true;arrived();await new Promise(r=>release=r);if(mode==='late-failure')throw new Error('synthetic late rejection');}return value;}});
   const opening=app.openSession().catch(cause=>{if(cause.name!=='AbortError')throw cause;});await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`Runtime decrypt barrier not reached (${mode}): ${app.privateHistory?.error??'no private reader'}`)),15000))]);const oldHistory=app.privateHistory,oldRead=oldHistory?.settled;
   if(mode!=='repeat'){app.lockNow();await app.preferenceSaveChain;}
   if(mode==='switch'||mode==='late-failure'){fresh(B);await app.openSession();await app.privateHistory?.settled;}
   // A same-room build waits for the canceled build's catalog lock. Release
   // its uninterruptible crypto operation before awaiting the new reader.
   if(mode==='reopen'){fresh(A);await app.openSession();}
   if(mode==='repeat'){await app.openSession();}
   const currentHistory=app.privateHistory,expected=app.privateArchiveItems,expectedText=JSON.stringify(expected),priorErrors=errors;
   release();await opening;await oldRead;Object.defineProperty(crypto.subtle,'decrypt',{configurable:true,value:decrypt});
   if(app.privateHistory!==currentHistory||errors!==priorErrors||oldHistory&&oldHistory!==currentHistory&&oldHistory.page.items.length)throw new Error(`${mode}: old continuation changed later runtime`);
   if(mode!=='reopen'&&mode!=='repeat'&&(app.privateArchiveItems!==expected||JSON.stringify(app.privateArchiveItems)!==expectedText))throw new Error(`${mode}: old continuation changed later model`);
   await currentHistory?.settled;
   if(mode==='lock'&&(app.privateArchiveItems.length||app.privateArchiveRows.size||document.body.textContent.includes('synthetic-A-only')))throw new Error('SID-01 locked runtime rehydrated');
   if((mode==='switch'||mode==='late-failure')&&(app.privateArchiveItems.length!==1||expectedText.includes('synthetic-A-only')||!(await v.loadPrivateArchiveItems(B)).every(x=>x.message.payload.text==='synthetic-B-only')))throw new Error('SID-02 cross-room model or persistent contamination');
   if((mode==='reopen'||mode==='repeat')&&app.privateArchiveItems.length!==1)throw new Error('SID-03/05 current opening failed');
   results.push(mode);app.lockNow();await app.preferenceSaveChain;
  }
  return results;
 });
 assert.deepEqual(result,['lock','switch','reopen','repeat','late-failure']);console.log(`Runtime isolation passed (${engine.name()}): ${result.join(', ')}`);await browser.close();browser=null;
}}finally{await browser?.close();await vite.close();}
