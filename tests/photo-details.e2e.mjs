import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { animatedGif, animatedWebp, animatedPng, staticPng, exifPrefix } from './fixtures/photo-fixtures.mjs';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__photo_details', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta id="system-chrome-color" name="theme-color" content="transparent"></head><body><div id="app"></div></body></html>');
});
const screenshotDirectory = process.argv[2];
let browser;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_PHOTO_BROWSER === 'webkit'
    ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__photo_details`);
  await page.evaluate(async fixture => {
    for (const sheet of ['styles', 'chat-layout', 'gallery', 'auth-recovery', 'chat-interactions', 'cover', 'voice-messages']) await import(`/src/${sheet}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const { mountSystemChrome } = await import('/src/lib/system-chrome.ts');
    mountSystemChrome();
    const vault = await import('/src/lib/vault.ts');
    const { encryptImageFile } = await import('/src/lib/file-crypto.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active' };
    const session = await vault.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'photo-fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'synthetic-photo-passphrase', 'password');
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.flushUiPreferencesSave = () => {};
    app.unreadCounter.markRead = async () => {};
    const chunks = new Map();
    const originals = new Map();
    const revoked = new Set();
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { revoked.add(url); revoke(url); };
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, options = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const match = url.pathname.match(/\/blobs\/([^/]+)\/chunks\/(\d+)$/);
      const bytes = match && chunks.get(`${match[1]}:${match[2]}`);
      if (!bytes) return realFetch(input, options);
      options.signal?.throwIfAborted();
      return Promise.resolve(new Response(bytes));
    };
    const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 240;
    const context = canvas.getContext('2d'); context.fillStyle = '#509173'; context.fillRect(0, 0, 360, 240);
    context.fillStyle = '#d9e5ec'; context.fillRect(0, 0, 360, 95);
    context.fillStyle = '#2a6159'; context.beginPath(); context.moveTo(0, 200); context.lineTo(140, 40); context.lineTo(360, 210); context.fill();
    const jpeg = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'))).arrayBuffer());
    const files = [
      new File([new Uint8Array(fixture.exif), jpeg.subarray(2)], 'fixture-camera.jpg', { type: 'image/jpeg', lastModified: 1700000000000 }),
      ...fixture.animated.map(item => new File([new Uint8Array(item.bytes)], item.name, { type: item.type })),
      new File([new Uint8Array(fixture.static)], 'static.png', { type: 'image/png' }),
    ];
    const records = [];
    for (const file of files) {
      const manifest = await encryptImageFile(file, {
        reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
        upload: async (id, part, bytes) => { chunks.set(`${id}:${part}`, bytes); },
        complete: async () => {}, savePlan: async () => {},
      });
      originals.set(manifest.blobId, file);
      const sentAt = '2026-09-08T01:30:00.000Z';
      const message = { seq: records.length + 1, clientMsgId: crypto.randomUUID(), senderId: own.deviceId,
        payload: { v: 1, kind: 'image', image: manifest, sentAt }, acceptedAt: sentAt, status: 'stored' };
      records.push(message); await vault.saveHistoryMessage(session, message);
    }
    app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
    app.messages = new Map(records.map(message => [message.seq, message]));
    const gallery = () => { app.closeImageViewer(true); app.renderGallery(); };
    const open = index => app.openImageViewer(records.map(m => m.payload.image), index, undefined,
      records.map(m => m.payload.sentAt), records.map(m => ({ clientMsgId: m.clientMsgId, assetIndex: 0, source: m })));
    window.photoFixture = { app, session, records, originals, revoked, gallery, open };
    gallery();
  }, { exif: [...exifPrefix], static: [...staticPng], animated: [
    { name: 'motion.gif', type: 'image/gif', bytes: [...animatedGif] },
    { name: 'motion.webp', type: 'image/webp', bytes: [...animatedWebp] },
    { name: 'motion.png', type: 'image/png', bytes: [...animatedPng] },
  ] });
  const settle = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // WebKit can retain an unresolved finished promise after reporting finished.
    await page.waitForFunction(() => document.getAnimations().every(animation =>
      animation.effect?.getComputedTiming().iterations === Infinity || (!animation.pending && animation.playState !== 'running')));
  };
  const ready = async () => { await page.waitForFunction(() => document.querySelector('.viewer-stage')?.getAttribute('aria-busy') === 'false'); await settle(); };
  const capture = async name => { if (screenshotDirectory) { await settle(); await mkdir(screenshotDirectory, { recursive: true }); await page.screenshot({ path: path.join(screenshotDirectory, `${name}.png`) }); } };
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile').length === 5);
  await page.evaluate(() => window.photoFixture.app.renderChat());
  await page.waitForSelector('.image-preview img', { state: 'attached' });
  const departure = await page.evaluate(async () => {
    document.querySelectorAll('.image-preview').forEach(button => { button.dataset.revealed = 'true'; });
    const app = window.photoFixture.app;
    app.transitionPage('forward', () => app.renderGallery());
    let frames = 0, media = 0, exposed = 0, metadata = 0, exposedMetadata = 0, shortFrames = 0;
    const start = performance.now();
    do {
      const images = [...document.querySelectorAll('.page-transition-outgoing .image-preview')];
      media = Math.max(media, images.length);
      exposed += images.filter(image => getComputedStyle(image).visibility !== 'hidden').length;
      const labels = [...document.querySelectorAll('.page-transition-outgoing .message-meta')];
      metadata = Math.max(metadata, labels.length);
      exposedMetadata += labels.filter(label => getComputedStyle(label).visibility !== 'hidden').length;
      const gallery = document.querySelector('#app > .gallery-shell');
      if (gallery && gallery.getBoundingClientRect().height < window.innerHeight - 1) shortFrames++;
      frames++;
      await new Promise(requestAnimationFrame);
    } while (performance.now() - start < 450);
    return { frames, media, exposed, metadata, exposedMetadata, shortFrames };
  });
  assert.ok(departure.frames > 2 && departure.media > 0, 'navigation must sample actual outgoing chat images');
  assert.equal(departure.exposed, 0, 'entering Safe must never repaint outgoing chat images');
  assert.ok(departure.metadata > 0, 'navigation must sample actual outgoing message timestamps and receipts');
  assert.equal(departure.exposedMetadata, 0, 'entering Safe must conceal outgoing message metadata too');
  assert.equal(departure.shortFrames, 0, 'the gallery must fill the viewport throughout navigation');
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile').length === 5);
  await page.emulateMedia({ colorScheme: 'light' });
  await capture('gallery-arrival-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  const cameraId = await page.evaluate(() => window.photoFixture.records[0].payload.image.blobId);
  const first = page.locator(`.gallery-tile[data-blob-id="${cameraId}"]`);
  await first.scrollIntoViewIfNeeded();
  await first.dispatchEvent('pointerdown', { isPrimary: true, button: 0, pointerType: 'touch', pointerId: 41, clientX: 30, clientY: 90 });
  await page.waitForSelector('[data-gallery-action="details"]');
  await first.dispatchEvent('pointerup', { isPrimary: true, button: 0, pointerType: 'touch', pointerId: 41 });
  await page.evaluate(() => {
    window.photoFocusTransfers = [];
    const remove = Element.prototype.remove;
    Element.prototype.remove = function () {
      if (this.classList.contains('gallery-actions-sheet')) window.photoFocusTransfers.push(Boolean(document.activeElement?.closest('.image-viewer')));
      return remove.call(this);
    };
  });
  await capture('gallery-menu-dark');
  await page.evaluate(() => { window.detailsTrigger = document.querySelector('[data-gallery-action="details"]'); });
  await page.locator('[data-gallery-action="details"]').click();
  await ready();
  assert.deepEqual(await page.evaluate(() => window.photoFocusTransfers), [true], 'focus must reach the viewer before its menu is removed');
  const lateDetails = await page.evaluate(() => {
    const viewer = document.querySelector('.image-viewer');
    const focus = document.activeElement;
    window.detailsTrigger.click();
    return { sameViewer: document.querySelector('.image-viewer') === viewer, sameFocus: document.activeElement === focus };
  });
  assert.deepEqual(lateDetails, { sameViewer: true, sameFocus: true }, 'A late details activation must not tear down the focused viewer');
  await first.dispatchEvent('contextmenu');
  assert.equal(await page.locator('.gallery-actions-sheet').count(), 0, 'late long-press contextmenu must not reopen above the viewer');
  assert.equal(await page.locator('.cover-trigger').count(), 0);
  assert.equal(await page.locator('#system-chrome-color').getAttribute('content'), 'transparent');
  assert.equal(await page.locator('[data-viewer-download]').count(), 0, 'Safe viewers must not offer downloads');
  assert.equal(await page.locator('[data-viewer-favorite]').count(), 0, 'Safe viewers must not offer favorites');
  await page.waitForFunction(() => document.querySelector('.photo-details')?.textContent.includes('Fixture Camera Test Model'));
  assert.match(await page.locator('.photo-details').innerText(), /2026年09月06日 16:28:35/);
  assert.equal(await page.locator('.photo-details b').count(), 0, 'EXIF text must not become HTML');
  assert.match(await page.locator('.photo-details').innerText(), /<b>Fixture only<\/b>/);
  assert.equal(await page.locator('[data-viewer-motion]').isVisible(), false, 'static JPEG has no animation control');
  assert.equal(await page.locator('.image-viewer').evaluate(viewer => getComputedStyle(viewer).touchAction), 'pan-y', 'the viewer must permit native detail scrolling');
  if (process.env.QUIET_ROOM_PHOTO_BROWSER !== 'webkit') {
    const touch = await page.context().newCDPSession(page);
    const bounds = await page.locator('.photo-details-content').boundingBox();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height - 24;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 30 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => document.querySelector('.photo-details-content').scrollTop > 40);
    await page.waitForTimeout(400);
    await page.locator('.photo-details-content').evaluate(content => { content.scrollTop = 0; });
    await touch.detach();
  }
  await capture('photo-details-dark');
  for (const [width, height, theme] of [[320, 700, 'light'], [390, 844, 'light'], [1280, 800, 'dark'], [844, 390, 'dark']]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: theme });
    await settle();
    assert.equal(await page.locator('#system-chrome-color').getAttribute('content'), 'transparent', 'viewer must not impose opaque native toolbar colors');
    assert.deepEqual(await page.locator('.image-viewer').evaluate(viewer => ({
      header: getComputedStyle(viewer.querySelector('.viewer-header')).backgroundImage,
      bottom: getComputedStyle(viewer, '::after').content,
    })), { header: 'none', bottom: 'none' }, 'viewer edges must not add tint bands over the photo');
    const geometry = await page.locator('.photo-details').evaluate(panel => {
      const bounds = panel.getBoundingClientRect();
      const content = panel.querySelector('.photo-details-content');
      return { left: bounds.left, right: bounds.right, bottom: bounds.bottom, scroll: content.scrollHeight > content.clientHeight, overflow: content.scrollWidth > content.clientWidth + 1 };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= width + 1 && geometry.bottom <= height + 1, JSON.stringify({ width, height, geometry }));
    assert.equal(geometry.overflow, false, 'long properties must wrap');
    await capture(`photo-details-${width}-${theme}`);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('[data-photo-details-close]').click();
  assert.equal(await page.locator('.photo-details.is-closing').count(), 1, 'ordinary dismissal must animate');
  await page.waitForSelector('.photo-details', { state: 'detached' });
  assert.equal(await page.locator('.photo-details').count(), 0);
  await capture('photo-viewer-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await capture('photo-viewer-light');
  await page.emulateMedia({ colorScheme: 'dark' });

  await page.locator('[data-viewer-details]').click(); await settle();
  const animation = await page.evaluate(async () => {
    const panel = document.querySelector('.photo-details');
    panel.querySelector('[data-photo-details-close]').click();
    const duration = parseFloat(getComputedStyle(panel).animationDuration);
    const offsets = [];
    while (panel.isConnected) {
      offsets.push(new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42);
      await new Promise(requestAnimationFrame);
    }
    return { duration, offsets };
  });
  assert.equal(animation.duration, 0.52);
  assert.ok(animation.offsets.length > 8 && animation.offsets.at(-1) > 200);
  assert.ok(animation.offsets.every((offset, index) => !index || offset >= animation.offsets[index - 1] - 1), 'dismissal must slide continuously downward');
  await page.locator('[data-viewer-details]').click(); await settle();
  const glass = await page.locator('.photo-details').evaluate(panel => ({
    filter: getComputedStyle(panel).backdropFilter || getComputedStyle(panel).webkitBackdropFilter,
    duration: getComputedStyle(panel).transitionDuration,
  }));
  assert.match(glass.filter, /blur\(/);
  assert.equal(glass.duration, '0.52s');
  assert.equal(await page.locator('.photo-details-content').evaluate(content => getComputedStyle(content).scrollbarWidth), 'none');
  await page.locator('.photo-details-backdrop').click({ position: { x: 15, y: 180 } });
  await page.waitForSelector('.photo-details', { state: 'detached' });
  assert.equal(await page.locator('.image-viewer').count(), 1, 'outside dismissal must keep the image viewer');
  await page.locator('[data-viewer-details]').click(); await settle();
  const expansionHeader = await page.locator('.photo-details > header').boundingBox();
  await page.mouse.move(expansionHeader.x + 80, expansionHeader.y + 20);
  await page.mouse.down(); await page.mouse.move(expansionHeader.x + 80, expansionHeader.y - 180, { steps: 14 }); await page.mouse.up();
  await settle();
  const expanded = await page.locator('.photo-details').evaluate(panel => {
    const bounds = panel.getBoundingClientRect(), parent = panel.parentElement.getBoundingClientRect();
    return { expanded: panel.classList.contains('is-expanded'), top: bounds.top - parent.top, height: bounds.height - parent.height };
  });
  assert.equal(expanded.expanded, true);
  assert.ok(Math.abs(expanded.top) < 1 && Math.abs(expanded.height) < 1, JSON.stringify(expanded));
  await page.locator('.photo-details-content').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('photo-details-handle')), true, 'fullscreen focus must stay in the sheet');
  await capture('photo-details-fullscreen-dark');
  await page.locator('[data-photo-details-close]').click();
  await page.waitForSelector('.photo-details', { state: 'detached' });
  await page.locator('[data-viewer-details]').click(); await settle();
  const handle = await page.locator('.photo-details > header').boundingBox();
  await page.mouse.move(handle.x + 80, handle.y + 20);
  await page.mouse.down(); await page.mouse.move(handle.x + 80, handle.y + 48, { steps: 5 }); await page.mouse.up();
  await settle();
  assert.equal(await page.locator('.photo-details:not(.is-closing)').count(), 1, 'short drag must return to the open position');
  assert.ok(Math.abs(await page.locator('.photo-details').evaluate(panel => new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42)) < 1);
  await page.mouse.move(handle.x + 80, handle.y + 20);
  await page.mouse.down(); await page.mouse.move(handle.x + 80, handle.y + 150, { steps: 12 }); await page.mouse.up();
  await page.waitForSelector('.photo-details', { state: 'detached' });
  await page.locator('[data-viewer-details]').click(); await settle();
  if (process.env.QUIET_ROOM_PHOTO_BROWSER !== 'webkit') {
    const touch = await page.context().newCDPSession(page);
    const header = await page.locator('.photo-details-content').boundingBox();
    const x = header.x + 80, y = header.y + 20;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + step * 18 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForSelector('.photo-details', { state: 'detached' });
    await page.locator('[data-viewer-details]').click(); await settle();
    const grip = await page.locator('.photo-details > header').boundingBox();
    const upX = grip.x + 80, upY = grip.y + 20;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: upX, y: upY }] });
    for (let step = 1; step <= 8; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: upX, y: upY - step * 20 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle();
    assert.equal(await page.locator('.photo-details.is-expanded').count(), 1, 'native upward touch expands to full screen');
    await page.locator('[data-photo-details-close]').click();
    await page.waitForSelector('.photo-details', { state: 'detached' });
    await touch.detach();
  } else {
    await page.locator('[data-photo-details-close]').click();
    await page.waitForSelector('.photo-details', { state: 'detached' });
  }
  await page.locator('[data-viewer-details]').click();
  await page.waitForTimeout(120);
  const interruption = await page.locator('.photo-details').evaluate(panel => {
    const before = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
    panel.querySelector('[data-photo-details-close]').click();
    return { before, after: new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42 };
  });
  assert.ok(Math.abs(interruption.before - interruption.after) < 2, 'closing during entry must start at its current position');
  await page.waitForSelector('.photo-details', { state: 'detached' });

  for (const index of [1, 2, 3]) {
    await page.evaluate(index => window.photoFixture.open(index), index);
    await ready();
    const toggle = page.locator('[data-viewer-motion]');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    const originalUrl = await page.locator('.viewer-media-layer img').getAttribute('src');
    // Browser screenshots must actually change while the image is playing.
    const sample = async () => {
      const bounds = await page.locator('.viewer-media-layer img').boundingBox();
      return (await page.screenshot({ clip: { x: bounds.x + bounds.width / 2 - 8, y: bounds.y + bounds.height / 2 - 8, width: 16, height: 16 }, animations: 'allow' })).toString('base64');
    };
    const frames = new Set();
    for (let sampleIndex = 0; sampleIndex < 6; sampleIndex++) { frames.add(await sample()); await page.waitForTimeout(100); }
    assert.ok(frames.size > 1, `animation ${index} must move in browser pixels`);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    const stillUrl = await page.locator('.viewer-media-layer img').getAttribute('src');
    assert.notEqual(stillUrl, originalUrl);
    await page.locator('.viewer-media-layer img').evaluate(image => image.decode());
    const stillFrames = new Set();
    for (let sampleIndex = 0; sampleIndex < 4; sampleIndex++) { stillFrames.add(await sample()); await page.waitForTimeout(100); }
    assert.equal(stillFrames.size, 1, 'paused pixels must remain static');
    if (index === 1) await capture('motion-paused-dark');
    await toggle.click();
    assert.equal(await page.locator('.viewer-media-layer img').getAttribute('src'), originalUrl);
    if (index === 1) await capture('motion-playing-dark');
    await page.evaluate(() => window.photoFixture.app.closeImageViewer(true));
    await page.waitForFunction(() => document.querySelector('#system-chrome-color').content === 'transparent');
    assert.equal(await page.evaluate(url => window.photoFixture.revoked.has(url), stillUrl), true, 'closing revokes the exact still frame URL through the native API');
  }

  await page.evaluate(() => { const { app } = window.photoFixture; app.closeImageViewer(true); app.renderChat(); window.photoFixture.open(1); });
  await ready();
  assert.equal(await page.locator('[data-viewer-details]').count(), 0, 'chat must never receive a photo properties entry');
  assert.equal(await page.locator('[data-viewer-download]').count(), 0, 'chat viewers must not offer downloads');
  assert.equal(await page.locator('[data-viewer-motion]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-viewer-motion]').click();
  await page.evaluate(() => window.photoFixture.open(1));
  await ready();
  assert.equal(await page.locator('[data-viewer-motion]').getAttribute('aria-pressed'), 'true', 'reopen restores autoplay');
  await page.keyboard.press('ArrowRight'); await ready();
  assert.equal(await page.locator('[data-viewer-motion]').getAttribute('aria-pressed'), 'true', 'paging to animation autoplays');

  await page.evaluate(() => { window.photoFixture.gallery(); window.photoFixture.open(4); }); await ready();
  assert.equal(await page.locator('[data-viewer-motion]').isVisible(), false);
  await page.locator('[data-viewer-details]').click();
  await page.waitForFunction(() => document.querySelector('.photo-details-content')?.textContent.includes('未记录'));
  await page.locator('[data-photo-details-close]').press('Escape');
  await page.waitForSelector('.photo-details', { state: 'detached' });
  assert.equal(await page.locator('.photo-details').count(), 0, 'Escape first closes properties');
  assert.equal(await page.locator('.image-viewer').count(), 1);

  // A delayed parser must not repaint after closing, reopening or privacy teardown.
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.pending = null; }
      postMessage(...args) { this.pending = setTimeout(() => { super.postMessage(...args); }, 300); }
      terminate() { clearTimeout(this.pending); super.terminate(); }
    };
  });
  await page.locator('[data-viewer-details]').click();
  await page.evaluate(() => window.photoFixture.app.closeImageViewer(true));
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.photo-details').count(), 0);
  await page.evaluate(() => window.photoFixture.open(1)); await ready();
  await page.locator('[data-viewer-motion]').click();
  const privacyStill = await page.locator('.viewer-media-layer img').getAttribute('src');
  await page.locator('[data-viewer-details]').click();
  await page.evaluate(() => window.photoFixture.app.lockNow());
  await page.waitForTimeout(350);
  assert.equal(await page.locator('.image-viewer, .photo-details').count(), 0);
  assert.equal(await page.evaluate(url => window.photoFixture.revoked.has(url), privacyStill), true);
  assert.deepEqual(errors, []);
  console.log('Photo details: Safe-only entry, real EXIF, theme/layout, GIF/WebP/APNG pixels, pause/resume, original bytes, paging and privacy cleanup passed.');
} finally { await browser?.close(); await server.close(); }
