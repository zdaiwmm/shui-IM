import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.env.MOTION_SOURCE_ROOT || process.cwd(), logLevel: 'error',
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
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const evidence = process.env.MOTION_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const page = await browser.newPage({ ...(evidence ? { recordVideo: { dir: evidence, size: { width: 393, height: 695 } } } : {}), viewport: { width: 393, height: 695 }, isMobile: true, hasTouch: true,
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
  await page.waitForTimeout(700);
  const result = await page.evaluate(async () => {
    const app = listFixture.app;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const frames = [], longTasks = [], shifts = [];
    const supported = PerformanceObserver.supportedEntryTypes;
    const observers = [];
    for (const [type, target] of [['longtask', longTasks], ['layout-shift', shifts]]) {
      if (!supported.includes(type)) continue;
      const observer = new PerformanceObserver(list => list.getEntries().forEach(entry => target.push({ at: entry.startTime, duration: entry.duration, value: entry.value })));
      observer.observe({ type }); observers.push(observer);
    }
    let sampling = true, previous = performance.now();
    const sample = now => { frames.push(now - previous); previous = now; if (sampling) requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    const sends = [];
    for (const [index, count] of [1, 12, 2].entries()) {
      const seq = 181 + index;
      app.messages.set(seq, { seq, clientMsgId: `motion-${seq}`, senderId: 'list-own',
        payload: { v: 1, kind: 'text', text: 'Motion sample '.repeat(count), sentAt: '2026-09-08T01:00:00.000Z' },
        acceptedAt: '2026-09-08T01:00:00.000Z', status: 'delivered' });
      app.renderMessages({ scroll: 'send' });
      sends.push({ count, durations: [...app.chatMessageAnimations].map(a => a.effect.getTiming().duration) });
      await pause(index === 1 ? 65 : 450);
    }
    await pause(450);
    const deleted = app.renderedMessages.get('motion-182').element;
    app.messages.delete(182);
    app.renderMessages({ scroll: 'preserve' });
    const removal = { immediate: !deleted.isConnected, motions: app.chatMessageAnimations.size };
    await pause(400);
    // No new history or protocol operations are involved in this visual fixture.
    const notice = app.root.querySelector('#notice');
    app.showNotice('Example status'); await pause(100);
    app.showNotice('Updated status');
    const repeatedNotice = notice?.classList.contains('is-visible') ?? false;
    app.closeSocket?.();
    const root = app.root;
    const render = name => { root.innerHTML = `<section class="${name}" style="width:100%;height:100%"><button class="icon-button">Test</button></section>`; };
    app.transitionPage('forward', () => render('device-shell'));
    await pause(65);
    const foreground = root.querySelector('.page-transition-incoming');
    const before = new DOMMatrixReadOnly(getComputedStyle(foreground).transform).m41;
    app.transitionPage('backward', () => render('gallery-shell'));
    const navigation = { before, duration: root.querySelector('.page-transition-incoming').getAnimations()[0]?.effect.getTiming().duration };
    await pause(450);
    const button = root.querySelector('button');
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 30, isPrimary: true, button: 0 }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 30, isPrimary: true, button: 0 }));
    await new Promise(requestAnimationFrame);
    const shortTap = Number.parseFloat(getComputedStyle(button).scale) || 1;
    await pause(250);
    const tapRest = Number.parseFloat(getComputedStyle(button).scale) || 1;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 31, isPrimary: true, button: 0 }));
    await pause(80);
    button.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerId: 31, relatedTarget: root }));
    await pause(220);
    const slideOutRest = Number.parseFloat(getComputedStyle(button).scale) || 1;
    button.disabled = true;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 32, isPrimary: true, button: 0 }));
    const disabledIgnored = !button.dataset.motionPressed;
    button.disabled = false;
    button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
    button.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
    await new Promise(requestAnimationFrame);
    const keyboardTap = Number.parseFloat(getComputedStyle(button).scale) || 1;
    await pause(220);
    const large = document.createElement('button'); large.textContent = 'Example action'; root.append(large);
    let activated = false; large.addEventListener('click', () => { activated = true; });
    large.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 33, isPrimary: true, button: 0 }));
    await pause(80);
    const largePressed = { opacity: Number(getComputedStyle(large).opacity), scale: getComputedStyle(large).scale };
    large.click();
    large.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 33 }));
    await pause(220);
    const controls = { slideOutRest, disabledIgnored, keyboardTap, largePressed, activated, cancelRest: Number(getComputedStyle(large).opacity) };
    sampling = false; observers.forEach(observer => observer.disconnect());
    app.runtimeAbort.abort();
    return { sends, removal, repeatedNotice, navigation, shortTap, tapRest, controls,
      performance: { frameIntervals: frames.slice(1), longTasks, shifts, supported } };
  });
  if (!process.env.MOTION_BASELINE) {
    assert.equal(result.removal.immediate, true);
    assert.ok(result.removal.motions > 0, 'Deletion should animate surviving neighbours');
    assert.equal(result.repeatedNotice, true);
    assert.ok(result.navigation.duration < 340, JSON.stringify(result.navigation));
    assert.ok(result.shortTap < 1, `Short tap lost feedback: ${result.shortTap}`);
    assert.equal(result.tapRest, 1);
    assert.equal(result.controls.slideOutRest, 1);
    assert.equal(result.controls.disabledIgnored, true);
    assert.ok(result.controls.keyboardTap < 1);
    assert.ok(result.controls.largePressed.opacity < 1);
    assert.ok(['none', '1'].includes(result.controls.largePressed.scale));
    assert.equal(result.controls.activated, true);
    assert.equal(result.controls.cancelRest, 1);
  }
  assert.deepEqual(errors, []);
  if (evidence) {
    await page.screenshot({ path: path.join(evidence, 'endpoint.png') });
    await writeFile(path.join(evidence, 'measurements.json'), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({ ...result, performance: { ...result.performance, frameIntervals: { count: result.performance.frameIntervals.length,
    max: Math.max(...result.performance.frameIntervals), over34: result.performance.frameIntervals.filter(value => value > 34).length } } }));
  await page.close();
} finally { await browser?.close(); await server.close(); }
