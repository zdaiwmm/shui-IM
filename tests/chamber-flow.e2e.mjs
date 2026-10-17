import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { submitPassword } from './helpers/password.mjs';
import { fillFormInput } from './helpers/form-input.mjs';
import { auditP1Surface } from './helpers/p1-surface-audit.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'chamber-flow-'));
let backend, vite, browser;
try {
  backend = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [{ name: 'chamber-observer', enforce: 'pre',
    transform(code, id) { if (id === path.join(process.cwd(), 'src/main.ts')) return code.replace('void app.start();', 'window.app=app;void app.start();'); } }],
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${backend.port}`, '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true } } } });
  await vite.listen();
  browser = await chromium.launch(process.env.CI ? {} : process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  const errors = [], pages = [];
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0' });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message)); pages.push(page);
  }
  const [a, b, c] = pages, url = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  await a.goto(url); await a.locator('.chamber-brand').waitFor();
  await a.locator('.chamber-room').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await a.screenshot({ path: '/private/tmp/chamber-home-390.png' });
  await auditP1Surface(a,'chamber-home','.gateway');
  let protectedBeforeRoom = false, deviceBeforeRoom = false, legacyUploads = 0;
  const creationIds = new Set(); let lostCreateResponse = false;
  a.on('request', request => { if (/\/backup$/.test(new URL(request.url()).pathname) && request.method() === 'PUT') legacyUploads++; });
  await a.route('**/api/rooms', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const persisted = await a.evaluate(async () => {
      const vault = await import('/src/lib/vault.ts'), root = await vault.readPersonalIdentity(), stored = await vault.readStoredVault();
      return { root: Boolean(root?.payload.ciphertext && root?.wrappedKey.ciphertext), device: Boolean(stored?.payload?.ciphertext && app.session?.vault.pendingChamberCreate) };
    });
    protectedBeforeRoom = persisted.root; deviceBeforeRoom = persisted.device;
    creationIds.add(route.request().postDataJSON().roomId);
    if (!lostCreateResponse) {
      const created = await route.fetch(); assert.equal(created.status(), 201);
      lostCreateResponse = true; await route.abort('connectionreset'); return;
    }
    await route.continue();
  });
  await a.locator('#create-room').click(); await fillFormInput(a, a.locator('#new-space-name'), '合成 Chamber 验收'); await a.locator('#profile-done').click();
  await a.locator('.numeric-password-page').waitFor();
  assert.match(await a.locator('.numeric-browser-hint').textContent(), /系统浏览器/);
  await submitPassword(a, '246810'); await a.locator('.chat-shell').waitFor();
  assert.equal(protectedBeforeRoom, true);
  assert.equal(deviceBeforeRoom, true); assert.equal(lostCreateResponse, true); assert.equal(creationIds.size, 1);
  assert.match(await a.locator('#invite-countdown').textContent(), /首次进入后.*30/);
  assert.deepEqual(await a.locator('[data-personal-guide] strong').allTextContents(), ['助记词', '入口遮蔽', '自动锁定']);
  assert.equal(await a.getByText('稍后再设', { exact: true }).count(), 0);
  const invite = await a.locator('#invite-url').inputValue();
  await b.goto(invite); await b.locator('.numeric-password-page').waitFor();
  // A competing visitor is rejected before a root, device key or password ceremony is created.
  await c.goto(invite); await c.getByText(/该密室已被其他人进入/).waitFor();
  assert.equal(await c.locator('.numeric-password-page').count(), 0);
  assert.equal(await c.evaluate(async () => (await (await import('/src/lib/vault.ts')).readPersonalIdentity()) === null), true);
  await submitPassword(b, '135790'); await b.locator('.chamber-code-card').waitFor();
  let before = await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation }));
  await b.screenshot({ path: '/private/tmp/chamber-invite-390.png' });
  await auditP1Surface(b,'chamber-invite','.chamber-join-shell');
  await b.reload(); await submitPassword(b, '135790'); await b.locator('.chamber-code-card').waitFor();
  assert.deepEqual(await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation })), before);
  await b.goto(invite);await b.locator('.chamber-code-card').waitFor();
  assert.deepEqual(await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation })), before);
  const oldSlot=await b.evaluate(()=>app.session.stored.spaceId??'current'),rootRecord=await b.evaluate(async()=>JSON.stringify(await(await import('/src/lib/vault.ts')).readPersonalIdentity()));
  await a.evaluate(()=>app.rotateChamberInvitation());const nextInvite=await a.locator('#invite-url').inputValue();assert.notEqual(nextInvite,invite);
  await b.goto('about:blank');await b.goto(nextInvite);await submitPassword(b,'135790');await b.locator('#chamber-existing-join').click();await submitPassword(b,'135790');await b.locator('.chamber-code-card').waitFor();
  const next=await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation }));
  assert.equal(next.root,before.root);assert.notEqual(next.requestId,before.requestId);before=next;
  assert.equal(await b.evaluate(async()=>JSON.stringify(await(await import('/src/lib/vault.ts')).readPersonalIdentity())),rootRecord);
  assert.equal(await b.evaluate(async id=>(await import('/src/lib/vault.ts')).localSpaceExists(id),oldSlot),true);
  await a.waitForFunction(() => app.chamberInviteState?.stage === 'code');
  const code = await a.evaluate(() => app.chamberInviteState.code);
  assert.match(code, /^\d{4}$/);
  assert.deepEqual(await a.locator('.chamber-code-display > span').allTextContents(), code.split(''));
  assert.equal(await a.locator('.chat-header .spaces-entry, .chat-header .presence-circuit').count(), 0);
  assert.equal(await a.locator('.chamber-presence-capsule .peer-status').textContent(), '等待加入');
  assert.equal(await a.locator('#open-gallery').count(), 0, 'Pending invitation has no Safe action');
  assert.equal(await a.locator('#message-input').isVisible(), false, 'Pending invitation has a footer hint instead of chat controls');
  assert.equal(await a.locator('#chat-bottom-control').isVisible(), false);
  const invitationGeometry = await a.evaluate(() => ({
    eyebrowTop: document.querySelector('.chamber-invite-hero > .chamber-eyebrow').getBoundingClientRect().top,
    headerBottom: document.querySelector('.chat-header').getBoundingClientRect().bottom,
    scroll: scrollY, listScroll: document.querySelector('#message-list').scrollTop,
    padding: getComputedStyle(document.querySelector('#message-list')).paddingTop,
    pinned: app.chatPinnedToBottom, pending: app.chatBottomFollowPending, paired: app.peerHasJoined(app.session),
  }));
  assert.ok(invitationGeometry.eyebrowTop >= invitationGeometry.headerBottom, `Invitation starts below the header: ${JSON.stringify(invitationGeometry)}`);
  const copyBox = await a.locator('#copy-invite').boundingBox(), guideBox = await a.locator('.chamber-privacy-guide').boundingBox();
  assert.ok(copyBox && guideBox && guideBox.y > copyBox.y + copyBox.height, 'Invitation action comes before privacy guidance');
  await auditP1Surface(a, 'chamber-inviter', '.chat-shell');
  assert.equal(await b.locator('[data-request]').textContent(), before.requestId.slice(0, 8));
  const digits = b.locator('[data-code-digit]');
  assert.equal(await digits.count(), 4);
  await digits.nth(0).pressSequentially('1234');
  assert.deepEqual(await digits.evaluateAll(inputs => inputs.map(input => input.value)), ['1', '2', '3', '4']);
  await digits.nth(3).press('Backspace'); await digits.nth(3).press('Backspace');
  assert.equal(await digits.nth(2).evaluate(input => input === document.activeElement), true);
  assert.equal(await digits.nth(2).inputValue(), '');
  await digits.nth(2).press('ArrowLeft');
  assert.equal(await digits.nth(1).evaluate(input => input === document.activeElement), true);
  await digits.nth(1).evaluate((input, value) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, code);
  assert.deepEqual(await digits.evaluateAll(inputs => inputs.map(input => input.value)), code.split(''));
  await b.locator('.chamber-code-card [type=submit]').click();
  for (const [index, page] of [a, b].entries()) {
    try { await page.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && !document.querySelector('#message-input')?.disabled); }
    catch (cause) {
      console.error('Synthetic activation diagnostic', index, await page.evaluate(() => ({
        pairing: app.session?.vault.pairingState, phase: app.session?.vault.mls?.phase,
        error: document.querySelector('.chamber-code-card .form-error')?.textContent,
        notice: document.querySelector('#notice')?.textContent, gateway: document.querySelector('.gateway h1')?.textContent,
        failure: app.accessFailure, fatal: document.querySelector('#fatal-message')?.textContent,
      })), errors); throw cause;
    }
  }
  assert.equal(await a.locator('#open-gallery.chamber-presence-capsule').count(), 1);
  assert.equal(await b.locator('#open-gallery').count(), 0);
  assert.equal(await a.locator('.system-notices .chamber-privacy-guide').count(), 1, 'Activated chat retains the three-step guide');
  await a.locator('#message-input').fill('Synthetic Chamber encrypted message'); await a.locator('#composer').evaluate(form => form.requestSubmit());
  await b.getByText('Synthetic Chamber encrypted message', { exact: true }).waitFor();
  await a.evaluate(()=>app.runAutomaticBackup(true));
  await a.locator('#message-input').fill('Synthetic locally hidden history');await a.locator('#composer').evaluate(form=>form.requestSubmit());await b.getByText('Synthetic locally hidden history',{exact:true}).waitFor();
  await a.waitForFunction(()=>[...app.messages.values()].some(m=>m.payload.text==='Synthetic locally hidden history'));
  await a.evaluate(()=>app.deleteMessageForThisDevice([...app.messages.values()].find(m=>m.payload.text==='Synthetic locally hidden history')));
  await a.evaluate(()=>app.processImageFiles([new File([new Uint8Array([0,255,1,128,10,13,42])],'synthetic-exact.bin',{type:'application/octet-stream',lastModified:1})],'chat'));
  await b.getByText('synthetic-exact.bin',{exact:true}).waitFor();
  await a.evaluate(()=>app.processImageFiles([new File(['Synthetic Safe original bytes'],'synthetic-safe.txt',{type:'text/plain',lastModified:2})],'gallery'));
  await a.waitForFunction(()=>[...app.messages.values()].some(m=>m.payload.kind==='gallery-file'&&m.payload.file.originalName==='synthetic-safe.txt'));
  await a.evaluate(async()=>{
    const row=[...app.messages.values()].find(m=>m.payload.kind==='gallery-file'&&m.payload.file.originalName==='synthetic-safe.txt');
    app.uiPreferences.galleryCuration=[{v:1,category:'files',clientMsgId:row.clientMsgId,assetIndex:0,hidden:true,pinnedAt:null}];await app.saveUiPreferencesNow();
  });
  await a.route('**/blobs/*/chunks/*',route=>route.request().method()==='GET'?route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'INVALID_BLOB',error:'Synthetic missing original'})}):route.continue());
  await a.evaluate(()=>app.runAutomaticBackup(true));
  assert.match(await a.evaluate(()=>app.session.vault.chamberBackup?.paused??''),/原文件/);
  await a.locator('#chamber-backup-notice').waitFor();
  await a.unroute('**/blobs/*/chunks/*');
  await a.evaluate(() => app.runAutomaticBackup(true));
  const sourceBackup=await a.evaluate(async()=>({cursor:app.session.vault.chamberBackup?.cursor,lastSeq:app.session.vault.lastSeq,paused:app.session.vault.chamberBackup?.paused,error:app.backupError,
    batch:app.session.vault.chamberBackup?.batch?{after:app.session.vault.chamberBackup.batch.afterSeq,upper:app.session.vault.chamberBackup.batch.upperSeq,chunks:app.session.vault.chamberBackup.batch.chunks.length,references:app.session.vault.chamberBackup.batch.references.length}:null,
    rows:(await(await import('/src/lib/vault.ts')).loadHistory(app.session)).map(row=>({seq:row.seq,kind:row.payload.kind})),hidden:(await(await import('/src/lib/vault.ts')).loadUiPreferences(app.session)).hiddenChatMessageIds?.length??0}));
  assert.equal(sourceBackup.cursor,sourceBackup.lastSeq,JSON.stringify(sourceBackup));
  assert.equal(await a.evaluate(() => Boolean(app.session.vault.chamberBackup?.syncedAt && !app.session.vault.backup)), true);
  assert.equal(legacyUploads, 0);
  await a.screenshot({ path: '/private/tmp/chamber-chat-390.png' });
  await auditP1Surface(a,'chamber-chat','.chat-shell');
  await a.locator('[data-personal-guide="mnemonic"]').click(); await a.locator('[data-personal-show]').click(); await submitPassword(a, '246810');
  await a.locator('.chamber-mnemonic-grid li').first().waitFor();
  await a.locator('.password-sheet').waitFor({ state: 'detached' });
  assert.equal(await a.evaluate(async () => {
    const phrase = [...document.querySelectorAll('.chamber-mnemonic-grid li')].map(node => node.textContent).join(' ');
    return (await import('/src/lib/personal-identity.ts')).personalEntropyFromMnemonic(phrase).length === 16;
  }), true);
  const words = await a.locator('.chamber-mnemonic-grid li').allTextContents();
  for (const input of await a.locator('.chamber-mnemonic-check input').all()) {
    try { await fillFormInput(a, input, words[Number(await input.getAttribute('name'))]); }
    catch { throw new Error('Synthetic mnemonic confirmation field did not commit; secret values omitted'); }
  }
  await a.locator('.chamber-mnemonic-check [type=submit]').click(); await a.locator('.chat-shell').waitFor();
  assert.equal(await a.locator('.chamber-mnemonic-grid').count(), 0);
  assert.equal(await a.evaluate(() => app.session.vault.personalGuide.mnemonicChecked), true);
  await a.evaluate(() => app.runAutomaticBackup(true));
  await c.goto(url); await c.locator('#restore-cloud').click(); await c.locator('.numeric-password-page').waitFor();
  await submitPassword(c, '112233'); await c.locator('.chamber-import-grid').waitFor(); await c.locator('.password-sheet').waitFor({ state: 'detached' });
  for (const [index, input] of (await c.locator('.chamber-import-grid input').all()).entries()) {
    try { await fillFormInput(c, input, words[index]); } catch { throw new Error('Synthetic mnemonic import did not commit; secret values omitted'); }
  }
  await c.locator('#personal-import-form [type=submit]').click(); await c.locator('.chamber-restore-space').waitFor();
  await c.locator('.chamber-restore-space').click(); await submitPassword(c, '112233'); await c.locator('#personal-device-check').waitFor();
  const pendingDevice = await c.evaluate(() => app.session.vault.pendingPersonalDevice.proof.requestId);
  await c.reload(); await submitPassword(c, '112233'); await c.locator('#personal-device-check').waitFor();
  assert.equal(await c.evaluate(() => app.session.vault.pendingPersonalDevice.proof.requestId), pendingDevice);
  await b.locator('[data-personal-approve]').waitFor();
  assert.equal(await b.locator('[data-personal-approve]').evaluate(button => button.parentElement.querySelector('.device-safety-code').textContent),
    await c.locator('.device-safety-code').textContent());
  await b.locator('[data-personal-approve]').click(); await submitPassword(b, '135790');
  await c.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && !document.querySelector('#message-input')?.disabled);
  assert.equal(await c.getByText('Synthetic Chamber encrypted message', { exact: true }).count(), 0);
  await b.locator('#message-input').fill('Synthetic after independent device approval'); await b.locator('#composer').evaluate(form => form.requestSubmit());
  await c.getByText('Synthetic after independent device approval', { exact: true }).waitFor();
  await c.evaluate(()=>app.renderBackupSettings());await auditP1Surface(c,'chamber-backup','.backup-page');await c.locator('#chamber-history-scope').selectOption('all'); await c.locator('#chamber-history-start').click(); await submitPassword(c,'112233');
  await c.getByText(/请联系对方，核对请求编号/).waitFor();
  await b.evaluate(()=>app.renderBackupSettings()); await b.getByRole('button',{name:'核对申请并共同解密'}).click(); await submitPassword(b,'135790');
  await b.getByText(/已完成本次共同解密/).waitFor();
  await c.getByRole('button',{name:'解锁身份并恢复'}).waitFor();
  await c.waitForFunction(()=>!document.querySelector('#chamber-history-requests button')?.disabled);
  let downloads=0,interrupted=false;const restoredRequests=new Map();
  await c.route('**/chamber-history/*',async route=>{
    if(route.request().method()!=='GET'){await route.continue();return;}
    const id=new URL(route.request().url()).pathname.split('/').at(-1);restoredRequests.set(id,(restoredRequests.get(id)??0)+1);
    if(++downloads===2&&!interrupted){interrupted=true;await route.abort('connectionreset');return;}await route.continue();
  });
  await c.getByRole('button',{name:'解锁身份并恢复'}).click(); await submitPassword(c,'112233');
  await c.waitForFunction(()=>/fetch|网络|连接/i.test(document.querySelector('.backup-page .form-error')?.textContent??''));
  assert.equal(interrupted,true);assert.equal(await c.getByText(/已验证并恢复/).count(),0);
  await c.waitForFunction(()=>!document.querySelector('#chamber-history-requests button')?.disabled);
  await c.getByRole('button',{name:'解锁身份并恢复'}).click();await submitPassword(c,'112233');
  await c.getByText(/已验证并恢复/).waitFor(); await c.locator('#chamber-history-back').click();
  assert.equal([...restoredRequests.values()].filter(count=>count===1).length>0,true,'Verified ciphertext must survive interruption without redownloading every unit');
  await c.getByText('Synthetic Chamber encrypted message',{exact:true}).waitFor();
  assert.equal(await c.getByText('Synthetic locally hidden history',{exact:true}).count(),0);
  assert.deepEqual(await c.evaluate(async()=>{const v=await import('/src/lib/vault.ts'),rows=await v.loadHistory(app.session),prefs=await v.loadUiPreferences(app.session);const row=rows.find(m=>m.payload.text==='Synthetic locally hidden history');return {recordPresent:Boolean(row),hiddenMarked:Boolean(row&&prefs.hiddenChatMessageIds?.includes(row.clientMsgId))};}),{recordPresent:true,hiddenMarked:true});
  assert.deepEqual(await c.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),f=await import('/src/lib/file-crypto.ts'),rows=await v.loadHistory(app.session),prefs=await v.loadUiPreferences(app.session);
    const chat=rows.find(m=>m.payload.kind==='file'&&m.payload.file.originalName==='synthetic-exact.bin'),safe=rows.find(m=>m.payload.kind==='gallery-file'&&m.payload.file.originalName==='synthetic-safe.txt');
    const read=manifest=>f.decryptFileAttachment(manifest,async(id,index)=>{const chunk=await v.loadCachedMediaChunk(app.session,id,index,Math.min(manifest.chunkSize,manifest.originalSize-index*manifest.chunkSize)+16);if(!chunk)throw new Error('Synthetic restored original missing');return chunk;});
    return {bytes:Array.from(new Uint8Array(await(await read(chat.payload.file)).arrayBuffer())),safeText:await(await read(safe.payload.file)).text(),safeHidden:prefs.galleryCuration.some(mark=>mark.clientMsgId===safe.clientMsgId&&mark.hidden)};
  }),{bytes:[0,255,1,128,10,13,42],safeText:'Synthetic Safe original bytes',safeHidden:true});
  const bWords=await b.evaluate(async()=>{
    const v=await import('/src/lib/vault.ts'),p=await import('/src/lib/personal-identity-vault.ts'),m=await import('/src/lib/personal-identity.ts');
    const stored=await v.readPersonalIdentity(),credential=await v.unlockPersonalIdentityPassword(stored,'135790');
    try{return await p.usePersonalIdentity(stored,credential,entropy=>m.personalMnemonicFromEntropy(entropy).split(' '));}finally{delete credential.rootKek;}
  });
  await a.evaluate(()=>app.renderBackupSettings());await a.locator('#chamber-close-begin').click();
  for(const [index,input] of (await a.locator('#chamber-close-form input').all()).entries()) {
    try{await fillFormInput(a,input,words[index]);}catch{throw new Error('Synthetic close confirmation field did not commit; secret values omitted');}
  }
  await a.locator('#chamber-close-form [type=submit]').click();
  for(const page of [a,b,c])await page.getByRole('heading',{name:'密室已关闭',exact:true}).waitFor();
  assert.equal(await c.evaluate(async()=> (await (await import('/src/lib/spaces.ts')).localSpaces(app.session)).length),0);
  const oldDevice=await a.evaluate(()=>app.session.vault.identity.publicBundle.deviceId);
  for(const [page,phrase,pin] of [[a,words,'246810'],[b,bWords,'135790']]) {
    await page.locator('#chamber-reopen-begin').click();await page.locator('.numeric-password-page').waitFor();await submitPassword(page,pin);
    await page.locator('.chamber-import-grid').waitFor();await page.locator('.password-sheet').waitFor({state:'detached'});
    for(const [index,input] of (await page.locator('.chamber-import-grid input').all()).entries()) {
      try{await fillFormInput(page,input,phrase[index]);}catch{throw new Error('Synthetic reopen phrase field did not commit; secret values omitted');}
    }
    await page.locator('#personal-import-form [type=submit]').click();await page.locator('.chamber-restore-space').click();await submitPassword(page,pin);
    await page.locator('#chamber-reopen-check').waitFor();
  }
  for(const page of [a,b])await page.waitForFunction(()=>!document.querySelector('#chamber-reopen-approve')?.disabled);
  assert.equal(await a.locator('#chamber-reopen-safety').textContent(),await b.locator('#chamber-reopen-safety').textContent());
  await a.locator('#chamber-reopen-approve').click();await submitPassword(a,'246810');
  assert.equal(await a.evaluate(()=>app.session.vault.chamberLifecycle.closed),true);
  await b.locator('#chamber-reopen-approve').click();await submitPassword(b,'135790');
  for(const page of [a,b]) {
    try {await page.waitForFunction(()=>app.session?.vault.mls?.phase==='active'&&document.querySelector('#message-input')&&!document.querySelector('#message-input').disabled);}
    catch(cause) {console.error('Synthetic reopen diagnostic',await page.evaluate(()=>({pending:Boolean(app.session?.vault.pendingChamberReopen),title:document.querySelector('h1')?.textContent,error:document.querySelector('.form-error')?.textContent,fatal:document.querySelector('#fatal-message')?.textContent})),errors);throw cause;}
  }
  assert.notEqual(await a.evaluate(()=>app.session.vault.identity.publicBundle.deviceId),oldDevice);
  assert.equal(await a.getByText('Synthetic Chamber encrypted message',{exact:true}).count(),0);
  await a.locator('#message-input').fill('Synthetic fresh generation');await a.locator('#composer').evaluate(form=>form.requestSubmit());await b.getByText('Synthetic fresh generation',{exact:true}).waitFor();
  await a.evaluate(()=>app.runAutomaticBackup(true));
  // A later independent-device restore must authenticate the CURRENT roster,
  // rather than treating the now-revoked invitation devices as current peers.
  await c.locator('#chamber-reopen-begin').click();await c.locator('.numeric-password-page').waitFor();await submitPassword(c,'112233');
  await c.locator('.chamber-import-grid').waitFor();await c.locator('.password-sheet').waitFor({state:'detached'});
  for(const [index,input] of (await c.locator('.chamber-import-grid input').all()).entries())try{await fillFormInput(c,input,words[index]);}catch{throw new Error('Synthetic later-device phrase input failed; values omitted');}
  await c.locator('#personal-import-form [type=submit]').click();await c.locator('.chamber-restore-space').click();await submitPassword(c,'112233');await c.locator('#personal-device-check').waitFor();
  assert.equal(await c.evaluate(()=>app.session.vault.pendingPersonalDevice.proof.version),2);
  await b.locator('[data-personal-approve]').click();await submitPassword(b,'135790');await c.locator('#message-input').waitFor();
  assert.equal(await c.getByText('Synthetic fresh generation',{exact:true}).count(),0);
  await b.locator('#message-input').fill('Synthetic after generation-two device approval');await b.locator('#composer').evaluate(form=>form.requestSubmit());await c.getByText('Synthetic after generation-two device approval',{exact:true}).waitFor();
  bWords.fill('');
  words.fill('');
  assert.deepEqual(errors, []);
  console.log('Chamber: protected roots, exclusive invitation, MLS, independent device boundary, two-root history restore, signed closure and two-root fresh-generation reopening passed.');
} finally {
  await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true });
}
