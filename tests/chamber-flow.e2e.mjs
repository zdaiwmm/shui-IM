import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 3, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0' });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', error => errors.push(error.message)); pages.push(page);
  }
  const [a, b, c] = pages, url = `http://127.0.0.1:${vite.httpServer.address().port}/`;
  const blocked = await browser.newPage({viewport:{width:390,height:844}});
  await blocked.addInitScript(() => { indexedDB.open = () => { throw new DOMException('Synthetic blocked storage', 'SecurityError'); }; });
  await blocked.goto(`${url}#invite=synthetic-startup`);
  await blocked.locator('#startup-retry').waitFor();
  assert.equal(await blocked.evaluate(() => location.hash), '#invite=synthetic-startup');
  assert.match(await blocked.locator('#app h1').textContent(), /无法打开/);
  await blocked.close();
  await a.goto(url); await a.locator('.chamber-brand').waitFor();
  await a.locator('.chamber-room').evaluate(element => { const animation = element.getAnimations()[0]; if(animation) animation.currentTime = 3000; });
  assert.equal(await a.locator('.chamber-room').evaluate(element => getComputedStyle(element).animationIterationCount), 'infinite');
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
  await a.locator('#create-room').click(); assert.equal(await a.locator('.space-profile-overlay').count(), 0);
  await a.locator('.numeric-password-page').waitFor();
  assert.match(await a.locator('.numeric-browser-hint').textContent(), /系统浏览器/);
  await submitPassword(a, '246810'); await a.locator('.chat-shell').waitFor();
  assert.equal(protectedBeforeRoom, true);
  assert.equal(deviceBeforeRoom, true); assert.equal(lostCreateResponse, true); assert.equal(creationIds.size, 1);
  assert.equal(await a.locator('.entry-invite-status').count(), 0);
  assert.equal(await a.locator('#chamber-invite-restart').isVisible(), false);
  assert.deepEqual(await a.locator('[data-personal-guide] strong').allTextContents(), ['助记词', '入口遮蔽', '自动锁定']);
  assert.equal(await a.getByText('稍后再设', { exact: true }).count(), 0);
  const evidence=process.env.QUIET_ROOM_UI_EVIDENCE;
  if(evidence)await mkdir(evidence,{recursive:true});
  const capture=async name=>{if(evidence)await a.screenshot({path:path.join(evidence,`${name}.png`),animations:'disabled'});};
  await capture('inviter-before-claim');
  const floating=await a.locator('.chamber-chat-header').evaluate(header=>({background:getComputedStyle(header).backgroundColor,
    capsule:header.querySelector('.chamber-presence-capsule').getBoundingClientRect().height,settings:header.querySelector('#chat-settings').getBoundingClientRect().height}));
  assert.equal(floating.background,'rgba(0, 0, 0, 0)');assert.ok(floating.capsule>=44&&floating.settings>=44);
  for(const scheme of ['light','dark']) {
    await a.emulateMedia({colorScheme:scheme});
    await a.waitForFunction(scheme=>document.documentElement.dataset.colorScheme===scheme,scheme);
    await a.locator('[data-personal-guide="mnemonic"]').click();
    await a.locator('.chamber-mnemonic-page').waitFor();
    await a.waitForFunction(()=>!document.querySelector('#app > .page-transition-incoming, #app > .page-transition-outgoing'));
    assert.equal(await a.locator('.chamber-mnemonic-page header').count(),0);
    await a.locator('.chamber-mnemonic-page .chamber-brand').evaluate(mark=>{ for(const animation of mark.getAnimations({subtree:true})) { animation.pause(); animation.currentTime=3000; } });
    assert.ok(await a.locator('.chamber-mnemonic-page .chamber-person-one').evaluate(person=>Number(getComputedStyle(person).opacity)>.9));
    const brand=await a.locator('.chamber-mnemonic-page .chamber-brand').boundingBox();assert.ok(Math.abs(brand.x+brand.width/2-195)<1,JSON.stringify(brand));
    const back=await a.locator('[data-personal-back]').boundingBox();assert.ok(back.y+back.height<=844);
    await capture(`mnemonic-${scheme}`);
    await a.locator('[data-personal-show]').click(); await a.locator('.numeric-password-page').waitFor();
    assert.equal(await a.locator('.password-operation-sheet').count(),0);
    await a.locator('[data-numeric-left]').click(); await a.locator('.numeric-password-page').waitFor({state:'detached'});
    await a.locator('[data-personal-back]').click();
    await a.locator('[data-personal-guide="auto-lock"]').click();await a.locator('.auto-lock-page').waitFor();
    assert.equal(await a.locator('[data-idle-toggle]').getAttribute('aria-checked'),'false');
    assert.equal(await a.locator('[data-hidden-lock]').getAttribute('aria-checked'),'true');
    assert.equal(await a.locator('[data-blank-lock]').getAttribute('aria-checked'),'true');
    await capture(`auto-lock-${scheme}`);await a.locator('#auto-lock-back').click();
    await a.locator('[data-personal-guide="cover"]').click();await a.locator('.cover-practice-page').waitFor();
    assert.equal(await a.locator('.cover-practice-page header').count(),0);
    assert.equal(await a.locator('#practice-back,.cover-practice-title').count(),0);
    await capture(`cover-${scheme}`);
    await a.locator('.practice-hotspot').focus(); await a.keyboard.down('Enter'); await a.locator('#skip-cover').waitFor(); await a.keyboard.up('Enter');
    const skip=await a.locator('#skip-cover').boundingBox(),enable=await a.locator('#enable-cover').boundingBox();assert.ok(skip.x<enable.x);
    await a.locator('#skip-cover').click();
  }
  await a.emulateMedia({colorScheme:'light'});
  const invite = await a.locator('#invite-url').inputValue();
  await b.route('**/api/rooms/*', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic temporary invitation failure'})}), {times:1});
  await b.goto(invite); await b.locator('#join-unavailable-retry').waitFor();
  await b.locator('#join-unavailable-retry').click(); await b.locator('.numeric-password-page').waitFor();
  // A competing visitor is rejected before a root, device key or password ceremony is created.
  await c.goto(invite); await c.getByText(/该密室已被其他人进入/).waitFor();
  assert.equal(await c.locator('.numeric-password-page').count(), 0);
  assert.equal(await c.evaluate(async () => (await (await import('/src/lib/vault.ts')).readPersonalIdentity()) === null), true);
  await a.locator('#copy-chamber-code').waitFor();
  const earlyCode = await a.evaluate(() => app.chamberInviteState.code);
  assert.match(earlyCode, /^\d{4}$/);
  await a.context().grantPermissions(['clipboard-read','clipboard-write']);
  await a.locator('#copy-chamber-code').click();
  assert.equal(await a.evaluate(()=>navigator.clipboard.readText()),earlyCode);
  assert.equal(await a.locator('#copy-chamber-code').textContent(),'复制');
  assert.match(await a.locator('#invite-countdown').textContent(),/^有效期：\d+:\d{2}$/);
  await capture('inviter-after-claim');
  assert.equal(await a.locator('#chamber-invite-restart').isVisible(), true);
  await a.locator('#chamber-invite-restart').click();
  await a.locator('[data-restart-cancel]').click();
  await a.locator('.chamber-restart-confirm').waitFor({state:'detached'});
  assert.equal(await a.evaluate(()=>app.chamberInviteState.code),earlyCode);
  assert.equal(await b.locator('.numeric-browser-hint').count(), 0);
  await submitPassword(b, '135790'); await b.locator('.chamber-code-card').waitFor();
  assert.equal(await a.evaluate(() => app.chamberInviteState.code), earlyCode);
  let before = await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation }));
  await b.screenshot({ path: '/private/tmp/chamber-invite-390.png' });
  await auditP1Surface(b,'chamber-invite','.chamber-join-shell');
  for(let round=0;round<3;round++) {
    await b.locator('[data-code-digit="0"]').click(); await b.locator('#form-input-draft').fill('1');
    await b.evaluate(()=>{ window.syntheticHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.syntheticHidden});document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await b.locator('.chamber-join-shell').count(),0);
    await b.evaluate(async()=>{window.syntheticHidden=false;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));await app.renderGateway({trustedCoverActivation:true,autoUnlock:false});});
    await submitPassword(b,'135790');await b.locator('.chamber-code-card').waitFor();
    assert.deepEqual(await b.locator('[data-code-digit]').evaluateAll(nodes=>nodes.map(n=>n.value)),['','','','']);
    assert.deepEqual(await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation })), before);
  }
  await b.reload(); await submitPassword(b, '135790'); await b.locator('.chamber-code-card').waitFor();
  assert.deepEqual(await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation })), before);
  await b.goto(invite);await b.locator('.chamber-code-card').waitFor();
  assert.deepEqual(await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation })), before);
  const oldSlot=await b.evaluate(()=>app.session.stored.spaceId??'current'),rootRecord=await b.evaluate(async()=>JSON.stringify(await(await import('/src/lib/vault.ts')).readPersonalIdentity()));
  await a.evaluate(()=>{ window.stableInvite=document.querySelector('.chamber-invite-hero');window.stableCode=document.querySelector('.chamber-code-display');for(let i=0;i<12;i++){app.renderMessages();app.paintInlineInviteCountdown();} });
  assert.equal(await a.evaluate(()=>window.stableInvite===document.querySelector('.chamber-invite-hero')&&window.stableCode===document.querySelector('.chamber-code-display')),true);
  await a.clock.install(); await a.clock.fastForward(5*60_000);
  assert.deepEqual(await a.locator('.chamber-code-display > span').allTextContents(),earlyCode.split(''));
  await a.clock.setSystemTime(new Date());
  // Expiry is real server-side state, not only a mocked countdown. Keep timers
  // real in Node while advancing its wall clock and both browser clocks.
  const RealDate = globalThis.Date, shiftedNow = RealDate.now()+31*60_000;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [RealDate.now()+31*60_000])); }
    static now() { return RealDate.now()+31*60_000; }
  };
  try {
    await b.clock.install({time:new RealDate(shiftedNow)}); await a.clock.setSystemTime(new RealDate(shiftedNow));
    await b.evaluate(()=>app.renderPendingChamberJoin());
    await b.locator('#chamber-refresh-code').waitFor();
    assert.equal(await b.locator('[data-code-active]').isVisible(),false);
    assert.equal(await b.getByText('本次邀请剩余',{exact:true}).count(),0);
    await a.evaluate(async()=>{app.chamberInvitePolledAt=0;await app.pollChamberInvitation();});
    assert.match(await a.locator('#chamber-invite-status').textContent(),/验证码已失效/);
    assert.equal(await a.locator('.chamber-code-display').count(),0);
    assert.equal(await a.locator('#copy-invite').textContent(),'复制邀请链接');
    const refreshes=[];
    const loseRefresh=async route=>{
      if(route.request().method()!=='POST'||route.request().postDataJSON().action!=='refresh-code'){await route.continue();return;}
      refreshes.push(route.request().postDataJSON().refreshId);
      const response=await route.fetch();assert.equal(response.status(),200);
      if(refreshes.length===1)await route.abort('connectionreset');else await route.fulfill({response});
    };
    await b.route('**/chamber-invitation',loseRefresh);
    await b.locator('#chamber-refresh-code').click();
    await b.waitForFunction(()=>document.querySelector('.chamber-code-card .form-error')?.textContent);
    await b.locator('#chamber-refresh-code').click();
    await b.locator('[data-code-active]').waitFor();
    assert.equal(refreshes.length,2);assert.equal(refreshes[0],refreshes[1]);
    const afterRefresh=await b.evaluate(()=>({root:app.session.vault.personalBinding.identity.id,...app.session.vault.pendingChamberInvitation}));
    assert.equal(afterRefresh.root,before.root);assert.equal(afterRefresh.requestId,before.requestId);assert.equal(afterRefresh.version,before.version);
    assert.equal(afterRefresh.codeRevision,2);
    assert.equal(await b.evaluate(()=>app.session.stored.spaceId??'current'),oldSlot);
    assert.equal(await a.locator('#invite-url').inputValue(),invite);
    await a.evaluate(async()=>{app.chamberInvitePolledAt=0;await app.pollChamberInvitation();});
    assert.notEqual(await a.evaluate(()=>app.chamberInviteState.code),earlyCode);
    assert.equal(await a.locator('.chamber-code-display > span').count(),4);
    await b.unroute('**/chamber-invitation',loseRefresh);
    before=afterRefresh;
  } finally { globalThis.Date=RealDate;await a.clock.setSystemTime(new RealDate());await b.clock.setSystemTime(new RealDate()); }
  const expiringVersion=await a.evaluate(()=>app.chamberInviteState.version);
  const rotationReplies=[];
  await a.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);if(this.name==='vault'&&window.failNextRotationCommit){window.failNextRotationCommit=false;IDBObjectStore.prototype.put=put;this.transaction.abort();}return request;};});
  const expiredReply=async route=>{
    if(route.request().method()!=='GET'&&route.request().postDataJSON().action!=='rotate'){await route.continue();return;}
    const response=await route.fetch(),state=await response.json();
    if(route.request().method()==='POST'){
      rotationReplies.push({version:state.version,requestId:state.requestId,expiresAt:state.expiresAt});
      if(rotationReplies.length===1)await a.evaluate(()=>{window.failNextRotationCommit=true;});
    }else if(state.version===expiringVersion){state.stage='blocked';delete state.code;}
    await route.fulfill({response,json:state});
  };
  await a.route('**/chamber-invitation',expiredReply);
  await a.evaluate(async()=>{app.chamberInvitePolledAt=0;await app.pollChamberInvitation();});
  await a.getByRole('button',{name:'重新发起邀请',exact:true}).first().waitFor();
  assert.equal(await a.locator('#chamber-invite-restart').isVisible(),false);
  assert.equal(await a.getByText('本次邀请已结束',{exact:true}).count(),0);
  await a.locator('#copy-invite').click(); await a.locator('[data-restart-confirm]').click();
  await a.waitForFunction(()=>app.session.vault.pendingInvitationRotation&&!app.chamberInviteRotating);
  assert.equal(await a.locator('#invite-url').inputValue(),invite,'Failed local commit exposed an uncommitted link');
  assert.equal(await a.locator('#chamber-invite-status').isVisible(),false);
  await a.getByRole('button',{name:'重新发起邀请',exact:true}).click(); await a.locator('[data-restart-confirm]').click();
  await a.waitForFunction(old=>document.querySelector('#invite-url').value!==old,invite);
  assert.equal(rotationReplies.length,2);assert.deepEqual(rotationReplies[1],rotationReplies[0],'Retry must reuse the server rotation without extending its deadline');
  const nextInvite=await a.locator('#invite-url').inputValue();assert.notEqual(nextInvite,invite);
  await a.waitForFunction(async url=>(await navigator.clipboard.readText())===url,nextInvite);
  assert.equal(await a.locator('#invite-countdown').count(),0);
  assert.equal(await a.locator('.chamber-code-display > span').count(),0);
  assert.equal(await a.evaluate(()=>app.chamberInviteState.expiresAt),null);
  await a.unroute('**/chamber-invitation',expiredReply);
  await a.clock.setSystemTime(new Date());
  await b.goto('about:blank');await b.goto(nextInvite);await b.locator('#chamber-existing-join').click();await submitPassword(b,'135790');await b.locator('.chamber-code-card').waitFor();
  const next=await b.evaluate(() => ({ root: app.session.vault.personalBinding.identity.id, ...app.session.vault.pendingChamberInvitation }));
  assert.equal(next.root,before.root);assert.notEqual(next.requestId,before.requestId);before=next;
  assert.equal(await b.evaluate(async()=>JSON.stringify(await(await import('/src/lib/vault.ts')).readPersonalIdentity())),rootRecord);
  assert.equal(await b.evaluate(async id=>(await import('/src/lib/vault.ts')).localSpaceExists(id),oldSlot),true);
  await a.waitForFunction(() => app.chamberInviteState?.stage === 'code');
  const code = await a.evaluate(() => app.chamberInviteState.code);
  assert.match(code, /^\d{4}$/);
  assert.deepEqual(await a.locator('.chamber-code-display > span').allTextContents(), code.split(''));
  assert.equal(await a.locator('.chat-header .spaces-entry').count(), 0);
  assert.equal(await a.locator('.chamber-presence-capsule .presence-circuit').count(), 1);
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
  assert.equal(await b.locator('[data-request]').count(), 0);
  assert.equal(await a.locator('.chamber-invite-hero .chamber-privacy-guide').count(), 0);
  const digits = b.locator('[data-code-digit]');
  assert.equal(await digits.count(), 4);
  const codeBackground=await b.locator('.chamber-join-shell').boundingBox();
  await digits.nth(0).click();await b.locator('#form-input-draft').fill('1234');
  assert.equal(await b.locator('.form-input-code-cells > span').count(),4);
  assert.deepEqual(await b.locator('.form-input-code-cells > span').allTextContents(),['1','2','3','4']);
  await b.locator('#form-input-draft').press('Backspace');await b.locator('#form-input-draft').press('Backspace');
  assert.equal(await b.locator('#form-input-draft').inputValue(),'12');
  await b.locator('#form-input-draft').fill(code);
  assert.deepEqual(await b.locator('.chamber-join-shell').boundingBox(),codeBackground);
  // Lost transport while the inviter is on a settings child must be repaired
  // by the unlocked session, without navigating back to chat to drive it.
  await a.locator('#chat-settings').click();
  await a.locator('#auto-lock-settings').click();
  await a.locator('.auto-lock-page').waitFor();
  await a.evaluate(() => app.socket.close());
  await b.evaluate(() => {
    window.activationObserver = new MutationObserver(() => {
      const shell = document.querySelector('.chat-shell');
      if (shell && !window.initialJoinedChat) window.initialJoinedChat = {shell,input:shell.querySelector('#message-input'),guide:shell.querySelector('.chamber-privacy-guide')};
    });
    activationObserver.observe(document.querySelector('#app'),{childList:true});
  });
  await b.locator('[data-form-input-done]').click();
  await b.locator('.form-input-overlay').waitFor({state:'detached'});
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
  assert.equal(await b.evaluate(() => {
    activationObserver.disconnect();
    return initialJoinedChat.shell === document.querySelector('.chat-shell') && initialJoinedChat.input === document.querySelector('#message-input') && initialJoinedChat.guide === document.querySelector('.chamber-privacy-guide');
  }),true,'Initial activation must retain the chat, composer and guide nodes');
  assert.equal(await a.locator('.auto-lock-page').count(), 1, 'Activation must retain the settings page');
  await a.locator('#auto-lock-back').click();
  await a.locator('.space-settings-list').waitFor();
  assert.equal(await a.locator('#chamber-migration-settings').count(),0,'New Chamber rooms do not offer legacy migration');
  await a.locator('.space-close').click();
  await a.locator('.space-drawer-overlay').waitFor({state:'detached'});
  await a.waitForFunction(()=>document.querySelector('.chat-shell') && !document.querySelector('.chat-shell').inert);
  assert.equal(await a.locator('#open-gallery.chamber-presence-capsule').count(), 1);
  assert.equal(await b.locator('#open-gallery').count(), 0);
  assert.equal(await a.locator('#message-list > .chamber-privacy-guide').count(), 1, 'Activated chat keeps guidance inside the keyboard-following timeline');
  await a.locator('#message-input').fill('Synthetic Chamber encrypted message'); await a.locator('#composer').evaluate(form => form.requestSubmit());
  try { await b.getByText('Synthetic Chamber encrypted message', { exact: true }).waitFor(); }
  catch(cause) {
    for(const [side,p] of [['inviter',a],['joiner',b]]) console.error('Synthetic first-message diagnostic',side,await p.evaluate(()=>({
      connection:app.connectionState,transport:app.socket?.connected,covered:app.privacyCovered,surface:app.activeSurface,
      pairing:app.session?.vault.pairingState,phase:app.session?.vault.mls?.phase,lastSeq:app.session?.vault.lastSeq,
      outbox:app.outbox.size,pending:app.pending.size,queued:app.serverQueue.size,messages:app.messages.size,
      input:document.querySelector('#message-input')?.value,notice:document.querySelector('#notice')?.textContent,
      fatal:document.querySelector('#fatal-message')?.textContent,fail:app.accessFailure,
      syntheticMessagePresent:document.body.textContent.includes('Synthetic Chamber encrypted message'),
    })));
    throw cause;
  }
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
  await a.locator('#chat-settings').click();await a.locator('#chamber-switch-space').click();
  await a.locator('.is-space-list-page').waitFor();await a.getByRole('dialog',{name:'私密空间',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
  await a.locator('.space-drawer-overlay').waitFor({state:'detached'});
  await a.locator('[data-personal-guide="mnemonic"]').click(); await a.locator('[data-personal-show]').click(); await submitPassword(a, '246810');
  await a.locator('.chamber-mnemonic-grid li').first().waitFor();
  await a.locator('.password-sheet').waitFor({ state: 'detached' });
  assert.equal(await a.evaluate(async () => {
    const phrase = [...document.querySelectorAll('.chamber-mnemonic-grid li')].map(node => node.textContent).join(' ');
    return (await import('/src/lib/personal-identity.ts')).personalEntropyFromMnemonic(phrase).length === 16;
  }), true);
  const words = await a.locator('.chamber-mnemonic-grid li').allTextContents();
  assert.equal(await a.locator('.chamber-mnemonic-check').count(),0);
  assert.equal(await a.locator('.chamber-mnemonic-words-page').count(),1);
  assert.equal(await a.locator('[data-personal-show]').count(),0);
  await a.locator('[data-personal-words-back]').click(); await a.locator('[data-personal-show]').waitFor();
  assert.equal(await a.locator('.chamber-mnemonic-grid li').count(),0,'Words clear synchronously before the empty outgoing page finishes');
  await a.locator('.chamber-mnemonic-words-page').waitFor({state:'detached'});
  await a.locator('[data-personal-back]').click(); await a.locator('.chat-shell').waitFor();
  assert.equal(await a.evaluate(() => app.session.vault.personalGuide.mnemonicViewed),true);
  assert.equal(await a.evaluate(() => Boolean(app.session.vault.personalGuide.mnemonicChecked)),false);
  await a.evaluate(() => app.runAutomaticBackup(true));
  await c.goto(url); await c.locator('#restore-cloud').click(); await c.locator('.numeric-password-page').waitFor();
  await submitPassword(c, '112233'); await c.locator('.chamber-import-grid').waitFor(); await c.locator('.password-sheet').waitFor({ state: 'detached' });
  for (const [index, input] of (await c.locator('.chamber-import-grid input').all()).entries()) {
    try { await fillFormInput(c, input, words[index]); } catch { throw new Error('Synthetic mnemonic import did not commit; secret values omitted'); }
  }
  await c.getByRole('button',{name:'验证我的身份',exact:true}).click(); await c.locator('.chamber-restore-space').waitFor();
  await c.locator('.chamber-restore-space').click(); await submitPassword(c, '112233'); await c.locator('#personal-device-check').waitFor();
  const pendingDevice = await c.evaluate(() => app.session.vault.pendingPersonalDevice.proof.requestId);
  await c.reload(); await submitPassword(c, '112233'); await c.locator('#personal-device-check').waitFor();
  assert.equal(await c.evaluate(() => app.session.vault.pendingPersonalDevice.proof.requestId), pendingDevice);
  try { await b.locator('[data-personal-approve]').waitFor(); }
  catch {
    const diagnostic=await b.evaluate(()=>({protected:app.privacyCovered,surface:app.activeSurface,hidden:document.hidden,dialogs:document.querySelectorAll('[role=dialog],.space-drawer-overlay').length,phase:app.session?.vault.mls?.phase,root:document.querySelector('#app')?.firstElementChild?.className,connected:app.socket?.connected}));
    throw new Error(`Synthetic device approval did not appear: ${JSON.stringify(diagnostic)}`);
  }
  assert.equal(await b.locator('[data-personal-approve]').evaluate(button => button.parentElement.querySelector('.device-safety-code').textContent),
    await c.locator('.device-safety-code').textContent());
  await b.locator('[data-personal-approve]').click(); await submitPassword(b, '135790');
  await c.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && !document.querySelector('#message-input')?.disabled);
  assert.equal(await c.getByText('Synthetic Chamber encrypted message', { exact: true }).count(), 0);
  await b.locator('#message-input').fill('Synthetic after independent device approval'); await b.locator('#composer').evaluate(form => form.requestSubmit());
  try { await c.getByText('Synthetic after independent device approval', { exact: true }).waitFor(); }
  catch(cause) {
    for(const [name,page] of [['sender',b],['new-device',c]])console.log('CHAMBER_POST_APPROVAL_STATE',name,await page.evaluate(()=>({covered:app.privacyCovered,activeSurface:app.activeSurface,pairing:app.session?.vault.pairingState,phase:app.session?.vault.mls?.phase,epoch:app.session?.vault.mls?.epoch,failedAccess:Boolean(app.accessFailure),socket:app.socket?.connected,matchedMessage:[...app.messages.values()].some(m=>m.payload.text==='Synthetic after independent device approval'),pending:app.pending.size,outbox:app.outbox.size,inputLength:document.querySelector('#message-input')?.value.length,inert:Boolean(document.querySelector('#message-input')?.closest('[inert]')),dialogs:document.querySelectorAll('.dialog-surface').length,errors:[...document.querySelectorAll('.form-error,.app-toast.error')].map(n=>n.textContent)})));
    throw cause;
  }
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
    await page.getByRole('button',{name:'验证我的身份',exact:true}).click();await page.locator('.chamber-restore-space').click();await submitPassword(page,pin);
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
  await c.getByRole('button',{name:'验证我的身份',exact:true}).click();await c.locator('.chamber-restore-space').click();await submitPassword(c,'112233');await c.locator('#personal-device-check').waitFor();
  assert.equal(await c.evaluate(()=>app.session.vault.pendingPersonalDevice.proof.version),2);
  await b.locator('[data-personal-approve]').click();await submitPassword(b,'135790');await c.locator('#message-input').waitFor();
  assert.equal(await c.getByText('Synthetic fresh generation',{exact:true}).count(),0);
  await b.locator('#message-input').fill('Synthetic after generation-two device approval');await b.locator('#composer').evaluate(form=>form.requestSubmit());await c.getByText('Synthetic after generation-two device approval',{exact:true}).waitFor();
  // Forgotten daily lock opens identity verification before any new-lock setup.
  const originalIdentity=await c.evaluate(async()=>JSON.stringify(await(await import('/src/lib/vault.ts')).readPersonalIdentity()));
  const originalSlot=await c.evaluate(()=>app.session.stored.spaceId??'current');
  await c.reload();await c.locator('.numeric-password-mandatory').waitFor();
  assert.equal(await c.getByRole('button',{name:'取消',exact:true}).count(),0);
  await c.getByRole('button',{name:'忘记密码？',exact:true}).click();await c.locator('#personal-import-form').waitFor();
  assert.equal(await c.locator('.numeric-password-page').count(),0);
  for(const viewport of [{width:320,height:568},{width:390,height:664},{width:390,height:844}]) {
    await c.setViewportSize(viewport);
    const geometry=await c.locator('.chamber-identity-import').evaluate(page=>({scroll:page.scrollHeight,height:page.clientHeight,actions:page.querySelector('.chamber-import-actions').getBoundingClientRect().bottom,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.ok(geometry.scroll<=geometry.height+1&&geometry.actions<=viewport.height+1&&!geometry.overflow,JSON.stringify({viewport,geometry}));
  }
  await c.setViewportSize({width:390,height:844});
  if(evidence)await c.screenshot({path:path.join(evidence,'forgot-identity-empty.png')});
  await fillFormInput(c,c.locator('.chamber-import-grid input').first(),words[0]);
  await c.locator('#form-input-draft').press('Escape');
  await c.locator('#personal-import-back').click();await c.locator('.numeric-password-mandatory').waitFor();
  assert.equal(await c.evaluate(async()=>JSON.stringify(await(await import('/src/lib/vault.ts')).readPersonalIdentity())),originalIdentity);
  await c.getByRole('button',{name:'忘记密码？',exact:true}).click();await c.locator('#personal-import-form').waitFor();
  assert.equal(await c.locator('.chamber-import-grid input').evaluateAll(nodes=>nodes.every(node=>!node.value)),true);
  // Another valid identity must not reset this browser's root wrapper.
  const otherWords=await c.evaluate(async()=>{const p=await import('/src/lib/personal-identity.ts');return p.personalMnemonicFromEntropy(new Uint8Array(16).fill(71)).split(' ');});
  for(const [index,input] of (await c.locator('.chamber-import-grid input').all()).entries())try{await fillFormInput(c,input,otherWords[index]);}catch{throw new Error('Synthetic non-owner phrase input failed; values omitted');}
  otherWords.fill('');await c.getByRole('button',{name:'验证我的身份',exact:true}).click();
  await c.getByText(/不属于此浏览器保管的身份/).waitFor();
  assert.equal(await c.locator('.numeric-password-page').count(),0);
  assert.equal(await c.evaluate(async()=>JSON.stringify(await(await import('/src/lib/vault.ts')).readPersonalIdentity())),originalIdentity);
  for(const [index,input] of (await c.locator('.chamber-import-grid input').all()).entries())try{await fillFormInput(c,input,words[index]);}catch{throw new Error('Synthetic forgotten-lock phrase input failed; values omitted');}
  await c.getByRole('button',{name:'验证我的身份',exact:true}).click();await c.locator('.numeric-password-page').waitFor();
  assert.equal(await c.locator('h2').last().textContent(),'设置应用锁');
  await submitPassword(c,'223344');await c.locator('.chamber-restore-space').waitFor();
  const reset=await c.evaluate(async()=>{const v=await import('/src/lib/vault.ts');const stored=await v.readPersonalIdentity();return{identity:stored.identity.id,record:JSON.stringify(stored)};});
  assert.notEqual(reset.record,originalIdentity);
  assert.equal(reset.identity,JSON.parse(originalIdentity).identity.id);
  assert.equal(await c.evaluate(async id=>(await import('/src/lib/vault.ts')).localSpaceExists(id),originalSlot),true);
  const abortedReset=await c.evaluate(async words=>{
    const v=await import('/src/lib/vault.ts'),p=await import('/src/lib/personal-identity.ts'),envelope=await import('/src/lib/personal-identity-vault.ts'),protection=await import('/src/lib/password-protection.ts');
    const expected=await v.readPersonalIdentity(),entropy=p.personalEntropyFromMnemonic(words.join(' ')),credential=await protection.deriveNumericPasswordCredential('334455');
    const candidate=await envelope.preparePersonalIdentity(credential,entropy);entropy.fill(0);
    const controller=new AbortController(),put=IDBObjectStore.prototype.put;let aborted=false;
    IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);if(this.name==='security'&&args[1]===`chamber:personal:${expected.identity.id}`)controller.abort();return request;};
    try {await v.replacePersonalIdentityProtection(expected,candidate,controller.signal);}
    catch(cause){aborted=cause?.name==='AbortError';}
    finally{IDBObjectStore.prototype.put=put;app.releasePersonalCredential(credential);}
    return{aborted,unchanged:JSON.stringify(await v.readPersonalIdentity())===JSON.stringify(expected)};
  },words);
  assert.deepEqual(abortedReset,{aborted:true,unchanged:true},'Cancellation during root-wrapper write must roll back');
  bWords.fill('');
  words.fill('');
  assert.deepEqual(errors, []);
  console.log('Chamber: protected roots, exclusive invitation, MLS, independent device boundary, two-root history restore, signed closure and two-root fresh-generation reopening passed.');
} finally {
  await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true });
}
