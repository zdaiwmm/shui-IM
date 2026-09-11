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
    const { generateIdentity, createJoinProof, bundleFingerprint } = await import('/src/lib/crypto.ts');
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const [identity, peerIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const pairingSecret = randomBase64Url(32);
    const own = { ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null };
    const peer = { ...peerIdentity.publicBundle, role: 'joiner', status: 'active', joinProof: await createJoinProof(pairingSecret, peerIdentity.publicBundle) };
    app.session = await createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'presence-fixture', role: 'creator',
      protocol: 'legacy-v1', lastSeq: 0, members: [own, peer], identity, pairingSecret, creatorFingerprint: await bundleFingerprint(identity.publicBundle) }, 'presence-fixture-passphrase', 'password');
    app.privacyCovered = false;
    app.runtimeAbort = new AbortController();
    app.uiPreferencesHydrated = true;
    app.uiPreferences = { recoveryReminderDismissed: true };
    app.updateSafetyCode = async () => {};
    app.unreadCounter.markRead = async () => {};
    app.attemptSend = async () => {};
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    app.renderChat();
    window.fixture = { app, peerVault: { ...app.session.vault, role: 'joiner', identity: peerIdentity } };
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
  // Idle double beat is visibly stronger without moving surrounding chrome.
  const beat = await page.locator('.presence-heart').evaluate(element => {
    const animation = element.getAnimations()[0];
    animation.pause(); animation.currentTime = 1650 * .12;
    return new DOMMatrix(getComputedStyle(element).transform).a;
  });
  assert.ok(beat >= 1.13, `Idle beat too subtle: ${beat}`);
  await page.locator('.presence-heart').evaluate(element => element.getAnimations()[0].play());
  await page.evaluate(async () => window.fixture.app.enqueuePayload({ v: 1, kind: 'text', text: 'Online local message', sentAt: new Date().toISOString() }));
  await page.waitForTimeout(100);
  assert.ok(await page.locator('[data-arc="left"]').getAttribute('d'));
  assert.equal(await page.locator('[data-arc="right"]').getAttribute('d'), null);
  await page.waitForTimeout(1020);
  assert.equal(await phase(), 'online-pulsing');
  assert.equal(await page.locator('.presence-whole').evaluate(e => getComputedStyle(e).display), 'block');
  assert.notEqual(await page.locator('.presence-heart').getAttribute('transform'), null);
  await page.waitForTimeout(550);
  assert.equal(await phase(), 'online');

  // Exercise the authenticated, persisted receive path, including replay exclusion.
  const receive = live => page.evaluate(async live => {
    const { app, peerVault } = window.fixture;
    const { encryptMessage } = await import('/src/lib/crypto.ts');
    const envelope = await encryptMessage(peerVault, { v: 1, kind: 'text', text: 'Synthetic peer message', sentAt: new Date().toISOString() });
    const message = { seq: app.session.vault.lastSeq + 1, envelope, acceptedAt: new Date().toISOString() };
    if (live) app.livePresenceMessages.add(message);
    app.serverQueue.set(message.seq, message);
    await app.drainServerQueue();
    return message.seq;
  }, live);
  await receive(false);
  assert.equal(await page.locator('[data-arc="right"]').getAttribute('d'), null, 'history sync must stay quiet');
  await receive(true);
  await page.waitForTimeout(100);
  assert.ok(await page.locator('[data-arc="right"]').getAttribute('d'));
  assert.equal(await page.locator('[data-arc="left"]').getAttribute('d'), null);
  await page.waitForTimeout(1020);
  assert.equal(await phase(), 'online-pulsing');
  await page.waitForTimeout(550);
  assert.equal(await phase(), 'online');
  assert.equal(await page.locator('.presence-heart').getAttribute('transform'), null);

  // A message during fusion must wait for the complete heart, then pulse once.
  await state(true, false);
  await state(true, true);
  await page.evaluate(() => window.fixture.app.presenceCircuit.received());
  assert.equal(await phase(), 'charging');
  await page.waitForTimeout(4350);
  assert.equal(await phase(), 'online');
  assert.ok(await page.locator('[data-arc="right"]').getAttribute('d'));
  await page.waitForTimeout(1000);
  assert.equal(await phase(), 'online-pulsing');
  await state(true, false);
  assert.equal(await phase(), 'offline');
  assert.equal(await page.locator('.presence-heart').getAttribute('transform'), null);
  await page.waitForTimeout(250);
  const offlineColor = await page.locator('.presence-heart').evaluate(element => getComputedStyle(element).fill);
  const idleAlpha = await circuit.evaluate(async element => {
    const copy = element.cloneNode(true);
    const original = [element, ...element.querySelectorAll('*')];
    const cloned = [copy, ...copy.querySelectorAll('*')];
    for (let i = 0; i < original.length; i++) {
      const computed = getComputedStyle(original[i]);
      for (const key of ['opacity', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'display']) cloned[i].style.setProperty(key, computed.getPropertyValue(key));
    }
    copy.setAttribute('width', '100'); copy.setAttribute('height', '24');
    const image = new Image(); image.src = `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(copy))}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 240;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1000, 240);
    const rgba = context.getImageData(0, 0, 1000, 240).data;
    let max = 0; for (let i = 3; i < rgba.length; i += 4) max = Math.max(max, rgba[i]);
    return max;
  });
  assert.ok(idleAlpha > 120 && idleAlpha <= 142, `Wire/heart overlap compounded opacity: ${idleAlpha}`);
  await page.evaluate(() => window.fixture.app.presenceCircuit.sent());
  await page.waitForTimeout(100);
  assert.ok(await page.locator('[data-arc="left"]').getAttribute('d'));
  await page.waitForTimeout(1050);
  assert.equal(await phase(), 'pulsing');
  assert.notEqual(await page.locator('.presence-heart').evaluate(element => getComputedStyle(element).fill), offlineColor);
  assert.notEqual(await page.locator('[data-half="left"]').getAttribute('transform'), 'translate(-2 0)');
  assert.equal(await page.locator('[data-half="right"]').getAttribute('transform'), 'translate(2 0)');
  await page.waitForTimeout(650);
  assert.equal(await phase(), 'offline');
  assert.equal(await page.locator('.presence-heart').evaluate(element => getComputedStyle(element).fill), offlineColor);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await state(true, true);
  assert.equal(await phase(), 'online');
  assert.equal(await page.locator('.presence-heart').evaluate(e => getComputedStyle(e).animationName), 'none');
  await state(true, false);
  await page.evaluate(() => window.fixture.app.presenceCircuit.sent());
  assert.equal(await page.locator('[data-arc="left"]').getAttribute('d'), null);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches);
  await state(true, true);
  await page.evaluate(() => window.fixture.app.setActiveSurface('away'));
  assert.equal(await phase(), 'unknown');
  assert.equal(await page.evaluate(() => window.fixture.app.presenceCircuit), null);
  await page.evaluate(() => window.fixture.app.renderChat());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await state(true, true);
  // The unchanged snapshot is deduplicated; WebKit's media-query event settles it.
  await page.waitForFunction(() => document.querySelector('.presence-circuit').dataset.phase === 'online', null, { timeout: 1000 });
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
