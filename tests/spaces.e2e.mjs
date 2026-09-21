import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-spaces-'));
let vite, browser, service;
try {
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${service.port}` } }, plugins: [{ name: 'spaces-fixture', configureServer(server) { server.middlewares.use('/__spaces', (_req,res) => { res.setHeader('Content-Type','text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>'); }); } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
  const url = `http://localhost:${vite.httpServer.address().port}/__spaces`;
  await page.goto(url);
 
  const result = await page.evaluate(async () => {
    window.v = await import('/src/lib/vault.ts'); window.sp = await import('/src/lib/spaces.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts'); const { createRoom } = await import('/src/lib/api.ts');
    const { newRecoveryCode } = await import('/src/lib/backup-crypto.ts');
    const make = async () => {
      const identity = await generateIdentity(), accessToken = (await import('/src/lib/base64.ts')).randomBase64Url(32);
      const room = await createRoom(identity.publicBundle, accessToken, 'i'.repeat(43), '本机', []);
      return { v: 3, roomId: room.roomId, accessToken, role: 'creator', pairingSecret: '', creatorFingerprint: 'f'.repeat(43), identity,
        members: [{ ...identity.publicBundle, role: 'creator', status: 'active' }], lastSeq: 0, lastReceiptSeq: 0, createdAt: room.createdAt,
        protocol: 'legacy-v1', pairingState: 'ready', recoveryExperience: { completed: 'created', coverEnabled: false },
        backup: { v: 1, ...newRecoveryCode(), syncedAt: new Date().toISOString(), revision: 1, cursor: 0, archives: [] } };
    };
    window.a = await v.createVault(await make());
    // Simulate the exact pre-upgrade wrapper: it has no spaceId and lives at current.
    delete a.stored.spaceId;
    await new Promise((resolve,reject) => { const r=indexedDB.open('quiet-room'); r.onsuccess=()=>{ const db=r.result,tx=db.transaction('vault','readwrite');tx.objectStore('vault').put(a.stored,'current');tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error); }; });
    a = await v.unlockVault();
    await sp.rememberLocalSpace(a);
    const legacyCode = a.vault.backup.code;
    await sp.syncSpaceDirectory(a, new AbortController().signal);
    await v.saveHistoryMessage(a, { seq: 1, clientMsgId: crypto.randomUUID(), senderId: a.vault.identity.publicBundle.deviceId, payload: { v:1, kind:'text', text:'A 的历史', sentAt: new Date().toISOString() }, acceptedAt:new Date().toISOString(), status:'stored' });
    await v.selectLocalSpace(crypto.randomUUID());
    window.b = await v.createVault({ ...await make(), spaceRecoveryCode:a.vault.spaceRecoveryCode });
    await sp.rememberLocalSpace(b);
    await sp.syncSpaceDirectory(b, new AbortController().signal);
    // A still writes to A while B is selected; B history and wrapper stay independent.
    const bBefore = JSON.stringify(await v.readStoredVault());
    a.vault.lastSeq = 1; await v.saveVault(a);
    const bUnchanged = bBefore === JSON.stringify(await v.readStoredVault());
    const bHistory = (await v.loadHistory(b)).length;
    await sp.rememberLocalSpace(a, undefined, { roomId:a.vault.roomId, name:'旧空间' });
    await v.selectLocalSpace('current'); const reopened = await v.unlockVault();
    const raw = await v.readLocalSpaceDirectory(sp.spaceCodeId(a.vault.spaceRecoveryCode));
    const remote = await sp.recoverableSpaces(a.vault.spaceRecoveryCode, new AbortController().signal);
    window.a = reopened;
    return { count:(await sp.localSpaces(a)).length, sameCode:a.vault.spaceRecoveryCode === b.vault.spaceRecoveryCode, legacyCode:a.vault.backup.code === legacyCode, oldHistory:(await v.loadHistory(a)).map(x=>x.payload.text), bHistory, rawEncrypted:!JSON.stringify(raw).includes('旧空间'), remoteRooms:remote.map(s=>s.roomId).sort(), rooms:[a.vault.roomId,b.vault.roomId].sort(), slot:v.vaultSpaceId(a.stored), bUnchanged };
  });
  assert.equal(result.count,2); assert.equal(result.sameCode,true); assert.equal(result.legacyCode,true); assert.deepEqual(result.oldHistory,['A 的历史']); assert.equal(result.bHistory,0); assert.equal(result.rawEncrypted,true); assert.deepEqual(result.remoteRooms,result.rooms); assert.equal(result.slot,'current'); assert.equal(result.bUnchanged,true);
  const other = await context.newPage(); await other.goto(url);
  assert.equal(await other.evaluate(async () => { const v=await import('/src/lib/vault.ts');await v.selectLocalSpace('current');const a=await v.readStoredVault();return a.spaceId === 'current'; }),true);
  await other.close(); await page.bringToFront();
  await page.evaluate(async () => {
    await import('/src/styles.css'); await import('/src/chat-layout.css'); await import('/src/chat-interactions.css');
    const { QuietRoomApp } = await import('/src/app.ts'); window.app = new QuietRoomApp(document.querySelector('#app'));
    app.session=a; app.privacyCovered=false; app.runtimeAbort=new AbortController(); app.updateBackgroundNotificationControl=async()=>{};
    app.showReleaseNotesIfNeeded=()=>{}; app.renderChat();
  });
  assert.equal(await page.locator('#recovery-shield').count(),0); assert.equal(await page.locator('.more-menu').count(),0);
  await page.locator('#open-spaces').click(); await page.locator('.space-row').first().waitFor();
  assert.equal(await page.locator('.space-row').count(),2);
  assert.equal(await page.locator('.space-row.is-selected').evaluate(el=>el.getBoundingClientRect().height>=100),true);
  await page.locator('.space-row').first().click({button:'right'}); await page.locator('#space-rename').click();
  assert.equal(await page.locator('#space-name').evaluate(el=>document.activeElement===el),true);
  await page.locator('#space-name').fill('慢慢聊'); await page.locator('#space-name-form button[type=submit]').click();
  await page.locator('.space-row.is-selected strong').waitFor();
  await page.locator('#space-settings').click(); await page.locator('#presence-style-setting').click();
  await page.locator('[data-style=heart]').click();
  assert.equal(await page.locator('[data-style=heart]').getAttribute('aria-checked'),'true');
  await page.locator('#space-style-done').click();
  await page.locator('.space-drawer-overlay').waitFor({state:'detached'});
  assert.equal(await page.locator('.chat-header').getAttribute('data-presence-style'),'heart');
  const sizes=await page.evaluate(()=>({button:document.querySelector('.peer-summary').getBoundingClientRect().width,svg:document.querySelector('.presence-circuit').getBoundingClientRect().width})); assert.equal(sizes.button,44); assert.equal(sizes.svg,32);
  const alignment=await page.evaluate(()=>{const outer=document.querySelector('.peer-summary').getBoundingClientRect(),inner=document.querySelector('.presence-circuit').getBoundingClientRect();return {x:inner.x+inner.width/2-outer.x-outer.width/2,y:inner.y+inner.height/2-outer.y-outer.height/2};});
  assert.ok(Math.abs(alignment.x)<1 && Math.abs(alignment.y)<1,JSON.stringify(alignment));
  assert.equal(await page.locator('#open-spaces span').innerText(),'慢慢聊');
  const output=process.env.QUIET_ROOM_SPACE_SCREENSHOTS;
  if(output){await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,'chat-heart.png')});}
  await page.locator('#open-spaces').click(); await page.locator('#space-settings').waitFor();
  if(output){await page.waitForTimeout(400);await page.screenshot({path:path.join(output,'spaces.png')});}
  await page.locator('#space-settings').click(); if(output){await page.waitForTimeout(400);await page.screenshot({path:path.join(output,'settings.png')});}
  await page.locator('.space-back').click(); await page.locator('#space-create').click();
  await page.locator('#copy-invite').waitFor();
  assert.equal(await page.locator('#create-room').count(),0);
  const createdSlot = await page.evaluate(()=>v.currentSpaceId());
  assert.notEqual(createdSlot,'current');
  await page.locator('#invite-close').click();
  await page.locator('.space-row.is-selected').waitFor();
  assert.equal(await page.locator('.space-row').count(),3);
  await page.locator('.space-row.is-selected').click();
  await page.locator('#copy-invite').waitFor();
  assert.equal(await page.evaluate(()=>v.currentSpaceId()),createdSlot);
  await page.evaluate(async()=>{ await app.leaveSpace(); await v.selectLocalSpace('current'); });
  // The actual post-unlock router resolves the invitation before rendering chat or opening a socket.
  const routed=await page.evaluate(async()=>{
    app.session=a;app.privacyCovered=false;
    const {makeParticipantInviteUrl}=await import('/src/lib/invite-link.ts');
    history.replaceState(null,'',makeParticipantInviteUrl({v:1,roomId:b.vault.roomId,accessToken:'t'.repeat(43),pairingSecret:'p'.repeat(43),creatorFingerprint:'f'.repeat(43)}));
    await app.openSession();return {selected:v.currentSpaceId(),target:v.vaultSpaceId(b.stored),chat:!!document.querySelector('.chat-shell')};
  });assert.equal(routed.selected,routed.target);assert.equal(routed.chat,false);
  const invalid=await page.evaluate(async()=>{history.replaceState(null,'','#invite=broken');app.privacyCovered=false;await app.renderGateway({trustedCoverActivation:true,autoUnlock:false});return document.querySelector('h1').textContent;});assert.equal(invalid,'邀请链接不完整');
  await page.evaluate(() => { history.replaceState(null, '', location.pathname); app.session=a; app.privacyCovered=false; app.runtimeAbort=new AbortController(); app.renderJointRecovery(null); });
  await page.locator('#joint-open-code').click();
  await page.locator('#joint-code-form textarea').fill(await page.evaluate(()=>a.vault.spaceRecoveryCode));
  await page.locator('#joint-code-form button[type=submit]').click();
  await page.locator('[data-recovery-spaces] select').waitFor();
  assert.ok(await page.locator('[data-recovery-spaces] option').count()>=2);
  assert.equal(await page.locator('#joint-code-form textarea').inputValue(),'');
  await page.locator('#joint-code-close').click(); await page.locator('#joint-code-form').waitFor({state:'detached'});
  for (const [width,height,scheme] of [[320,568,'light'],[390,844,'dark'],[1280,800,'light']]) {
    await page.setViewportSize({width,height}); await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'});
    await page.evaluate(async()=>{
      const {mountSpaceDrawer}=await import('/src/lib/space-drawer.ts');
      document.querySelector('#app').innerHTML='<main>背景</main>';
      mountSpaceDrawer(document.querySelector('#app'),{spaces:Array.from({length:40},(_,i)=>({roomId:String(i),name:'私密空间 '+(i+1)})),currentRoom:'0',signal:new AbortController().signal,actions:[],icons:{close:'×',plus:'+',settings:'⚙'},select:async()=>{},create:async()=>{},rename:async()=>{},styleChanged:()=>{},closed:()=>{}});
    });
    await page.locator('#space-settings').waitFor();
    const layout=await page.evaluate(()=>{const scroll=document.querySelector('.space-drawer-scroll');scroll.scrollTop=1200;return {footer:document.querySelector('.space-drawer-footer').getBoundingClientRect().bottom,viewport:innerHeight,scroll:scroll.scrollTop,overflow:document.documentElement.scrollWidth>innerWidth};});
    assert.ok(layout.footer<=height && layout.scroll>0 && !layout.overflow,JSON.stringify(layout));
    await page.locator('#space-settings').click(); await page.locator('.space-back').click();
    assert.ok(await page.locator('.space-drawer-scroll').evaluate(el=>el.scrollTop>1000));
    if(output)await page.screenshot({path:path.join(output,`list-${width}-${scheme}.png`)});
  }
  console.log('PASS spaces: legacy migration, immutable write slots, shared encrypted recovery, drawer/name/style/back, cached invite routing');
} finally { await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir,{recursive:true,force:true}); }
