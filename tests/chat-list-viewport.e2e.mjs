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
    app.uiPreferences = { recoveryReminderDismissed: true };
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
    return (!app.chatViewportMotion?.moving || composerPositioning) && !app.chatBottomControl?.scrolling
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
  let state = await geometry();
  assert.equal(state.owner, 'list');
  assert.equal(state.root, 0);
  assert.ok(state.scroll > 1000, JSON.stringify(state));
  assert.ok(state.gap <= 2, JSON.stringify(state));

  await page.evaluate(() => {
    const { app } = window.listFixture;
    const list = app.chatLayoutElements.list;
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    list.scrollTop -= 600;
  });
  await settled();
  await page.waitForTimeout(50);
  const history = await geometry();
  assert.equal(history.root, 0);
  assert.ok(history.scroll < state.scroll - 500, JSON.stringify(history));
  assert.equal(history.header, 0);

  await page.locator('#message-input').tap();
  assert.equal(await page.locator('#message-input').evaluate(input => input === document.activeElement), true);
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 319 });
    visualViewport.dispatchEvent(new Event('resize'));
    const app = window.listFixture.app;
    const motions = app.chatKeyboardSurfaceMotion.animations;
    if (motions.length !== 2) throw Error('Bottom messages must share the composer animation');
    for (const motion of motions) { motion.pause(); motion.currentTime = 80; }
    const bottom = app.chatLayoutElements.composer.getBoundingClientRect().bottom;
    if (!(bottom > 319 && bottom < 695) || app.chatBottomGap() > 2) throw Error('Opening lost shared message/composer geometry');
    if (app.chatLayoutElements.header.getBoundingClientRect().top !== 0) throw Error('Keyboard moved the header');
    for (const motion of motions) {
      motion.play();
      motion.startTime = app.listKeyboardLayout.transition.started;
    }
  });
  await settled();
  state = await geometry();
  assert.equal(state.root, 0);
  assert.equal(state.header, 0);
  assert.equal(state.bottom, 319);
  assert.equal(state.opacity, 1);
  assert.ok(state.visible && state.gap <= 2, JSON.stringify(state));
  assert.deepEqual(await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return [style.scrollPaddingTop, style.scrollPaddingBottom];
  }), ['0px', '0px']);
  const editingOrigin = await page.evaluate(() => {
    const app = window.listFixture.app;
    return [app.chatLayoutElements.composer.getBoundingClientRect().top,
      app.renderedMessageOrder.at(-1).getBoundingClientRect().bottom];
  });
  await page.locator('#message-input').pressSequentially('abc');
  await page.locator('#message-input').press('Backspace');
  await settled();
  assert.equal(await page.locator('#message-input').inputValue(), 'ab');
  state = await geometry();
  assert.equal(state.root, 0);
  assert.equal(state.header, 0);
  assert.deepEqual(await page.evaluate(() => {
    const app = window.listFixture.app;
    return [app.chatLayoutElements.composer.getBoundingClientRect().top,
      app.renderedMessageOrder.at(-1).getBoundingClientRect().bottom];
  }), editingOrigin);
  await page.locator('#message-input').fill('First line\nSecond line\nThird line');
  await settled();
  state = await geometry();
  assert.equal(state.bottom, 319);
  assert.equal(state.root, 0);
  assert.ok(state.gap <= 2, JSON.stringify(state));
  await page.evaluate(async () => {
    const input = document.querySelector('#message-input');
    const height = input.getBoundingClientRect().height;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = 'short';
    input.setSelectionRange(0, 5);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (input.getBoundingClientRect().height !== height) throw Error('Composition shrank between native editing frames');
    if (input.selectionStart !== 0 || input.selectionEnd !== 5) throw Error('Composition selection was modified');
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromComposition' }));
  });
  await settled();
  await page.waitForTimeout(50);
  assert.ok(await page.locator('#message-input').evaluate(input => input.getBoundingClientRect().height < 50));
  await page.locator('#message-input').fill('First line\nSecond line\nThird line\nFourth line\nFifth line\nSixth line');
  await settled();
  await page.locator('#message-input').evaluate(input => { input.scrollTop = input.scrollHeight; });
  const cappedInput = await page.locator('#message-input').evaluate(input => {
    const style = getComputedStyle(input);
    return { height: input.getBoundingClientRect().height, scroll: input.scrollTop,
      insets: [style.borderTopWidth, style.borderBottomWidth] };
  });
  assert.equal(cappedInput.height, 128);
  assert.ok(cappedInput.scroll > 0, JSON.stringify(cappedInput));
  assert.deepEqual(cappedInput.insets, ['10px', '10px']);
  state = await geometry();
  assert.ok(state.pinned && state.gap <= 2, JSON.stringify(state));

  if (process.argv[2]) {
    await mkdir(process.argv[2], { recursive: true });
    await page.screenshot({ path: path.join(process.argv[2], 'list-keyboard-open-393.png') });
  }
  await page.locator('#message-list').tap({ position: { x: 5, y: 130 } });
  await page.evaluate(() => {
    const app = window.listFixture.app;
    const motions = app.chatKeyboardSurfaceMotion.animations;
    if (motions.length !== 2) throw Error(`Dismissal lost the bottom reader: ${JSON.stringify({
      pinned: app.chatPinnedToBottom, intent: app.chatScrollIntent, resume: app.chatResumeBottomOnFocus,
      gap: app.chatBottomGap(), focused: document.activeElement?.id,
    })}`);
    for (const motion of motions) { motion.pause(); motion.currentTime = 80; }
    const bottom = app.chatLayoutElements.composer.getBoundingClientRect().bottom;
    if (!(bottom > 319 && bottom < 695) || app.chatBottomGap() > 2) throw Error('Closing waited for the late viewport');
    for (const motion of motions) {
      motion.play();
      motion.startTime = app.listKeyboardLayout.transition.started;
    }
  });
  await page.waitForTimeout(380);
  const beforeClosingReport = await page.evaluate(() => {
    const app = window.listFixture.app;
    return { row: app.renderedMessageOrder.at(-1).getBoundingClientRect().bottom,
      composer: app.chatLayoutElements.composer.getBoundingClientRect().top };
  });
  await page.evaluate(() => {
    delete visualViewport.height;
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await settled();
  state = await geometry();
  assert.equal(state.root, 0);
  assert.equal(state.header, 0);
  assert.equal(state.bottom, 695);
  assert.ok(state.gap <= 2, JSON.stringify(state));
  const afterClosingReport = await page.evaluate(() => {
    const app = window.listFixture.app;
    return { row: app.renderedMessageOrder.at(-1).getBoundingClientRect().bottom,
      composer: app.chatLayoutElements.composer.getBoundingClientRect().top };
  });
  assert.ok(Math.abs(afterClosingReport.row - beforeClosingReport.row) <= 1, JSON.stringify({ beforeClosingReport, afterClosingReport }));
  assert.ok(Math.abs(afterClosingReport.composer - beforeClosingReport.composer) <= 1, JSON.stringify({ beforeClosingReport, afterClosingReport }));

  await page.evaluate(() => {
    const { app } = window.listFixture;
    app.chatScrollIntent = 'up';
    app.chatPinnedToBottom = false;
    app.chatLayoutElements.list.scrollTop -= 700;
    window.listFixture.anchor = app.captureChatAnchor();
    app.chatLayoutElements.list.scrollTop -= 300;
    app.chatBottomFollowPending = true;
    app.chatPinnedToBottom = true;
    app.chatScrollIntent = null;
    app.chatRestoreAnchor = window.listFixture.anchor;
    app.restoreChatAnchor(app.chatLayoutElements.list, window.listFixture.anchor);
    app.chatRestoreAnchor = null;
    if (app.chatBottomFollowPending || app.chatPinnedToBottom) throw Error('A restored history anchor retained stale bottom follow');
    const gap = app.chatBottomGap;
    app.chatBottomGap = () => 0;
    app.commitChatScrollBookkeeping(app.chatLayoutElements.list, false);
    app.chatBottomGap = gap;
    if (app.chatPinnedToBottom) throw Error('Transient transition geometry replaced the restored history intent');
  });
  assert.equal(await page.evaluate(() => window.listFixture.app.captureChatAnchor().clientMsgId),
    await page.evaluate(() => window.listFixture.anchor.clientMsgId));
  await settled();
  await page.locator('#open-gallery').click();
  await page.locator('#gallery-back').waitFor({ state: 'visible' });
  await page.waitForTimeout(420);
  await page.locator('#gallery-back').click();
  await settled();
  await page.waitForTimeout(420);
  assert.equal(await page.evaluate(() => window.listFixture.app.captureChatAnchor().clientMsgId),
    await page.evaluate(() => window.listFixture.anchor.clientMsgId));
  await page.evaluate(() => window.listFixture.app.jumpToReplyTarget('list-message-90', 90));
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => scrollY), 0);
  const replyBounds = await page.locator('[data-client-msg-id="list-message-90"]').boundingBox();
  assert.ok(replyBounds.y >= 0 && replyBounds.y + replyBounds.height <= 695, JSON.stringify(replyBounds));
  await page.locator('#chat-bottom-control').click();
  await settled();
  state = await geometry();
  assert.ok(state.gap <= 2 && state.root === 0, JSON.stringify(state));

  for (const viewport of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(({ width, height }) => visualViewport.width === width && visualViewport.height === height
      && window.listFixture.app.chatLayoutElements.composer.getBoundingClientRect().bottom === height, viewport);
    await settled();
    state = await geometry();
    assert.equal(state.header, 0);
    assert.equal(state.bottom, viewport.height);
    assert.equal(state.root, 0);
    assert.ok(state.gap <= 2, JSON.stringify(state));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.argv[2]) await page.screenshot({ path: path.join(process.argv[2], `list-closed-${viewport.width}.png`) });
  }

  const holdRelease = await page.evaluate(() => {
    const input = document.querySelector('#message-input');
    input.value = '';
    input.blur();
    const point = { identifier: 1, target: input, clientX: 40, clientY: 340 };
    const start = new Event('touchstart', { bubbles: true });
    Object.defineProperty(start, 'touches', { value: [point] });
    input.dispatchEvent(start);
    const end = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(end, 'touches', { value: [] });
    input.dispatchEvent(end);
    return { focused: document.activeElement === input, root: scrollY };
  });
  assert.equal(holdRelease.focused, false, 'The keyboard touchend fallback must not steal an empty-input voice release');
  assert.equal(holdRelease.root, 0);

  const shortRelease = await page.evaluate(() => {
    const input = document.querySelector('#message-input');
    const owner = input.closest('.chat-shell');
    input.blur();
    const pointer = { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 91, isPrimary: true, button: 0, clientX: 40, clientY: 340 };
    input.dispatchEvent(new PointerEvent('pointerdown', pointer));
    input.dispatchEvent(new PointerEvent('pointerup', pointer));
    owner.dispatchEvent(new PointerEvent('lostpointercapture', pointer));
    const beforeTouchEnd = document.activeElement === input;
    const end = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperties(end, { touches: { value: [] }, changedTouches: { value: [{ clientX: 40, clientY: 340 }] } });
    input.dispatchEvent(end);
    return { beforeTouchEnd, focused: document.activeElement === input, prevented: end.defaultPrevented };
  });
  assert.deepEqual(shortRelease, { beforeTouchEnd: false, focused: true, prevented: true },
    'Empty-input typing must focus during touchend, surviving the preceding implicit pointer capture release');

  await page.evaluate(() => window.listFixture.app.lockNow());
  assert.equal(await page.locator('.chat-shell').count(), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).position), 'static');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ listOwnsScroll: true, historyAnchor: true, keyboardEndpoints: true,
    initialTypingAndDeletion: true, multilineInput: true, returnToLatest: true, galleryReturn: true, replyJump: true,
    responsiveViewports: true, privacyTeardown: true, physicalAnimation: 'requires device verification' }));
} finally {
  await browser?.close();
  await server.close();
}
