import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
import {submitPassword} from './helpers/password.mjs';
import {fillFormInput} from './helpers/form-input.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'chamber-migration-'));let backend,vite,browser;
try {
  backend=await startServer({port:0,host:'127.0.0.1',dataDir,quiet:true});
  vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',plugins:[{name:'chamber-observer',enforce:'pre',transform(code,id){if(id===path.join(process.cwd(),'src/main.ts'))return code.replace('void app.start();','window.app=app;void app.start();');}}],
    server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':`http://127.0.0.1:${backend.port}`,'/ws':{target:`ws://127.0.0.1:${backend.port}`,ws:true}}}});await vite.listen();
  browser=await chromium.launch(process.env.CI?{}:process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
  const url=`http://127.0.0.1:${vite.httpServer.address().port}/`,errors=[],pages=[];
  for(let i=0;i<4;i++){const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0'});const page=await context.newPage();page.setDefaultTimeout(25_000);page.on('pageerror',e=>errors.push(e.message));await page.goto(url);pages.push(page);}
  const [a,b,c,d]=pages;
  // Synthetic pre-migration room, with the real old password vault and MLS.
  const bVault=await a.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),api=await import('/src/lib/api.ts'),crypto=await import('/src/lib/crypto.ts'),base=await import('/src/lib/base64.ts'),m=await import('/src/lib/mls.ts'),p=await import('/src/lib/password-protection.ts');
    const creator=await crypto.generateIdentity(),joiner=await crypto.generateIdentity(),aToken=base.randomBase64Url(32),bToken=base.randomBase64Url(32),invite=base.randomBase64Url(32),pairingSecret=base.randomBase64Url(32);
    const room=await api.createRoom(creator.publicBundle,aToken,invite,'Synthetic A',[]),proof=await crypto.createJoinProof(pairingSecret,joiner.publicBundle),state=await api.joinRoom(room.roomId,invite,joiner.publicBundle,proof,bToken,'Synthetic B',[]);
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
  const words=[];
  for(const [page,pin] of [[a,'246810'],[b,'135790']]){
    await page.locator('#chamber-migration-back').click();await page.locator('#message-input').waitFor();await page.evaluate(()=>app.runAutomaticBackup(true));
    words.push(await page.evaluate(async pin=>{const v=await import('/src/lib/vault.ts'),p=await import('/src/lib/personal-identity-vault.ts'),m=await import('/src/lib/personal-identity.ts');const stored=await v.readPersonalIdentity(),credential=await v.unlockPersonalIdentityPassword(stored,pin);try{return await p.usePersonalIdentity(stored,credential,e=>m.personalMnemonicFromEntropy(e).split(' '));}finally{delete credential.rootKek;}},pin));
  }
  assert.equal(await a.evaluate(()=>app.session.vault.backup.code),oldCode);
  assert.equal(await a.evaluate(async code=>{await(await import('/src/lib/cloud-backup.ts')).fetchRecoveryBundle(code,new AbortController().signal);return true;},oldCode),true);
  const restore=async(page,phrase,pin,fromFinish=false)=>{
    if(fromFinish)await page.locator('#chamber-migration-finish').click();else await page.locator('#restore-cloud').click();
    await page.locator('.numeric-password-page').waitFor();await submitPassword(page,pin);await page.locator('.chamber-import-grid').waitFor();await page.locator('.password-sheet').waitFor({state:'detached'});
    for(const [i,input] of (await page.locator('.chamber-import-grid input').all()).entries())try{await fillFormInput(page,input,phrase[i]);}catch{throw new Error('Synthetic migration mnemonic input failed; values omitted');}
    await page.locator('#personal-import-form [type=submit]').click();await page.locator('.chamber-restore-space').click();await submitPassword(page,pin);
  };
  for(const [page,phrase,pin,peer,peerPin] of [[c,words[0],'112233',b,'135790'],[d,words[1],'445566',a,'246810']]){
    await restore(page,phrase,pin);await page.locator('#personal-device-check').waitFor();await peer.locator('[data-personal-approve]').click();await submitPassword(peer,peerPin);await page.locator('#message-input').waitFor();
    assert.equal(await page.getByText('Synthetic legacy history retained',{exact:true}).count(),0);
  }
  for(const [page,pin,peer,peerPin,scope] of [[c,'112233',b,'135790','all'],[d,'445566',a,'246810','chat']]){
    await page.evaluate(()=>app.renderBackupSettings());await page.locator('#chamber-history-scope').selectOption(scope);await page.locator('#chamber-history-start').click();await submitPassword(page,pin);await page.getByText(/请联系对方，核对请求编号/).waitFor();
    await peer.evaluate(()=>app.renderBackupSettings());await peer.getByRole('button',{name:'核对申请并共同解密'}).click();await submitPassword(peer,peerPin);await peer.getByText(/已完成本次共同解密/).waitFor();
    await page.waitForFunction(()=>document.querySelector('#chamber-history-requests button')&&!document.querySelector('#chamber-history-requests button').disabled);
    await page.getByRole('button',{name:'解锁身份并恢复'}).click();await submitPassword(page,pin);await page.getByText(/已验证并恢复/).waitFor();
    await page.locator('#chamber-migration-open').click();
  }
  await c.locator('#chamber-migration-check').click();await c.waitForFunction(()=>!document.querySelector('#chamber-migration-finish').disabled);
  for(const [page,phrase,pin] of [[c,words[0],'112233'],[d,words[1],'445566']]){
    await page.locator('#chamber-migration-check').click();await restore(page,phrase,pin,true);await page.locator('#chamber-reopen-check').waitFor();
  }
  for(const page of [c,d])await page.waitForFunction(()=>document.querySelector('#chamber-reopen-approve')&&!document.querySelector('#chamber-reopen-approve').disabled);
  assert.equal(await c.locator('#chamber-reopen-safety').textContent(),await d.locator('#chamber-reopen-safety').textContent());
  await c.locator('#chamber-reopen-approve').click();await submitPassword(c,'112233');
  // One signature cannot retire the old recovery checkpoint.
  assert.equal(await a.evaluate(async code=>{await(await import('/src/lib/cloud-backup.ts')).fetchRecoveryBundle(code,new AbortController().signal);return true;},oldCode),true);
  await d.locator('#chamber-reopen-approve').click();await submitPassword(d,'445566');
  for(const page of [c,d])await page.locator('#message-input').waitFor();
  assert.equal(await c.evaluate(()=>app.session.vault.chamberLifecycle.generation),2);
  assert.equal(await c.evaluate(async code=>{try{await(await import('/src/lib/cloud-backup.ts')).fetchRecoveryBundle(code,new AbortController().signal);return false;}catch{return true;}},oldCode),true);
  await c.locator('#message-input').fill('Synthetic migrated fresh generation');await c.locator('#composer').evaluate(f=>f.requestSubmit());await d.getByText('Synthetic migrated fresh generation',{exact:true}).waitFor();
  words.forEach(phrase=>phrase.fill(''));assert.deepEqual(errors,[]);console.log('Chamber: old recovery remains until independent-device history verification and both roots approve; migration retires old checkpoints only after fresh MLS generation succeeds.');
}finally{await browser?.close();await vite?.close();await backend?.close();await rm(dataDir,{recursive:true,force:true});}
