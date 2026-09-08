import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__presence', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><main id="app"></main></body></html>');
});
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__presence`);
  await page.evaluate(async () => {
    for (const name of ['styles', 'chat-layout', 'chat-interactions', 'cover']) await import(`/src/${name}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault } = await import('/src/lib/vault.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active' };
    const peer = { deviceId: crypto.randomUUID(), role: 'joiner', status: 'active' };
    app.session = await createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'presence-fixture', role: 'creator',
      protocol: 'legacy-v1', lastSeq: 0, members: [own, peer], identity: { publicBundle: own } }, 'presence-fixture-passphrase', 'password');
    app.privacyCovered = false;
    app.runtimeAbort = new AbortController();
    app.uiPreferencesHydrated = true;
    app.uiPreferences = { recoveryReminderDismissed: true };
    app.updateSafetyCode = async () => {};
    app.unreadCounter.markRead = async () => {};
    app.attemptSend = async () => {};
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    app.renderChat();
    window.fixture = { app };
  });
  const circuit = page.locator('.presence-circuit');
  const phase = () => circuit.getAttribute('data-phase');
  const state = (self, peer) => page.evaluate(([self, peer]) => {
    const { app } = window.fixture;
    app.connectionState = self === null ? 'connecting' : 'connected';
    app.rolePresence = self === null ? null : { creator: self, joiner: peer };
    app.updatePeerStatus();
  }, [self, peer]);
  assert.equal(await phase(), 'unknown');
  await state(true, false);
  assert.equal(await phase(), 'offline');
  await page.evaluate(async () => window.fixture.app.enqueuePayload({ v: 1, kind: 'text', text: 'Synthetic presence test', sentAt: new Date().toISOString() }));
  await page.waitForTimeout(150);
  assert.ok(await page.locator('[data-arc="left"]').getAttribute('d'));
  assert.equal(await page.locator('[data-arc="right"]').getAttribute('d'), null);
  assert.equal(await phase(), 'offline');
  await state(true, true);
  assert.equal(await phase(), 'charging');
  await page.waitForTimeout(150);
  assert.ok(await page.locator('[data-arc="right"]').getAttribute('d'), JSON.stringify(await page.evaluate(() => {
    const c = window.fixture.app.presenceCircuit;
    return { phase: document.querySelector('.presence-circuit').dataset.phase, self: c.self, peer: c.peer, mode: c.mode, frame: c.frame,
      connected: c.element.isConnected, hidden: document.hidden, surface: window.fixture.app.activeSurface };
  })));
  await page.waitForTimeout(1000);
  assert.equal(await phase(), 'fusing');
  await state(true, true);
  assert.equal(await phase(), 'fusing', 'identical snapshots must not replay charging');
  const moving = await page.locator('[data-half="left"]').getAttribute('transform');
  await page.waitForTimeout(170);
  assert.notEqual(await page.locator('[data-half="left"]').getAttribute('transform'), moving);
  await state(null, null);
  assert.equal(await phase(), 'unknown');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-arc="left"]').getAttribute('d'), null);
  await state(true, true);
  await page.waitForTimeout(4300);
  assert.equal(await phase(), 'online');
  assert.equal(await page.locator('.presence-heart').evaluate(e => getComputedStyle(e).animationName), 'presence-heartbeat');
  await state(false, true);
  assert.equal(await phase(), 'offline');
  await page.evaluate(() => window.fixture.app.presenceCircuit.sent());
  await page.waitForTimeout(100);
  assert.ok(await page.locator('[data-arc="left"]').getAttribute('d'));
  await page.waitForTimeout(1050);
  assert.notEqual(await page.locator('[data-half="left"]').getAttribute('transform'), 'translate(-2 0)');
  assert.equal(await page.locator('[data-half="right"]').getAttribute('transform'), 'translate(2 0)');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await state(true, true);
  assert.equal(await phase(), 'online');
  assert.equal(await page.locator('.presence-heart').evaluate(e => getComputedStyle(e).animationName), 'none');
  await state(true, false);
  await page.evaluate(() => window.fixture.app.presenceCircuit.sent());
  assert.equal(await page.locator('[data-arc="left"]').getAttribute('d'), null);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await state(true, true);
  await page.evaluate(() => window.fixture.app.setActiveSurface('away'));
  assert.equal(await phase(), 'unknown');
  assert.equal(await page.evaluate(() => window.fixture.app.presenceCircuit), null);
  await page.evaluate(() => window.fixture.app.renderChat());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await state(true, true);
  assert.equal(await phase(), 'online');
  const output = process.env.PRESENCE_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [320, 390, 820, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(60);
      const geometry = await page.evaluate(() => {
        const box = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width };
        };
        return { summary: box('.peer-summary'), heading: box('.presence-heading'), actions: box('.header-actions'),
          peer: box('#peer-presence'), dot: box('#peer-presence i'), label: box('#peer-presence span') };
      });
      assert.ok(geometry.summary.right <= geometry.actions.x, JSON.stringify(geometry));
      assert.ok(geometry.peer.right <= geometry.summary.right + 1, JSON.stringify(geometry));
      assert.ok(geometry.label.x > geometry.dot.right, JSON.stringify(geometry));
      if (output) await page.screenshot({ path: path.join(output, `presence-${colorScheme}-${width}.png`) });
    }
  }
  await page.evaluate(() => window.fixture.app.cleanupRuntime());
  assert.deepEqual(errors, []);
  console.log('Presence circuit: send, snapshots, fusion, cancellation, reduced motion, layout and themes passed.');
} finally {
  await browser?.close();
  await server.close();
}
