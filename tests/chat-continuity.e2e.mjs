import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'chat-list-viewport-fixture', configureServer(vite) {
    vite.middlewares.use('/__list_viewport', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 393, height: 695 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__list_viewport`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    await import('/src/gallery.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault } = await import('/src/lib/vault.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    // Desktop WebKit does not implement iOS touch-callout support, even with
    // touch emulation. Select the device layout explicitly in this fixture.
    app.visualClientCoordinates = true;
    app.usesListScrolling = true;
    const member = { deviceId: 'list-own', role: 'creator', status: 'active' };
    const session = await createVault({ v: 1, roomId: 'list-viewport-fixture', accessToken: 'test', role: 'creator',
      protocol: 'legacy-v1', lastSeq: 180, members: [member, { deviceId: 'list-peer', role: 'joiner', status: 'active' }],
      identity: { publicBundle: member } }, 'list-viewport-test-passphrase', 'password');
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch += 1;
    app.runtimeAbort = new AbortController();
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
    app.uiPreferencesHydrated = true;
    app.messages = new Map(Array.from({ length: 180 }, (_, index) => {
      const seq = index + 1;
      return [seq, { seq, clientMsgId: `list-message-${seq}`, senderId: 'list-peer',
        payload: { v: 1, kind: 'text', text: `Layout fixture message ${seq}`, sentAt: '2026-09-08T01:00:00.000Z' },
        acceptedAt: '2026-09-08T01:00:00.000Z', status: 'delivered' }];
    }));
    app.renderChat();
    app.renderMessages({ scroll: 'bottom' });
    window.listFixture = { app };
  });
  const settled = () => page.waitForFunction(() => {
    const app = window.listFixture.app;
    const composerPositioning = document.querySelector('#composer')?.dataset.viewportMotion === 'positioning';
    return (!app.chatViewportMotion?.moving || (composerPositioning && !app.chatViewportMotion?.concealed)) && !app.chatBottomControl?.scrolling
      && !app.composerHeightMotion && !app.listKeyboardLayout.moving;
  }, undefined, { timeout: 60_000 }).catch(async error => {
    const state = await page.evaluate(() => {
      const app = window.listFixture.app;
      const viewport = window.visualViewport;
      return {
        motion: app.chatViewportMotion?.moving ?? false,
        concealed: app.chatViewportMotion?.concealed ?? false,
        keyboardMoving: app.chatViewportMotion?.keyboardMoving ?? false,
        bottomScrolling: app.chatBottomControl?.scrolling ?? false,
        composerHeightMotion: Boolean(app.composerHeightMotion),
        listKeyboardMoving: app.listKeyboardLayout.moving,
        viewport: { width: viewport?.width, height: viewport?.height, top: viewport?.offsetTop },
        layoutHeight: document.documentElement.clientHeight,
        composerMotion: document.querySelector('#composer')?.dataset.viewportMotion ?? null,
      };
    });
    throw new Error(`${error.message}; state=${JSON.stringify(state)}`);
  });
  const geometry = () => page.evaluate(() => {
    const app = window.listFixture.app;
    const { shell, header, composer, list } = app.chatLayoutElements;
    return { owner: shell.dataset.scrollOwner, root: scrollY, scroll: list.scrollTop,
      scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, rows: list.querySelectorAll('.message').length,
      header: header.getBoundingClientRect().top, bottom: composer.getBoundingClientRect().bottom,
      opacity: Number(getComputedStyle(composer).opacity), gap: app.chatBottomGap(),
      pinned: app.chatPinnedToBottom, intent: app.chatScrollIntent,
      visible: !document.documentElement.classList.contains('privacy-obscured') };
  });

  await settled();
  await page.evaluate(() => {
    const app = window.listFixture.app;
    app.chatLayoutElements.list.dispatchEvent(new WheelEvent('wheel', { deltaY: -700, bubbles: true }));
    app.setChatScrollTop(app.chatScrollTop - 800);
  });
  await page.waitForTimeout(250);
  const anchor = await page.evaluate(() => window.listFixture.app.captureChatAnchor());
  await page.locator('#message-input').tap();
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 430 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await settled();
  const opened = await page.evaluate(() => window.listFixture.app.captureChatAnchor());
  assert.equal(opened.clientMsgId, anchor.clientMsgId);
  assert.ok(Math.abs(opened.offset-anchor.offset)<2, JSON.stringify({anchor,opened}));
  await page.evaluate(sourceId => {
    const app = window.listFixture.app;
    const source = [...app.messages.values()].find(message => message.clientMsgId === sourceId);
    source.payload = { ...source.payload, v: 2, replyTo: { clientMsgId: 'list-message-10', serverSeq: 10, senderId: 'list-peer', kind: 'text' } };
    app.renderMessages({ scroll: 'position' });
  }, opened.clientMsgId);
  await page.locator(`[data-client-msg-id="${opened.clientMsgId}"] .message-reply-quote`).click();
  const target = page.locator('[data-client-msg-id="list-message-10"]');
  await target.waitFor({ state: 'visible' });
  assert.equal(await target.evaluate(row => row.classList.contains('is-highlighted')), true);
  assert.equal(await page.locator('#chat-reply-return').count(), 0);
  const beforeFlash = await target.boundingBox();
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.evaluate(() => window.listFixture.app.jumpToReplyTarget('list-message-10', 10));
    const flash = await target.locator('.message-bubble').evaluate(bubble => {
      const overlay = getComputedStyle(bubble, '::after');
      return { content: overlay.content, inset: [overlay.top, overlay.right, overlay.bottom, overlay.left],
        opacity: Number(overlay.opacity), pointer: overlay.pointerEvents, background: overlay.backgroundColor };
    });
    assert.equal(flash.content, '""'); assert.deepEqual(flash.inset, ['0px', '0px', '0px', '0px']);
    assert.ok(flash.opacity > .2); assert.equal(flash.pointer, 'none');
    assert.notEqual(flash.background, 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: `/private/tmp/quiet-room-reply-flash-${colorScheme}.png` });
  }
  assert.deepEqual(await target.boundingBox(), beforeFlash, 'Whole-bubble flash must not change geometry');
  await page.evaluate(async () => {
    const app = window.listFixture.app;
    app.messages.set(181, { seq: 181, clientMsgId: 'own-reply-target', senderId: 'list-own',
      payload: { v: 1, kind: 'text', text: 'Outgoing reference target', sentAt: '2026-09-08T01:00:00.000Z' },
      acceptedAt: '2026-09-08T01:00:00.000Z', status: 'delivered' });
    app.renderMessages({ scroll: 'position' }); await app.jumpToReplyTarget('own-reply-target', 181);
  });
  const outgoingTarget = page.locator('[data-client-msg-id="own-reply-target"]');
  assert.equal(await outgoingTarget.evaluate(row => row.classList.contains('outgoing')), true);
  assert.equal(await outgoingTarget.locator('.message-bubble').evaluate(bubble => {
    const paint = getComputedStyle(bubble, '::after').backgroundColor;
    const reference = document.createElement('i'); reference.style.color = 'var(--on-accent)'; bubble.append(reference);
    const expected = getComputedStyle(reference).color; reference.remove(); return paint === expected;
  }), true, 'Outgoing bubbles need a light full fill over their accent surface');
  await page.screenshot({ path: '/private/tmp/quiet-room-reply-flash-outgoing.png' });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.listFixture.app.jumpToReplyTarget('list-message-10', 10));
  assert.equal(await target.locator('.message-bubble').evaluate(bubble => getComputedStyle(bubble, '::after').animationName), 'none');
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.message.is-highlighted').count(), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // An unavailable target retains the current position and explains the boundary.
  const reading = await page.evaluate(() => window.listFixture.app.chatScrollTop);
  await page.evaluate(() => window.listFixture.app.jumpToReplyTarget('not-on-this-device'));
  assert.equal(await page.evaluate(() => window.listFixture.app.chatScrollTop), reading);
  assert.match(await page.locator('#notice').textContent(), /未保存可读取的原消息/);
  // Same-text ABA editing is a different draft even if its string is equal.
  await page.evaluate(async()=>{
    const app=window.listFixture.app,input=document.querySelector('#message-input');
    const enqueue=app.enqueuePayload;let release;
    app.enqueuePayload=()=>new Promise(resolve=>release=resolve);
    const edit=text=>{input.value=text;input.dispatchEvent(new InputEvent('input',{bubbles:true}));};
    edit('相同的文字');const send=app.handleSendText(new Event('submit',{cancelable:true}));
    edit('新的草稿');edit('相同的文字');release();await send;
    if(input.value!=='相同的文字')throw Error('A later same-text draft was cleared by an earlier send');
    app.enqueuePayload=async()=>{throw Error('synthetic local storage failure');};
    await app.handleSendText(new Event('submit',{cancelable:true}));
    if(input.value!=='相同的文字')throw Error('Local failure discarded the draft');
    app.enqueuePayload=enqueue;
  });
  // Capture painted pixels, then issue another send before the first settles.
  await page.evaluate(async()=>{
    const app=window.listFixture.app;app.scrollChatToBottom();
    const append=i=>{
      app.pending.set(`continuity-${i}`,{seq:Number.MAX_SAFE_INTEGER,clientMsgId:`continuity-${i}`,senderId:'list-own',payload:{v:1,kind:'text',text:`连续发送 ${i}`,sentAt:`2026-09-28T12:00:0${i}.000Z`},acceptedAt:`2026-09-28T12:00:0${i}.000Z`,status:'pending'});
      app.renderMessages({scroll:'send'});
    };
    append(1);
    for(const a of app.chatMessageAnimations){a.pause();a.currentTime=60;}
    const target=document.querySelector('[data-client-msg-id="continuity-1"] .message-bubble');
    const before=target.getBoundingClientRect().top;append(2);
    for(const a of app.chatMessageAnimations){a.pause();a.currentTime=0;}
    if(Math.abs(target.getBoundingClientRect().top-before)>2)throw Error('Interrupted send exposed the destination frame');
    const input=document.querySelector('#message-input');const header=app.chatLayoutElements.header;
    const headerTop=header.getBoundingClientRect().top;
    for(const a of app.chatMessageAnimations)a.play();
    for(let i=0;i<3;i++){
      input.value='多行消息\n第二行\n第三行';input.dispatchEvent(new InputEvent('input',{bubbles:true}));
      await new Promise(requestAnimationFrame);
      input.value='';input.dispatchEvent(new InputEvent('input',{bubbles:true}));
      await new Promise(requestAnimationFrame);
      const composer=app.chatLayoutElements.composer;
      if(getComputedStyle(composer).opacity!=='1'||Math.abs(header.getBoundingClientRect().top-headerTop)>1)throw Error('Continuous typing hid or displaced chrome');
      if(composer.getBoundingClientRect().bottom>visualViewport.height+1)throw Error('Composer exceeded viewport bottom');
    }
  });
  await settled();
  await page.evaluate(()=>{
    const app=window.listFixture.app;app.chatPinnedToBottom=false;app.chatScrollIntent='up';app.setChatScrollTop(app.chatScrollTop-500);
    app.chatNewMessageIds.add('new-1');app.chatNewMessageIds.add('new-2');app.updateChatBottomControl();
  });
  assert.match(await page.locator('#chat-bottom-control').getAttribute('aria-label'),/2 条新消息/);
  await page.locator('#chat-bottom-control').click();await settled();
  assert.equal(await page.locator('.chat-new-count').isHidden(),true);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(async()=>{const app=window.listFixture.app;await app.jumpToReplyTarget('list-message-10',10);app.memeCache.view={kind:'gifs',favorite:false,positions:new Map(),shortcutLeft:0};app.lockNow();});
  assert.equal(await page.locator('.chat-shell').count(),0);
  assert.deepEqual(await page.evaluate(()=>{const a=window.listFixture.app;return[a.chatNewMessageIds.size,a.memeCache.view===undefined,a.chatMessageAnimations.size];}),[0,true,0]);
  assert.deepEqual(errors,[]);
  console.log('Chat continuity: history keyboard anchor, quote jump/whole-bubble flash/unavailable target, draft ABA/failure, interrupted sends, chrome geometry, new-message label and privacy cleanup passed (desktop WebKit emulation).');
} finally { await browser?.close(); await server.close(); }
