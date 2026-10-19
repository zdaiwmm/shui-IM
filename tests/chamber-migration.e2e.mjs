import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
import {submitPassword} from './helpers/password.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'chamber-migration-'));let backend,vite,browser;
try {
  backend=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
  vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[{name:'chamber-observer',enforce:'pre',transform(code,id){if(id===path.join(process.cwd(),'src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],
    server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});await vite.listen();
  browser=await chromium.launch(process.env.CI?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
  const url=`http://127.0.0.1:${vite.httpServer.address().port}/`,errors=[],pages=[];
  for(let i=0;i<2;i++){const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0'});const page=await context.newPage();page.setDefaultTimeout(25_000);page.on('pageerror',e=>errors.push(e.message));await page.goto(url);pages.push(page);}
  const [a,b]=pages;
  // Synthetic pre-migration room, with the real old password vault and MLS.
  const bVault=await a.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),api=await import('/src/lib/api.ts'),crypto=await import('/src/lib/crypto.ts'),base=await import('/src/lib/base64.ts'),m=await import('/src/lib/mls.ts'),p=await import('/src/lib/password-protection.ts');
    const creator=await crypto.generateIdentity(),joiner=await crypto.generateIdentity(),aToken=base.randomBase64Url(32),bToken=base.randomBase64Url(32),invite=base.randomBase64Url(32),pairingSecret=base.randomBase64Url(32);
    const room=await api.createRoom(creator.publicBundle,aToken,invite,'Synthetic A',['file-message-v1']),proof=await crypto.createJoinProof(pairingSecret,joiner.publicBundle),state=await api.joinRoom(room.roomId,invite,joiner.publicBundle,proof,bToken,'Synthetic B',['file-message-v1']);
    const common={v:3,roomId:room.roomId,pairingSecret,creatorFingerprint:await crypto.bundleFingerprint(creator.publicBundle),members:state.members,lastSeq:0,lastReceiptSeq:0,pairingState:'ready',createdAt:room.createdAt,protocol:'mls-rfc9420'};
    const av={...common,role:'creator',identity:creator,accessToken:aToken};av.mls=await m.createCreatorMlsState(room.roomId,creator,state.members);av.mls=await m.prepareCreatorWelcome(av);await api.publishMlsWelcome(room.roomId,aToken,av.mls.pendingWelcome);
    await v.createVault(av,'','platform',await p.deriveNumericPasswordCredential('246810'),()=>true);
    const bv={...common,role:'joiner',identity:joiner,accessToken:bToken};bv.mls=await m.joinMlsGroup(bv,av.mls.pendingWelcome);return bv;
  });
  await b.evaluate(async vault=>{const v=await import('/src/lib/vault.ts'),p=await import('/src/lib/password-protection.ts');await v.createVault(vault,'','platform',await p.deriveNumericPasswordCredential('135790'),()=>true);},bVault);
  for(const [page,pin] of [[a,'246810'],[b,'135790']]){await page.reload();await submitPassword(page,pin);await page.locator('#message-input').waitFor();}
  await a.locator('#message-input').fill('Synthetic legacy history retained');await a.locator('#composer').evaluate(f=>f.requestSubmit());await b.getByText('Synthetic legacy history retained',{exact:true}).waitFor();
  await a.evaluate(()=>app.runAutomaticBackup(true));const oldCode=await a.evaluate(()=>app.session.vault.backup.code);
  for(const [page,pin] of [[a,'246810'],[b,'135790']]){await page.evaluate(()=>app.renderBackupSettings());await page.locator('#legacy-chamber-migrate').click();await page.locator('#chamber-migration-bind').click();await submitPassword(page,pin);await page.getByText(/本人身份已加密保管/).waitFor();}
  await a.locator('#chamber-migration-check').click();await a.waitForFunction(()=>Boolean(app.session.vault.personalBinding));
  const original=await Promise.all([a,b].map(page=>page.evaluate(()=>({slot:app.session.stored.spaceId??'current',device:app.session.vault.identity.publicBundle.deviceId,scope:app.session.vault.localDataScope??app.session.vault.roomId}))));
  for(const page of [a,b]){await page.locator('#chamber-migration-back').click();await page.locator('#message-input').waitFor();}
  await a.evaluate(async()=>{await app.processImageFiles([new File([new Uint8Array(8193).map((_,i)=>i%251)],'synthetic-original.txt',{type:'text/plain'})]);});
  await b.getByText('synthetic-original.txt',{exact:true}).first().waitFor();
  await a.waitForFunction(()=>app.session.vault.lastSeq>=2&&app.outbox.size===0&&!app.imageBatchUploading);
  await a.evaluate(()=>app.processImageFiles([new File(['Synthetic Safe original bytes'],'synthetic-safe.txt',{type:'text/plain'})],'gallery'));
  await a.waitForFunction(()=>[...app.messages.values()].some(m=>m.payload.kind==='gallery-file')&&app.outbox.size===0&&!app.imageBatchUploading);
  for(const [index,page] of [a,b].entries()){
    await page.locator('#message-input').fill(`Synthetic preserved draft ${index}`);
    await page.evaluate(async index=>{
    const v=await import('/src/lib/vault.ts'),rows=await v.loadHistory(app.session);
    app.uiPreferences={...app.uiPreferences,hiddenChatMessageIds:[rows[0].clientMsgId],composerDraft:`Synthetic preserved draft ${index}`,
      ...(index===0?{galleryCuration:[{v:1,category:'files',clientMsgId:rows.find(r=>r.payload.kind==='gallery-file').clientMsgId,assetIndex:0,hidden:true,pinnedAt:null}]}:{})};
    await v.saveUiPreferences(app.session,app.uiPreferences);await app.runAutomaticBackup(true);
    },index);
  }
  for(const [index,page] of [a,b].entries())original[index].records=await page.evaluate(async()=>
    (await(await import('/src/lib/vault.ts')).loadHistory(app.session)).map(({seq,clientMsgId,senderId,acceptedAt,payload})=>({seq,clientMsgId,senderId,acceptedAt,payload})));
  assert.equal(await a.evaluate(()=>app.session.vault.backup.code),oldCode);
  const restore=async(page,pin,peer,peerPin,scope,injectFailure=false)=>{
    await page.evaluate(()=>app.renderBackupSettings());await page.locator('#chamber-history-scope').selectOption(scope);
    await page.locator('#chamber-history-start').click();await submitPassword(page,pin);await page.getByText(/请联系对方，核对请求编号/).waitFor();
    await peer.evaluate(()=>app.renderBackupSettings());await peer.getByRole('button',{name:'核对申请并共同解密'}).click();await submitPassword(peer,peerPin);await peer.getByText(/已完成本次共同解密/).waitFor();
    const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic missing cloud block'})});
    if(injectFailure)await page.route('**/chamber-history/*',fail);
    await page.getByRole('button',{name:'解锁身份并恢复'}).click();await submitPassword(page,pin);
    if(injectFailure){
      await page.waitForFunction(()=>document.querySelector('.form-error')?.textContent&&!document.querySelector('.password-sheet'));
      assert.equal(await page.evaluate(async()=>Boolean((await(await import('/src/lib/chamber-migrations.ts')).chamberMigrationStatus(app.session,new AbortController().signal)).verified[app.session.vault.role])),false);
      assert.equal(await page.evaluate(async()=>{const v=await import('/src/lib/vault.ts'),stage=await(await import('/src/lib/chamber-migration-stage.ts')).openMigrationStage(app.session);return (await v.loadHistory(stage)).length;}),0);
      await page.unroute('**/chamber-history/*',fail);
      await page.getByRole('button',{name:'解锁身份并恢复'}).click();await submitPassword(page,pin);
    }
    await page.getByText(/已验证并恢复/).waitFor().catch(async()=>{throw new Error('Staging readback: '+await page.locator('.form-error').allTextContents());});
    assert.equal(await page.evaluate(async()=>{const v=await import('/src/lib/vault.ts'),stage=await(await import('/src/lib/chamber-migration-stage.ts')).openMigrationStage(app.session);
      const rows=await v.loadHistory(stage),source=(await v.loadHistory(app.session)).filter(row=>app.session.vault.role==='creator'||!['gallery-image','gallery-file'].includes(row.payload.kind)),manifest=rows.find(r=>r.payload.kind==='file').payload.file;
      const file=await(await import('/src/lib/file-crypto.ts')).decryptFileAttachment(manifest,(id,index)=>v.loadCachedMediaChunk(stage,id,index,Math.min(manifest.chunkSize,manifest.originalSize-index*manifest.chunkSize)+16));
      const bytes=new Uint8Array(await file.arrayBuffer());
      return stage.key!==app.session.key&&stage.vault.localDataScope!==(app.session.vault.localDataScope??app.session.vault.roomId)&&rows.length===source.length&&bytes.length===8193&&bytes.every((b,i)=>b===i%251)&&Boolean(app.session.vault.personalMigration.stage.digest);
    }),true);
    await page.evaluate(async()=>{window.migrationStageSnapshot=await(await import('/src/lib/chamber-migration-stage.ts')).openMigrationStage(app.session);});
    await page.locator('#chamber-migration-open').click();
  };
  await restore(a,'246810',b,'135790','all',true);
  await restore(b,'135790',a,'246810','chat');
  for(const [page,pin] of [[a,'246810'],[b,'135790']]){
    if(!await page.locator('#chamber-migration-finish').count())await page.locator('#chamber-migration-open').click();
    await page.locator('#chamber-migration-check').click();await page.waitForFunction(()=>!document.querySelector('#chamber-migration-finish').disabled);
    await page.locator('#chamber-migration-finish').click();await submitPassword(page,pin);await page.locator('#chamber-reopen-check').waitFor().catch(async()=>{throw new Error('Migration transition: '+await page.locator('#app').evaluate(n=>[n.querySelector('h1')?.textContent,n.querySelector('.form-error')?.textContent].join(' / ')));});
  }
  for(const page of [a,b])await page.waitForFunction(()=>document.querySelector('#chamber-reopen-approve')&&!document.querySelector('#chamber-reopen-approve').disabled);
  assert.equal(await a.locator('#chamber-reopen-safety').textContent(),await b.locator('#chamber-reopen-safety').textContent());
  await a.locator('#chamber-reopen-approve').click();await submitPassword(a,'246810');
  assert.equal(await a.evaluate(async code=>{await(await import('/src/lib/cloud-backup.ts')).fetchRecoveryBundle(code,new AbortController().signal);return true;},oldCode),true);
  // The last approval can succeed while its response is lost. Resume the same
  // durable keys and request, rather than creating another candidate.
  let dropped=false;
  await b.route('**/chamber-lifecycle',async route=>{
    if(route.request().method()==='POST'&&route.request().postDataJSON().action==='approve'&&!dropped){dropped=true;const response=await route.fetch();assert.equal(response.status(),200);await route.abort('connectionreset');}else await route.continue();
  });
  await b.locator('#chamber-reopen-approve').click();await submitPassword(b,'135790');
  for(const page of [a,b])await page.locator('#message-input').waitFor().catch(async()=>{const debug=await page.evaluate(async()=>({heading:document.querySelector('#app h1')?.textContent,error:document.querySelector('#app .form-error,#fatal-message')?.textContent,status:document.querySelector('#chamber-reopen-status')?.textContent,pending:Boolean(app.session?.vault.pendingChamberReopen),approved:app.session?.vault.pendingChamberReopen?.approved,generation:app.session?.vault.chamberLifecycle?.generation}));throw new Error('Final cutover: '+JSON.stringify(debug));});
  for(const [index,page] of [a,b].entries()){
    assert.equal(await page.evaluate(async()=>{const v=await import('/src/lib/vault.ts');return (await v.loadHistory(migrationStageSnapshot)).length===0&&!app.session.vault.personalMigration&&!app.session.vault.migrationSource;}),true);
    const after=await page.evaluate(async()=>({generation:app.session.vault.chamberLifecycle.generation,slot:app.session.stored.spaceId??'current',device:app.session.vault.identity.publicBundle.deviceId,scope:app.session.vault.localDataScope??app.session.vault.roomId,
      records:(await(await import('/src/lib/vault.ts')).loadHistory(app.session)).map(({seq,clientMsgId,senderId,acceptedAt,payload})=>({seq,clientMsgId,senderId,acceptedAt,payload})),preferences:await(await import('/src/lib/vault.ts')).loadUiPreferences(app.session)}));
    assert.equal(after.generation,2);assert.equal(after.slot,original[index].slot);assert.notEqual(after.device,original[index].device);assert.equal(after.scope,original[index].scope);
    for(const row of original[index].records)assert.deepEqual(after.records.find(r=>r.clientMsgId===row.clientMsgId),row);
    assert.equal(after.preferences.hiddenChatMessageIds.length,1);if(index===0)assert.equal(after.preferences.galleryCuration[0].hidden,true);
    assert.equal(await page.locator('#message-input').inputValue(),`Synthetic preserved draft ${index}`);
    assert.equal(await page.evaluate(async()=>{const rows=await(await import('/src/lib/vault.ts')).loadHistory(app.session),manifest=rows.find(r=>r.payload.kind==='file').payload.file;
      const file=await(await import('/src/lib/file-crypto.ts')).decryptFileAttachment(manifest,(id,index)=>(import('/src/lib/api.ts')).then(api=>api.fetchBlobChunk(app.session.vault.roomId,app.session.vault.accessToken,id,index,new AbortController().signal)));
      const bytes=new Uint8Array(await file.arrayBuffer());return bytes.length===8193&&bytes.every((b,i)=>b===i%251);
    }),true);
  }
  for(const [page,pin] of [[a,'246810'],[b,'135790']]){await page.reload();await submitPassword(page,pin);await page.locator('#message-input').waitFor();}
  for(const [index,page] of [a,b].entries())assert.equal(await page.locator('#message-input').inputValue(),`Synthetic preserved draft ${index}`);
  assert.equal(dropped,true);
  assert.equal(await a.evaluate(async code=>{try{await(await import('/src/lib/cloud-backup.ts')).fetchRecoveryBundle(code,new AbortController().signal);return false;}catch{return true;}},oldCode),true);
  await a.locator('#message-input').fill('Synthetic migrated fresh generation');await a.locator('#composer').evaluate(f=>f.requestSubmit());await b.getByText('Synthetic migrated fresh generation',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('Chamber: both original browsers verify cloud records and original attachments in independent encrypted staging; missing blocks cannot attest; same-slot fresh keys preserve history, drafts and deletion projections; both roots are required; a lost cutover response resumes safely.');
}finally{await browser?.close();await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
