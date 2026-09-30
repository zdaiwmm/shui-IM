import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'privacy-fixture', configureServer(vite) {
    vite.middlewares.use('/__privacy', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>');
    });
  } }] });
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__privacy`);
  await page.evaluate(async () => {
    for (const style of ['styles', 'cover', 'chat-layout', 'chat-interactions', 'voice-messages', 'call']) await import(`/src/${style}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault } = await import('/src/lib/vault.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: 'privacy-own', role: 'creator', status: 'active', capabilities: ['voice-message-v1'] };
    const session = await createVault({ v: 1, roomId: 'privacy-fixture', accessToken: 'fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'privacy-fixture-password', 'password');
    app.updateSafetyCode = async () => {}; app.updateBackgroundNotificationControl = async () => {};
    app.uiPreferencesHydrated = true; app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
    let focused = true;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    const focus = () => { focused = true; window.dispatchEvent(new Event('focus')); };
    const silentFocus = () => { focused = true; };
    const blur = () => { focused = false; window.dispatchEvent(new Event('blur')); };
    const fresh = () => {
      app.lockNow(); delete document.hidden; focus();
      app.session = session; app.privacyCovered = false; app.runtimeEpoch++;
      app.runtimeAbort = new AbortController(); app.renderChat(); app.resetIdleLock();
    };
    fresh(); window.fixture = { app, session, fresh, focus, silentFocus, blur };
  });
  await page.locator('#message-input').fill('合成草稿，保留选区');
  const retained = await page.evaluate(async () => {
    const { app, blur, focus } = window.fixture;
    app.clearKeyboardHandoff();
    const input = document.querySelector('#message-input'); input.setSelectionRange(2, 6);
    app.beginNativeHandoff('picker', 300000); blur(); blur();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const retained = !app.privacyCovered && document.activeElement === input
      && input.selectionStart === 2 && input.selectionEnd === 6 && input.value === '合成草稿，保留选区';
    focus();
    const focusStillCovered = document.documentElement.classList.contains('privacy-obscured');
    const invalidated = await app.finishNativeHandoff('picker');
    return { retained, focusStillCovered, invalidated, restored: !document.documentElement.classList.contains('privacy-obscured') };
  });
  assert.deepEqual(retained, { retained: true, focusStillCovered: false, invalidated: false, restored: true });
  assert.equal(await page.evaluate(async () => {
    const { app, fresh, blur, focus } = window.fixture; fresh();
    app.beginNativeHandoff('camera', 30000); blur();
    const result = app.finishNativeHandoff('camera');
    const covered = document.documentElement.classList.contains('privacy-obscured');
    focus();
    return !covered && !(await result) && !document.documentElement.classList.contains('privacy-obscured');
  }), true, 'Result-before-focus interrupted the visible foreground tool');
  assert.equal(await page.evaluate(async () => {
    const { app, fresh, blur, silentFocus } = window.fixture; fresh();
    let complete;
    const operation = app.withSystemSurface(() => new Promise(resolve => { complete = resolve; }));
    blur(); blur(); complete(); await operation;
    const held = document.documentElement.classList.contains('privacy-obscured');
    silentFocus(); await new Promise(resolve => setTimeout(resolve, 100));
    return !held && !app.privacyCovered && !document.documentElement.classList.contains('privacy-obscured');
  }), true, 'Silent actual focus after a completed system operation remained stuck');

  // No proactive flash, including rejected/cancelled APIs and overlapping
  // operations. An earlier completion cannot release a newer operation.
  for (const outcome of ['success', 'failure', 'overlap', 'stale', 'timeout']) {
    assert.equal(await page.evaluate(async outcome => {
      const { app, fresh, blur, focus } = window.fixture; fresh();
      let flashed = false;
      const observer = new MutationObserver(records => {
        flashed ||= records.some(record => record.oldValue?.includes('privacy-obscured'))
          || document.documentElement.classList.contains('privacy-obscured');
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
      let complete;
      const first = app.withSystemSurface(() => new Promise((resolve, reject) => { complete = outcome === 'failure' ? reject : resolve; }));
      const caught = first.then(() => false, () => true);
      const owner = app.systemSurfaceHandoff;
      blur(); blur();
      let second;
      if (outcome === 'overlap') {
        focus(); second = app.withSystemSurface(() => new Promise(resolve => { window.finishSecondTool = resolve; }));
        if (app.systemSurfaceHandoff !== owner) return false;
      }
      if (outcome === 'stale') { app.lockNow(); focus(); fresh(); }
      if (outcome === 'timeout') { owner.wallDeadline = Date.now() - 1; app.expireSystemSurfaceHandoff(owner); }
      complete(outcome === 'failure' ? new DOMException('Cancelled', 'AbortError') : 'done');
      const rejected = await caught;
      if (second) {
        if (!app.systemSurfaceHandoff || app.systemSurfaceTokens.size !== 1) return false;
        window.finishSecondTool(); await second;
      }
      focus(); await new Promise(resolve => requestAnimationFrame(resolve)); observer.disconnect();
      if (outcome === 'timeout') return rejected && app.privacyCovered && !app.session;
      if (outcome === 'stale') return rejected && app.session && !app.privacyCovered && !app.systemSurfaceHandoff;
      return !flashed && !app.privacyCovered && !app.systemSurfaceHandoff && !app.systemSurfaceTokens.size
        && rejected === (outcome === 'failure');
    }, outcome), true, `Foreground system ${outcome} broke its owner or flashed a curtain`);
  }

  // The unchanged circle has a larger hit region. Its lower miss area and
  // toolbar motion absorb real pointer clicks without blur or submission.
  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => {
      window.fixture.fresh(); window.sendCount = 0;
      window.fixture.app.handleSendText = event => { event.preventDefault(); window.sendCount++; };

    });
    await page.locator('#message-input').fill('发送区合成草稿');
    await page.waitForTimeout(260);
    await page.waitForFunction(() => !document.querySelector('#composer').hasAttribute('data-viewport-motion'));
    const points = await page.evaluate(() => {
      const send = document.querySelector('#send-text'), bounds = send.getBoundingClientRect();
      const composer = document.querySelector('#composer').getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const edge = { x, y: bounds.bottom + 3 };
      const blank = { x, y: composer.bottom - 2 };
      return { edge, blank, hit: document.elementFromPoint(edge.x, edge.y)?.closest('#send-text') === send,
        size: [bounds.width, bounds.height] };
    });
    assert.deepEqual(points.size, [34, 34]); assert.equal(points.hit, true, '44px hit region missing');
    await page.mouse.click(points.blank.x, points.blank.y);
    assert.equal(await page.evaluate(() => window.sendCount === 0 && document.activeElement?.id === 'message-input'
      && !document.documentElement.classList.contains('privacy-obscured')), true, `Lower composer miss blurred/submitted at ${width}`);
    await page.mouse.click(points.edge.x, points.edge.y);
    assert.equal(await page.evaluate(() => window.sendCount), 1, `Send edge missed at ${width}`);
    await page.evaluate(() => document.querySelector('#composer').dataset.viewportMotion = 'keyboard');
    await page.mouse.click(points.edge.x, points.edge.y);
    assert.equal(await page.evaluate(() => window.sendCount === 1 && document.activeElement?.id === 'message-input'), true,
      `Moving composer passed through a click at ${width}`);
    assert.equal(await page.evaluate(() => {
      const app = window.fixture.app;
      const input = document.querySelector('#image-input');
      input.addEventListener('click', event => event.preventDefault(), { capture: true, once: true });
      input.click();
      const owned = app.imagePickerInput === input && app.imagePickerActive && !!app.nativeHandoff;
      app.abandonImagePicker();
      return owned;
    }), true, `Moving composer intercepted native file activation at ${width}`);
    await page.evaluate(() => delete document.querySelector('#composer').dataset.viewportMotion);
  }

  for (const width of [320, 390, 1024]) {
    await page.setViewportSize({ width, height: width === 1024 ? 480 : 844 });
    assert.equal(await page.evaluate(() => {
      const { fresh, blur } = window.fixture; fresh(); blur();
      const call = document.createElement('section'); call.className = 'call-view'; call.style.visibility = 'visible';
      call.innerHTML = '<button style="visibility:visible">合成通话</button>'; document.body.append(call);
      const curtain = document.querySelector('.privacy-curtain');
      const points = [[1,1],[innerWidth-1,1],[1,innerHeight-1],[innerWidth-1,innerHeight-1],[innerWidth/2,innerHeight/2]];
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = getComputedStyle(curtain).backgroundColor; ctx.fillRect(0, 0, 1, 1);
      const opaque = ctx.getImageData(0, 0, 1, 1).data[3] === 255 && getComputedStyle(curtain).opacity === '1';
      const covered = points.every(([x,y]) => curtain.contains(document.elementFromPoint(x,y)));
      call.remove(); return opaque && covered;
    }), true, `Curtain missed an edge/body sibling at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { const f = window.fixture; f.fresh(); f.blur(); f.focus(); });
  assert.equal(await page.evaluate(() => !window.fixture.app.privacyCovered && document.documentElement.classList.contains('privacy-obscured')), true,
    'Unknown focus return exposed private content');
  const corner = page.locator('.privacy-curtain .privacy-continue');
  const bounds = await corner.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x + 30, bounds.y + 30); await page.mouse.down();
  await page.waitForFunction(() => !document.documentElement.classList.contains('privacy-obscured'));
  await page.mouse.up();
  assert.equal(await page.evaluate(() => Boolean(window.fixture.app.session) && !window.fixture.app.privacyCovered), true,
    'Existing continuation corner did not retain the original runtime');

  for (const departure of ['hidden', 'pagehide', 'freeze', 'expired-wall', 'expired-monotonic']) {
    assert.equal(await page.evaluate(departure => {
      const { app, fresh, blur, focus } = window.fixture; fresh(); app.beginNativeHandoff('camera', 30000); blur();
      if (departure === 'hidden') {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
      } else if (departure === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      else if (departure === 'freeze') document.dispatchEvent(new Event('freeze'));
      else {
        if (departure === 'expired-wall') app.nativeHandoff.wallDeadline = Date.now() - 1;
        else app.nativeHandoff.deadline = performance.now() - 1;
        focus();
      }
      const locked = app.privacyCovered && !app.session && !document.querySelector('.chat-shell, .call-view:not([hidden])');
      delete document.hidden; focus();
      return locked && app.privacyCovered && !app.session;
    }, departure), true, `Late foreground revived ${departure}`);
  }
  await page.evaluate(() => window.fixture.fresh());
  await page.evaluate(() => { const app = window.fixture.app; app.idleDeadline = Date.now() + 5000; app.idleMonotonicDeadline = performance.now() + 5000; });
  await page.locator('#message-input').fill('真实输入');
  const activity = await page.evaluate(() => {
    const app = window.fixture.app;
    const renewed = app.idleDeadline > Date.now() + 590000;
    app.idleDeadline = Date.now() + 5000; app.idleMonotonicDeadline = performance.now() + 5000;
    window.scrollTo(0, 0); document.dispatchEvent(new Event('scroll')); document.dispatchEvent(new Event('input'));
    return { renewed, syntheticDidNotRenew: app.idleDeadline < Date.now() + 6000 };
  });
  assert.deepEqual(activity, { renewed: true, syntheticDidNotRenew: true });
  await page.evaluate(() => { const app = window.fixture.app; app.idleDeadline = Date.now() - 1; });
  await page.locator('#message-input').press('a');
  assert.equal(await page.evaluate(() => window.fixture.app.privacyCovered), true, 'First input renewed an expired session');
  assert.deepEqual(errors, []);
  console.log('H5 privacy surface: retained editor, repeated owned blur, both settlement orders, opaque edges, explicit continuation, hard departure/clock expiry, trusted input passed');
} finally { await browser?.close(); await server.close(); }
