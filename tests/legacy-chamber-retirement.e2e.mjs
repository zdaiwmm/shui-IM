import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium,webkit} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
import {submitPassword} from './helpers/password.mjs';
// Keep the existing Chromium gate; desktop WebKit is an explicit extra probe.
for(const engine of (process.env.QUIET_ROOM_RETIREMENT_ENGINE==='webkit'?[webkit]:[chromium])) {
const dataDir=await mkdtemp(path.join(tmpdir(),'legacy-chamber-retirement-'));let backend,vite,browser;
try {
  backend=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
  vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[{name:'chamber-observer',enforce:'pre',transform(code,id){if(id===path.join(process.cwd(),'src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],
    server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});await vite.listen();
  browser=await engine.launch(engine===webkit||process.env.CI?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
  const url=`http://127.0.0.1:${vite.httpServer.address().port}/`,errors=[],pages=[];
  for(let i=0;i<2;i++){const context=await browser.newContext(i===0?{viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:3,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0'}:{viewport:{width:1440,height:900}});const page=await context.newPage();page.setDefaultTimeout(25_000);page.on('pageerror',e=>errors.push(e.message));await page.goto(url);pages.push(page);}
  const [a,b]=pages;
  const chamberRequests=[];
  for(const page of pages)page.on('request',r=>{if(/\/(?:chamber-(?:migration|history|lifecycle)|personal-devices|personal-directory)(?:[/?]|$)/.test(new URL(r.url()).pathname))chamberRequests.push(r.method()+' '+new URL(r.url()).pathname);});
  // Synthetic pre-migration room, with the real old password vault and MLS.
  const bVault=await a.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),api=await import('/src/lib/api.ts'),crypto=await import('/src/lib/crypto.ts'),base=await import('/src/lib/base64.ts'),m=await import('/src/lib/mls.ts'),p=await import('/src/lib/password-protection.ts');
    const creator=await crypto.generateIdentity(),joiner=await crypto.generateIdentity(),aToken=base.randomBase64Url(32),bToken=base.randomBase64Url(32),invite=base.randomBase64Url(32),pairingSecret=base.randomBase64Url(32);
    const room=await api.createRoom(creator.publicBundle,aToken,invite,'Synthetic A',['file-message-v1']),proof=await crypto.createJoinProof(pairingSecret,joiner.publicBundle),state=await api.joinRoom(room.roomId,invite,joiner.publicBundle,proof,bToken,'Synthetic B',['file-message-v1']);
    const common={v:3,roomId:room.roomId,pairingSecret,creatorFingerprint:await crypto.bundleFingerprint(creator.publicBundle),members:state.members,lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:room.createdAt,protocol:'mls-rfc9420'};
    const av={...common,role:'creator',identity:creator,accessToken:aToken};av.mls=await m.createCreatorMlsState(room.roomId,creator,state.members);av.mls=await m.prepareCreatorWelcome(av);await api.publishMlsWelcome(room.roomId,aToken,av.mls.pendingWelcome);
    await v.createVault(av,'','platform',await p.deriveNumericPasswordCredential('246810'),()=>true);
    const ab=await (await import('/src/lib/personal-device-binding.ts')).bindPersonalDevice(new Uint8Array(16).fill(31),creator),bb=await (await import('/src/lib/personal-device-binding.ts')).bindPersonalDevice(new Uint8Array(16).fill(32),joiner);
    const bv={...common,role:'joiner',identity:joiner,accessToken:bToken,personalBinding:bb,personalPeers:[ab,bb],personalMigration:{state:'staged',binding:bb}};bv.mls=await m.joinMlsGroup(bv,av.mls.pendingWelcome);return bv;
  });
  await b.evaluate(async vault=>{const v=await import('/src/lib/vault.ts'),p=await import('/src/lib/password-protection.ts');await v.createVault(vault,'','platform',await p.deriveNumericPasswordCredential('135790'),()=>true);},bVault);
  for(const [page,pin] of [[a,'246810'],[b,'135790']]){await page.reload();await submitPassword(page,pin);await page.locator('#message-input').waitFor();}
  await a.locator('#message-input').fill('Synthetic legacy history retained');await a.locator('#composer').evaluate(f=>f.requestSubmit());await b.locator('#message-list').getByText('Synthetic legacy history retained',{exact:true}).waitFor();
  const originals=await Promise.all(pages.map(page=>page.evaluate(()=>({device:app.session.vault.identity.publicBundle.deviceId,slot:app.session.stored.spaceId??'current',scope:app.session.vault.localDataScope??app.session.vault.roomId,retired:JSON.stringify(app.session.vault.personalMigration??null)}))));
  for(const page of pages){
    await page.locator('#chat-settings').click();await page.locator('.space-settings-list').waitFor();
    assert.equal(await page.getByRole('button',{name:'旧空间迁移',exact:true}).count(),0);
    assert.equal(await page.locator('#chamber-migration-settings').count(),0);
    assert.equal(await page.locator('#backup-settings').textContent(),'恢复卡');
    const desktop=page.locator('.desktop-settings-page');
    if(await desktop.count())await desktop.locator('.space-back').click();else await page.locator('.space-drawer-overlay:not(.is-closing) :is(.settings-dismiss-handle,.settings-desktop-close):visible').click();
    await page.locator('.space-drawer-overlay').waitFor({state:'detached'});
  }
  // Existing backup deep links still use normal navigation and retain drafts.
  await a.locator('#message-input').fill('Synthetic retained draft');
  await a.evaluate(()=>app.lockNow());
  await a.locator('.password-sheet:not(.is-closing)').waitFor();
  await a.goto(`${url}?source=retired#legacy-backup`);await submitPassword(a,'246810');await a.locator('#backup-back').waitFor();
  assert.equal(new URL(a.url()).hash,'');assert.equal(new URL(a.url()).search,'?source=retired');
  assert.equal(await a.locator('#legacy-chamber-migrate, #chamber-migration-open').count(),0);
  await a.locator('#backup-back').click();await a.locator('#message-input').waitFor();
  assert.equal(await a.locator('#message-input').inputValue(),'Synthetic retained draft');
  await b.evaluate(()=>{location.hash='legacy-backup';});await b.locator('#backup-back').waitFor();
  assert.equal(await b.locator('#legacy-chamber-migrate, #chamber-migration-open, #chamber-history-start').count(),0);
  await b.locator('#backup-back').click();await b.locator('#message-input').waitFor();
  await a.waitForFunction(()=>app.connectionState==='connected');
  await a.locator('#message-input').fill('');
  await a.evaluate(()=>app.processImageFiles([new File([new Uint8Array(8193).map((_,i)=>i%251)],'retained-original.txt',{type:'text/plain'})]));
  try {await b.getByText('retained-original.txt',{exact:true}).first().waitFor();} catch(cause) {
    console.error('Synthetic attachment diagnostic',JSON.stringify(await Promise.all(pages.map(page=>page.evaluate(()=>({session:Boolean(app.session),covered:app.privacyCovered,surface:app.activeSurface,access:app.accessFailure,phase:app.session?.vault.mls?.phase,members:app.session?.vault.members.map(m=>({role:m.role,status:m.status,capabilities:m.capabilities})),outbox:app.outbox.size,messages:[...app.messages.values()].map(m=>({seq:m.seq,kind:m.payload.kind})),notices:[...document.querySelectorAll('[role=alert], .toast, .notice')].map(e=>e.textContent)}))))));throw cause;
  }
  for(const [index,page] of pages.entries()){
    await page.evaluate(()=>app.runAutomaticBackup(true));
    const current=await page.evaluate(async()=>{
      const v=await import('/src/lib/vault.ts'),rows=await v.loadHistory(app.session),file=rows.find(r=>r.payload.kind==='file').payload.file;
      const chunks=[];for(let i=0;i<file.chunkCount;i++)chunks.push(await(await import('/src/lib/api.ts')).fetchBlobChunk(app.session.vault.roomId,app.session.vault.accessToken,file.blobId,i));
      const blob=await(await import('/src/lib/file-crypto.ts')).decryptFileAttachment(file,async(_blobId,index)=>chunks[index]);const plain=await blob.arrayBuffer();
      return {device:app.session.vault.identity.publicBundle.deviceId,slot:v.vaultSpaceId(app.session.stored),scope:app.session.vault.localDataScope??app.session.vault.roomId,retired:JSON.stringify(app.session.vault.personalMigration??null),readable:Boolean(await v.readStoredVault()),code:Boolean(app.session.vault.backup?.code),size:plain.byteLength,exact:new Uint8Array(plain).every((x,i)=>x===i%251)};
    });
    for(const key of ['device','slot','scope','retired'])assert.equal(current[key],originals[index][key],key);
    assert.equal(current.readable,true);assert.equal(current.code,true);assert.equal(current.size,8193);assert.equal(current.exact,true);
    const countBeforeProbe=chamberRequests.length;
    const apiState=await page.evaluate(async()=>{
      const base=`/api/rooms/${app.session.vault.roomId}/chamber-migration`,headers={Authorization:`Bearer ${app.session.vault.accessToken}`};
      return Promise.all([fetch(base,{headers}).then(r=>r.status),fetch(base,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({action:'bind',binding:app.session.vault.personalBinding})}).then(r=>r.status)]);
    });
    assert.deepEqual(apiState,[404,404]);
    chamberRequests.splice(countBeforeProbe);
    await page.evaluate(()=>app.lockNow());
    await page.locator('.password-sheet:not(.is-closing)').waitFor();
    await page.reload();await submitPassword(page,index===0?'246810':'135790');await page.locator('#message-input').waitFor();
    await page.locator('#message-list').getByText('Synthetic legacy history retained',{exact:true}).waitFor();await page.getByText('retained-original.txt',{exact:true}).first().waitFor();
  }
  assert.deepEqual(chamberRequests,[]);assert.deepEqual(errors,[]);
  console.log(`PASS legacy-room retirement (${engine.name()}): no migration entry or background Chamber jobs; normal backups, original slots, identities, history, attachments and reload retained`);
} finally {await browser?.close();await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
}
