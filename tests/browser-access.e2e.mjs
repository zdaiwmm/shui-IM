import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {startServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'qr-access-ui-'));
let service,vite,browser;const errors=[];
try {
  service=await startServer({host:'127.0.0.1',port:0,dataDir,quiet:true});
  vite=await createServer({configFile:false,appType:'custom',root:process.cwd(),logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false,proxy:{'/api':{target:`http://127.0.0.1:${service.port}`,ws:true}}},plugins:[{name:'access-fixture',configureServer(server){server.middlewares.use('/__access',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');});}}]});
  await vite.listen();
  browser=await chromium.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.env.CI?{}:{channel:'chrome'});
  const endpoints=[];
  for(let i=0;i<3;i++){
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});await cdp.send('WebAuthn.enable');
    const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,hasPrf:true,automaticPresenceSimulation:true,isUserVerified:true}});
    await page.goto(`http://localhost:${vite.httpServer.address().port}/__access`);
    await page.evaluate(async()=>{
      await import('/src/styles.css');await import('/src/chat-layout.css');await import('/src/chat-interactions.css');await import('/src/cover.css');
      const {QuietRoomApp}=await import('/src/app.ts');window.app=new QuietRoomApp(document.querySelector('#app'));app.privacyCovered=false;
      // Isolate authorization from unrelated backup prompts and release notes.
      app.startAutomaticBackup=()=>{};app.showPairingWelcome=()=>{};app.showReleaseNotesIfNeeded=()=>{};app.updateBackgroundNotificationControl=async()=>{};
      window.v=await import('/src/lib/vault.ts');window.api=await import('/src/lib/api.ts');window.access=await import('/src/lib/browser-access.ts');
    });endpoints.push({page,cdp,authenticatorId,context});
  }
  const [old,peer,fresh]=endpoints;
  const peerVault=await old.page.evaluate(async()=>{
    const {generateIdentity,bundleFingerprint,createJoinProof}=await import('/src/lib/crypto.ts');const mls=await import('/src/lib/mls.ts');
    const [one,two]=await Promise.all([generateIdentity(),generateIdentity()]);
    const room=await api.createRoom(one.publicBundle,'a'.repeat(43),'b'.repeat(43),'原设备',[]);
    let state=await api.joinRoom(room.roomId,'b'.repeat(43),two.publicBundle,await createJoinProof('p'.repeat(43),two.publicBundle),'c'.repeat(43),'对方',[]);
    const common={v:3,roomId:room.roomId,pairingSecret:'p'.repeat(43),creatorFingerprint:await bundleFingerprint(one.publicBundle),members:state.members,lastSeq:0,lastReceiptSeq:0,createdAt:room.createdAt,protocol:'mls-rfc9420',pairingState:'ready',recoveryExperience:{coverEnabled:false}};
    const creator={...common,accessToken:'a'.repeat(43),role:'creator',identity:one,mls:await mls.createCreatorMlsState(room.roomId,one,state.members)};
    creator.mls=await mls.prepareCreatorWelcome(creator);await api.publishMlsWelcome(room.roomId,creator.accessToken,creator.mls.pendingWelcome);
    const joining={...common,accessToken:'c'.repeat(43),role:'joiner',identity:two,mls:{protocol:'mls-rfc9420',phase:'awaiting-welcome'}};
    joining.mls=await mls.joinMlsGroup(joining,creator.mls.pendingWelcome);creator.mls.pendingWelcome=undefined;creator.pairingSecret='';joining.pairingSecret='';
    window.oldSession=await v.createVault(creator);app.session=oldSession;await app.openSession();return joining;
  });
  await peer.page.evaluate(async vault=>{window.peerSession=await v.createVault(vault);app.session=peerSession;await app.openSession();},peerVault);
  await old.page.waitForFunction(async()=>((await access.preparedMailboxes(oldSession)).length>0));
  // A separate stored room has not yet completed its first normal unlock.
  const unpreparedRoom=await old.page.evaluate(async()=>{
    const {generateIdentity,bundleFingerprint,createJoinProof}=await import('/src/lib/crypto.ts');const mls=await import('/src/lib/mls.ts');const spaces=await import('/src/lib/spaces.ts');
    const [one,two]=await Promise.all([generateIdentity(),generateIdentity()]);const room=await api.createRoom(one.publicBundle,'e'.repeat(43),'f'.repeat(43),'原设备 B',[]);
    const state=await api.joinRoom(room.roomId,'f'.repeat(43),two.publicBundle,await createJoinProof('p'.repeat(43),two.publicBundle),'g'.repeat(43),'对方 B',[]);
    const vault={v:3,roomId:room.roomId,accessToken:'e'.repeat(43),role:'creator',pairingSecret:'',creatorFingerprint:await bundleFingerprint(one.publicBundle),identity:one,members:state.members,lastSeq:0,createdAt:room.createdAt,protocol:'mls-rfc9420',pairingState:'ready',spaceRecoveryCode:oldSession.vault.spaceRecoveryCode,mls:await mls.createCreatorMlsState(room.roomId,one,state.members)};
    vault.mls=await mls.prepareCreatorWelcome(vault);await api.publishMlsWelcome(room.roomId,vault.accessToken,vault.mls.pendingWelcome);vault.mls.pendingWelcome=undefined;
    await v.selectLocalSpace(crypto.randomUUID());window.secondSession=await v.createVault(vault);await spaces.rememberLocalSpace(secondSession);await v.selectLocalSpace(v.vaultSpaceId(oldSession.stored));return room.roomId;
  });

  // CDP exports resident credentials but not the PRF secret. Model a synced
  // credential's PRF output explicitly; all API, signature, MLS and UI paths are real.
  const {credentials}=await old.cdp.send('WebAuthn.getCredentials',{authenticatorId:old.authenticatorId});
  await fresh.cdp.send('WebAuthn.addCredential',{authenticatorId:fresh.authenticatorId,credential:credentials[0]});
  const expectedPrf=await old.page.evaluate(()=>Array.from(oldSession.browserAccessPrf));
  await fresh.page.evaluate(bytes=>{
    const get=navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get=async options=>{
      window.nativeCalls=(window.nativeCalls??0)+1;
      if(window.cancelNext){window.cancelNext=false;throw new DOMException('Synthetic cancellation','NotAllowedError');}
      const result=await get(options);
      Object.defineProperty(result,'getClientExtensionResults',{value:()=>({prf:{results:{first:new Uint8Array(bytes).buffer,second:new Uint8Array(bytes).buffer}}})});return result;
    };
    app.renderFirstRun(null);
  },expectedPrf);
  let freshRequests=0;fresh.page.on('request',r=>{if(r.method()==='POST'&&/browser-access/.test(r.url()))freshRequests++;});
  await fresh.page.evaluate(()=>{window.cancelNext=true;});await fresh.page.locator('#continue-browser').click();
  await fresh.page.locator('#continue-browser').waitFor();
  assert.equal(await fresh.page.getByText('验证已取消，未发送请求。').count(),0);assert.equal(freshRequests,0);
  await fresh.page.locator('#continue-browser').click();await fresh.page.getByRole('heading',{name:'等待原浏览器批准'}).waitFor();
  let canceledRequests=0;fresh.page.on('request',r=>{if(r.method()==='DELETE'&&/browser-access/.test(r.url()))canceledRequests++;});
  await fresh.page.evaluate(()=>{window.cancelNext=true;});
  await fresh.page.locator('#browser-access-reselect').click();
  await fresh.page.getByRole('heading',{name:'等待原浏览器批准'}).waitFor();
  assert.equal(await fresh.page.getByText('验证已取消').count(),0);
  assert.equal(canceledRequests,0);
  assert.equal(await fresh.page.getByText('私密空间 1',{exact:true}).count(),0);
  await old.page.locator('.browser-access-modal').waitFor();
  assert.equal(await old.page.locator('.browser-access-modal .access-code').textContent(),await fresh.page.locator('.access-code').textContent());
  await old.page.locator('.access-approve').click();
  await fresh.page.locator('.browser-access-shell').waitFor();assert.equal(await fresh.page.locator('#message-input').count(),0);assert.equal(await fresh.page.locator('.peer-summary').count(),0);assert.equal(await fresh.page.evaluate(async()=>Object.keys((await v.readBrowserAccessRecord()).record).some(k=>/prfOutput|privateKey|token/.test(k))),false);
  assert.equal(await fresh.page.evaluate(roomId=>app.browserProfile.profile.spaces.some(s=>s.roomId===roomId&&!s.certificate),unpreparedRoom),true);
  await old.page.evaluate(async()=>{await access.prepareBrowserAccess(secondSession);await access.publishPreparedCatalog(secondSession,new AbortController().signal);});
  assert.equal(await fresh.page.evaluate(async roomId=>{await access.refreshBrowserCatalog(app.browserProfile.profile,app.browserAccessAbort.signal);return !!app.browserProfile.profile.spaces.find(s=>s.roomId===roomId)?.certificate;},unpreparedRoom),true);
  await fresh.page.locator('#request-space-access').click();await fresh.page.locator('#space-access-code').waitFor();await peer.page.locator('.browser-access-modal').waitFor();
  assert.equal(await peer.page.locator('.access-code').textContent(),await fresh.page.locator('#space-access-code').textContent());
  const beforeResume=freshRequests;
  await fresh.page.evaluate(async()=>{app.lockNow();app.privacyCovered=false;await app.renderGateway({trustedCoverActivation:true,autoUnlock:false});});
  await fresh.page.locator('#browser-access-unlock').click();try{await fresh.page.locator('#space-access-code').waitFor();}catch(error){console.error('Resume surface:',await fresh.page.locator('body').innerText());throw error;}assert.equal(freshRequests,beforeResume);
  await peer.page.locator('.access-close').click();await peer.page.locator('#open-spaces').click();await peer.page.locator('.space-access-action:not([hidden])').waitFor();
  const row=await peer.page.locator('.space-access-row').first().evaluate(el=>{const a=el.querySelector('.space-row').getBoundingClientRect(),b=el.querySelector('.space-access-action').getBoundingClientRect();return {right:b.x>=a.right-1,same:b.top<a.bottom&&b.bottom>a.top};});assert.equal(row.right&&row.same,true);
  await peer.page.locator('.space-access-action:not([hidden])').click();await peer.page.locator('.browser-access-modal').waitFor();
  await peer.page.waitForTimeout(300);
  const shellGeometry=await fresh.page.locator('.browser-access-shell').evaluate(el=>{const h=el.querySelector('header').getBoundingClientRect(),e=el.querySelector('.access-empty').getBoundingClientRect(),c=el.querySelector('.access-composer').getBoundingClientRect();return {clear:e.top>=h.bottom-1,bottom:c.bottom<=innerHeight+1,overflow:document.documentElement.scrollWidth>innerWidth};});assert.equal(shellGeometry.clear&&shellGeometry.bottom&&!shellGeometry.overflow,true);
  if(process.argv[2]){await fresh.page.screenshot({path:path.join(process.argv[2],'browser-access-requester.png')});await peer.page.screenshot({path:path.join(process.argv[2],'browser-access-peer.png')});}
  await peer.page.locator('.access-approve').click();
  await fresh.page.locator('#message-input').waitFor({timeout:20000});assert.equal(await fresh.page.locator('.browser-access-shell').count(),0);
  const installed=await fresh.page.evaluate(()=>({id:app.session.vault.identity.publicBundle.deviceId,ready:app.session.vault.pairingState,localId:app.session.stored.spaceId,history:app.session.vault.historyUnavailableBeforeSeq}));
  assert.equal(installed.ready,'ready');assert.notEqual(installed.id,peerVault.identity.publicBundle.deviceId);
  assert.equal(service.store.roomState(peerVault.roomId).members.filter(m=>m.status==='active').length,3);
  const profileRace=await fresh.page.evaluate(async bytes=>{
    const saved=await v.readBrowserAccessRecord(),prf=new Uint8Array(bytes);
    const a=await access.loadBrowserProfile(prf,saved.record.credentialId),b=await access.loadBrowserProfile(prf,saved.record.credentialId),signal=new AbortController().signal;
    await access.saveBrowserProfile(a,signal);
    try{await access.saveBrowserProfile(b,signal);return false;}catch{return true;}
  },expectedPrf);assert.equal(profileRace,true);
  // Lock discards all shell secrets and approval surfaces.
  await fresh.page.evaluate(()=>app.lockNow());assert.equal(await fresh.page.evaluate(()=>app.browserProfile===null&&app.browserBindingProof===null&&app.deviceCredential===null),true);
  await peer.page.evaluate(async()=>{
    app.runtimeAbort.abort();app.accessDialog?.close();
    const {mountAccessApproval}=await import('/src/lib/browser-access-ui.ts');
    const {mountSpaceDrawer}=await import('/src/lib/space-drawer.ts');
    const signal=new AbortController().signal,deadline=performance.now()+900;
    mountSpaceDrawer(document.querySelector('#app'),{spaces:[{roomId:peerSession.vault.roomId,name:'测试空间'}],currentRoom:peerSession.vault.roomId,signal,actions:[],select:async()=>{},create:async()=>{},rename:async()=>{},styleChanged:()=>{},closed:()=>{},authorization:()=>({deadline,open:async()=>{}})});
    mountAccessApproval(document.querySelector('#app'),{signal,title:'到期清理测试',description:'合成请求',code:'123456',deadline,approve:async()=>{},reject:async()=>{},closed:()=>{}});
  });
  await peer.page.locator('.browser-access-modal').waitFor();await peer.page.locator('.space-access-action:not([hidden])').waitFor();
  await peer.page.waitForTimeout(1100);assert.equal(await peer.page.locator('.browser-access-modal').count(),0);assert.equal(await peer.page.locator('.space-access-action:not([hidden])').count(),0);
  assert.deepEqual(errors,[]);console.log('PASS browser access: native cancellation, two independent approvals, safe shell, same-row reopen, MLS join, lock cleanup');
} finally {await browser?.close();await vite?.close();await service?.close();await rm(dataDir,{recursive:true,force:true});}
