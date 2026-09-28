import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'motion-fixture', configureServer(vite) {
    vite.middlewares.use('/__motion', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__motion`);
  await page.evaluate(async () => {
    for (const css of ['styles', 'chat-layout', 'gallery', 'chat-interactions', 'voice-messages', 'call']) await import(`/src/${css}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    app.privacyCovered = false;
    const render = name => { root.innerHTML = `<section class="${name}" style="width:100%;height:100%"><button>${name}</button></section>`; };
    window.fixture = { root, app, render };
    render('device-shell');
  });
  // Reverse while the first push is still in flight: both new effects must
  // start from the pixels that were painted, with only one active route.
  const reverse = await page.evaluate(async () => {
    const { root, app, render } = fixture;
    app.transitionPage('forward', () => render('gallery-shell'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // Freeze only the test clock at an intermediate position. WebKit's
    // compositor can advance between two synchronous style reads otherwise.
    root.getAnimations({ subtree: true }).forEach(animation => animation.pause());
    await new Promise(requestAnimationFrame);
    const incoming = root.querySelector('.page-transition-incoming');
    const current = new DOMMatrixReadOnly(getComputedStyle(incoming).transform).m41;
    app.transitionPage('backward', () => render('device-shell'));
    const leaving = root.querySelector('.page-transition-outgoing');
    const from = leaving.getAnimations()[0].effect.getKeyframes()[0].transform;
    return { current, restarted: new DOMMatrixReadOnly(from).m41 };
  });
  assert.ok(Math.abs(reverse.current - reverse.restarted) < 2, JSON.stringify(reverse));
  await page.waitForFunction(() => !fixture.root.dataset.pageTransition);
  assert.equal(await page.locator('#app > section').count(), 1);
  assert.equal(await page.locator('.page-transition-outgoing').count(), 0);

  // Authenticated pages with a bottom Back action use the same push/pop.
  // Unauthenticated gateway replacement still retires old content immediately.
  for (const className of ['gateway save-entry-page', 'gateway authenticated-fixture']) {
    const entry = await page.evaluate(className => {
      const { root, app, render } = fixture;
      render('chat-shell');
      app.transitionPage('forward', () => { render(className); root.firstElementChild.dataset.authenticatedPage = ''; });
      return { direction: root.dataset.pageTransition, outgoing: root.querySelectorAll('.page-transition-outgoing').length };
    }, className);
    assert.deepEqual(entry, { direction: 'forward', outgoing: 1 });
    await page.waitForFunction(() => !fixture.root.dataset.pageTransition);
    assert.equal(await page.evaluate(() => { fixture.app.transitionPage('backward', () => fixture.render('chat-shell')); return fixture.root.dataset.pageTransition; }), 'backward');
    await page.waitForFunction(() => !fixture.root.dataset.pageTransition);
  }
  assert.equal(await page.evaluate(() => {
    fixture.app.transitionPage('forward', () => fixture.render('gateway'));
    return fixture.root.querySelectorAll('.page-transition-outgoing').length;
  }), 0);

  // Child transition controls dialog cleanup, not a guessed 320ms timer.
  await page.evaluate(async () => {
    const { mountDialog } = await import('/src/lib/dialog.ts');
    const root = fixture.root;
    root.innerHTML = '<button id="origin">Origin</button><section id="sheet"><button>Close</button></section>';
    document.querySelector('#origin').focus();
    const sheet = document.querySelector('#sheet');
    const dialog = mountDialog(sheet, { isActive: () => true });
    await new Promise(resolve => requestAnimationFrame(resolve));
    sheet.querySelector('button').animate([{ opacity: 1 }, { opacity: .5 }], { duration: 90 });
    dialog.close();
    window.dialogResult = { sheet, dialog, root };
  });
  await page.waitForFunction(() => !dialogResult.sheet.isConnected);
  assert.equal(await page.locator('#origin').evaluate(el => el.inert), false);
  assert.equal(await page.locator('#origin').evaluate(el => document.activeElement === el), true);

  await page.evaluate(async () => {
    const { mountDialog } = await import('/src/lib/dialog.ts');
    const { root } = fixture;
    const make = () => {
      const sheet = document.createElement('div'); sheet.className = 'space-invite-overlay';
      sheet.innerHTML = '<section class="space-invite-sheet"><button>Close</button></section>'; root.append(sheet);
      return { sheet, dialog: mountDialog(sheet, { isActive: () => true }) };
    };
    const old = make();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    old.dialog.close();
    const next = make();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (old.sheet.isConnected || !document.querySelector('#origin').inert) throw new Error('Reopen retained retiring content or released inert too early');
    const panel = next.sheet.firstElementChild;
    const arrivals = panel.getAnimations().filter(animation => animation.effect.getKeyframes().some(frame => frame.transform));
    if (!arrivals.length) throw new Error('Reopened panel has no arrival motion');
    for (const arrival of arrivals) {
      const endpoint = arrival.effect.getKeyframes().at(-1).transform;
      if (!endpoint || Math.abs(new DOMMatrixReadOnly(endpoint).m42) > .5) throw new Error(`Reopened panel must settle at its visible position: ${endpoint}`);
    }
    next.dialog.close();
    window.reopened = next.sheet;
  });
  await page.waitForFunction(() => !reopened.isConnected);
  assert.equal(await page.locator('#origin').evaluate(el => !el.inert && document.activeElement === el), true);

  const invite = await page.evaluate(async () => {
    const { mountSpaceInvite } = await import('/src/lib/space-drawer.ts');
    const abort = new AbortController();
    const sheet = mountSpaceInvite(fixture.root, { name: 'Example', content: '<p>Invitation</p>', signal: abort.signal, closed() {} });
    await new Promise(resolve => setTimeout(resolve, 350));
    const handle = sheet.querySelector('.space-invite-handle'), panel = sheet.querySelector('.space-invite-sheet');
    handle.setPointerCapture = () => {};
    const event = (type, y) => new PointerEvent(type, { pointerId: 8, pointerType: 'touch', isPrimary: true, button: 0, clientY: y });
    handle.dispatchEvent(event('pointerdown', 400)); handle.dispatchEvent(event('pointermove', 435));
    const offset = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
    handle.dispatchEvent(event('pointercancel', 435));
    await new Promise(resolve => setTimeout(resolve, 650));
    const rest = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
    const connected = sheet.isConnected; abort.abort();
    return { offset, rest, connected, removed: !sheet.isConnected };
  });
  assert.ok(invite.offset > 10 && invite.offset < 40, JSON.stringify(invite));
  assert.ok(Math.abs(invite.rest) < .5 && invite.connected && invite.removed, JSON.stringify(invite));

  const inviteRelease = await page.evaluate(async () => {
    const { mountSpaceInvite } = await import('/src/lib/space-drawer.ts');
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const exercise = async reverse => {
      const abort = new AbortController();
      const sheet = mountSpaceInvite(fixture.root, { name: 'Sample', content: '<p>Sample invite</p>', signal: abort.signal, closed() {} });
      await pause(350);
      const handle = sheet.querySelector('.space-invite-handle'); handle.setPointerCapture = () => {};
      const fire = (type, y) => handle.dispatchEvent(new PointerEvent(type, { pointerId: 20, isPrimary: true, button: 0, clientY: y }));
      fire('pointerdown', 400); await pause(20); fire('pointermove', reverse ? 510 : 430);
      if (reverse) { await pause(20); fire('pointermove', 480); }
      fire('pointerup', reverse ? 480 : 430);
      const closing = sheet.classList.contains('is-closing');
      await pause(650);
      const offset = sheet.isConnected ? new DOMMatrixReadOnly(getComputedStyle(sheet.firstElementChild).transform).m42 : 0;
      abort.abort(); return { closing, offset };
    };
    return { flick: await exercise(false), reversal: await exercise(true) };
  });
  assert.equal(inviteRelease.flick.closing, true);
  assert.equal(inviteRelease.reversal.closing, false);
  assert.ok(Math.abs(inviteRelease.reversal.offset) < .5);

  const swipe = await page.evaluate(async () => {
    const { bindReplySwipe } = await import('/src/lib/reply-swipe.ts');
    const target = document.createElement('div'); fixture.root.append(target);
    const states = [], commits = [];
    const binding = bindReplySwipe({ element: target, enabled: () => true, exclude: () => false,
      maxOffset: () => 65, move: (_, armed) => states.push(armed), settle: activated => commits.push(activated) });
    const event = (type, x) => new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: x, clientY: 100, cancelable: true });
    target.dispatchEvent(event('pointerdown', 300));
    for (const x of [202, 210, 222]) window.dispatchEvent(event('pointermove', x));
    window.dispatchEvent(event('pointercancel', 222));
    binding.destroy(); target.remove();
    return { states, commits };
  });
  assert.deepEqual(swipe, { states: [true, true, false], commits: [false] });

  const cancellation = await page.evaluate(async () => {
    const { settleValue } = await import('/src/lib/motion.ts');
    let paints = 0, completed = 0;
    const stop = settleValue(60, 100, () => paints++, () => completed++, () => true);
    stop();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { paints, completed };
  });
  assert.deepEqual(cancellation, { paints: 0, completed: 0 });

  // Real browser matrix sampling during zoom is covered separately from the
  // numeric gesture unit fixture, which has no compositor.
  const zoom = await page.evaluate(async () => {
    const { bindImageViewerGestures } = await import('/src/lib/image-viewer-gestures.ts');
    const viewer = document.createElement('div'), stage = document.createElement('div'), image = new Image();
    stage.style.cssText = 'width:300px;height:300px'; image.style.cssText = 'width:300px;height:300px';
    image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"/>';
    await image.decode(); stage.append(image); viewer.append(stage); fixture.root.replaceChildren(viewer);
    const binding = bindImageViewerGestures({ stage, viewer, itemCount: 1, dismiss() {}, page() {} });
    stage.dispatchEvent(new MouseEvent('dblclick', { clientX: 150, clientY: 150, cancelable: true }));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const before = new DOMMatrixReadOnly(getComputedStyle(image).transform).a;
    stage.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: 150, clientY: 150 }));
    const after = new DOMMatrixReadOnly(getComputedStyle(image).transform).a;
    binding.destroy(); viewer.remove();
    return { before, after };
  });
  assert.ok(Math.abs(zoom.before - zoom.after) < .08, JSON.stringify(zoom));

  await page.evaluate(() => {
    fixture.render('device-shell');
    fixture.app.transitionPage('forward', () => fixture.render('gallery-shell'));
  });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.waitForFunction(() => !fixture.root.dataset.pageTransition);
  const reduced = await page.evaluate(() => {
    fixture.render('device-shell');
    fixture.app.transitionPage('forward', () => fixture.render('gallery-shell'));
    return { outgoing: document.querySelectorAll('.page-transition-outgoing').length,
      canvas: getComputedStyle(document.body).backgroundColor, page: getComputedStyle(fixture.root.firstElementChild).backgroundColor };
  });
  assert.equal(reduced.outgoing, 0);
  assert.equal(reduced.canvas, reduced.page);
  assert.deepEqual(errors, []);
  console.log('Motion: navigation reversal, dialog completion/focus, swipe hysteresis/cancel, spring cancellation, interrupted zoom, reduced motion and dark canvas passed.');
} finally { await browser?.close(); await server.close(); }
