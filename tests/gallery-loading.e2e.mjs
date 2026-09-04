import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Exercise real original-byte encryption/decryption with delayed transport and
// decode gates, so loading, retry and privacy checks cannot pass on fast media.
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__gallery_loading', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});
const screenshotDirectory = process.argv[2];
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__gallery_loading`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/gallery.css');
    await import('/src/cover.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault } = await import('/src/lib/vault.ts');
    const { encryptImageFile } = await import('/src/lib/file-crypto.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active' };
    const session = await createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'gallery-loading-test', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'gallery-loading-passphrase', 'password');
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    app.flushUiPreferencesSave = () => {};
    const records = [];
    const chunks = new Map();
    const gates = new Map();
    const failed = new Set();
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const match = url.pathname.match(/\/blobs\/([^/]+)\/chunks\/(\d+)$/);
      const bytes = match && chunks.get(`${match[1]}:${match[2]}`);
      if (!bytes) return realFetch(input, init);
      if (failed.has(match[1])) throw new TypeError('Synthetic offline attachment');
      const gate = gates.get(match[1]);
      if (gate) { gate.waiting = true; await new Promise(resolve => { gate.release = resolve; }); }
      init.signal?.throwIfAborted();
      return new Response(bytes);
    };
    const addImage = async ({ cached = false, delayed = false, fail = false } = {}) => {
      const index = records.length + 1;
      const file = new File([`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="#74887c"/><circle cx="225" cy="90" r="52" fill="#d8cbb2"/><path d="M0 320 92 95 190 274 276 155 320 320" fill="#4b6665"/></svg>`], `加载状态-${index}.svg`, { type: 'image/svg+xml' });
      const manifest = await encryptImageFile(file, {
        reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
        upload: async (blobId, part, bytes) => { chunks.set(`${blobId}:${part}`, bytes); },
        complete: async () => {}, savePlan: async () => {},
      });
      const sentAt = `2026-09-04T10:0${index}:00.000Z`;
      const record = { clientMsgId: crypto.randomUUID(), senderId: own.deviceId, payload: { v: 1, kind: 'gallery-image', image: manifest, sentAt }, acceptedAt: sentAt, status: 'delivered' };
      records.push(record);
      if (cached) app.cacheLocalImage(manifest, file);
      if (delayed) gates.set(manifest.blobId, { waiting: false });
      if (fail) failed.add(manifest.blobId);
      app.pending.set(record.clientMsgId, record);
      return manifest.blobId;
    };
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch++;
    app.runtimeAbort = new AbortController();
    const slow = await addImage({ delayed: true });
    const cached = await addImage({ cached: true });
    const retry = await addImage({ fail: true });
    const decodeGate = { waiting: false, url: app.imageCache.get(cached).url };
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      if (this.src === decodeGate.url) { decodeGate.waiting = true; await new Promise(resolve => { decodeGate.release = resolve; }); }
      return decode.call(this);
    };
    const release = blobId => { const gate = gates.get(blobId); gates.delete(blobId); gate.release(); };
    window.galleryLoading = { app, session, records, gates, failed, slow, cached, retry, decodeGate, addImage, release };
    app.renderGallery();
  });
  await page.waitForFunction(() => window.galleryLoading.gates.get(window.galleryLoading.slow).waiting && window.galleryLoading.decodeGate.waiting && document.querySelectorAll('.gallery-tile[data-thumbnail-state="error"]').length === 1);
  const loading = page.locator('.gallery-tile[aria-busy="true"]');
  assert.equal(await loading.count(), 2, 'Transport and cached-image decode must both retain a loading state');
  assert.equal(await loading.locator('img, :scope > svg').count(), 0, 'Loading exposed an undecoded image or the former black SVG icon');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await loading.evaluateAll(tiles => tiles.map(tile => {
      const bounds = tile.getBoundingClientRect();
      const skeleton = tile.querySelector('.gallery-skeleton');
      const fill = skeleton.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height, fillWidth: fill.width, fillHeight: fill.height, animation: getComputedStyle(skeleton, '::after').animationName };
    }));
    assert(geometry.every(tile => tile.width > 0 && Math.abs(tile.width - tile.height) < 1 && Math.abs(tile.width - tile.fillWidth) < 1 && Math.abs(tile.height - tile.fillHeight) < 1), `${width}px skeleton does not fill its square thumbnail`);
    assert(geometry.every(tile => tile.animation === 'gallery-loading-glow'), `${width}px skeleton has no loading motion`);
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true });
      await loading.evaluateAll(tiles => tiles.forEach(tile => tile.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = 900; })));
      await page.screenshot({ path: path.join(screenshotDirectory, `gallery-loading-${width}-dark.png`) });
      await loading.evaluateAll(tiles => tiles.forEach(tile => tile.getAnimations({ subtree: true }).forEach(animation => animation.play())));
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert(await loading.locator('.gallery-skeleton').evaluateAll(elements => elements.every(element => getComputedStyle(element, '::after').animationName === 'none')), 'Reduced motion still animates the loading glow');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    const f = window.galleryLoading;
    f.release(f.slow);
    f.decodeGate.url = null;
    f.decodeGate.release();
  });
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile[data-thumbnail-state="loaded"] img').length === 2);
  assert.equal(await page.locator('.gallery-tile[data-thumbnail-state="loaded"] .gallery-skeleton').count(), 0, 'Skeleton was not removed after successful decoding');
  const retryId = await page.evaluate(() => window.galleryLoading.retry);
  const retryTile = page.locator(`.gallery-tile[data-blob-id="${retryId}"]`);
  assert.equal(await retryTile.locator('.tile-loading').textContent(), '载入失败，点按重试');
  assert.equal(await retryTile.locator('.gallery-skeleton').isVisible(), false, 'Failed tile still displays a loading glow');
  await page.evaluate(() => { const f = window.galleryLoading; f.failed.delete(f.retry); f.gates.set(f.retry, { waiting: false }); });
  await retryTile.click();
  await page.waitForFunction(() => window.galleryLoading.gates.get(window.galleryLoading.retry).waiting);
  assert.equal(await retryTile.getAttribute('aria-busy'), 'true');
  assert.equal(await retryTile.locator('.gallery-skeleton').isVisible(), true, 'Retry did not restore its skeleton');
  assert.equal(await retryTile.getAttribute('data-revealed'), 'false', 'Retry unexpectedly revealed the image');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'Retry unexpectedly opened the viewer');
  await page.evaluate(() => { const f = window.galleryLoading; f.release(f.retry); });
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile[data-thumbnail-state="loaded"] img').length === 3);
  assert(await page.locator('.gallery-tile img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0 && getComputedStyle(image).filter.includes('blur('))), 'Decoded images did not retain their default concealment');

  await page.evaluate(async () => { const f = window.galleryLoading; f.late = await f.addImage({ delayed: true }); f.app.renderGallery(); });
  await page.waitForFunction(() => window.galleryLoading.gates.get(window.galleryLoading.late).waiting);
  await page.evaluate(() => {
    const f = window.galleryLoading;
    f.detachedTile = document.querySelector(`.gallery-tile[data-blob-id="${f.late}"]`);
    f.app.lockNow();
    f.detachedTile.click();
    f.release(f.late);
  });
  await page.waitForFunction(() => window.galleryLoading.app.imageLoadPromises.size === 0);
  assert.equal(await page.locator('.gallery-shell, .image-viewer').count(), 0, 'Late transport restored private content after locking');
  assert.equal(await page.evaluate(() => window.galleryLoading.detachedTile.querySelectorAll('img').length), 0, 'Late transport hydrated a detached private thumbnail');
  assert.equal(await page.evaluate(() => window.galleryLoading.app.galleryRevealedAssets.size), 0, 'Detached retry changed reveal state after locking');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ loadingGlow: true, cachedDecodeWaits: true, responsiveWidths: [320, 390, 1280], reducedMotion: true, retry: true, decodedImagesConcealed: true, lateLoadAfterLockBlocked: true }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
