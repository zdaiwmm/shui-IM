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
    await import('/src/chat-interactions.css');
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
      const record = { seq: Number.MAX_SAFE_INTEGER - index, clientMsgId: crypto.randomUUID(), senderId: own.deviceId, payload: { v: 1, kind: 'gallery-image', image: manifest, sentAt }, acceptedAt: sentAt, status: 'delivered' };
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

  // Test entry before encrypted metadata can resolve, not only slow original downloads.
  await page.setViewportSize({ width:390, height:844 });
  await page.evaluate(async () => {
    const f = window.galleryLoading;
    const v = await import('/src/lib/vault.ts');
    f.v = v;
    f.app.uiPreferencesHydrated = true;
    f.saved = f.records.map((record, index) => ({ ...record, seq:index + 1, payload:{ ...record.payload, kind:'image' } }));
    f.app.pending.clear();
    for (const record of f.saved) await v.saveHistoryMessage(f.session, record);
    for (let seq=4; seq<=225; seq++) await v.saveHistoryMessage(f.session, {
      ...f.saved[0], seq, clientMsgId:crypto.randomUUID(), payload:{ v:1, kind:'text', text:'synthetic count gap', sentAt:f.saved[0].payload.sentAt }
    });
    await v.saveHistoryMessage(f.session, { ...f.saved[0], seq:226, clientMsgId:crypto.randomUUID(),
      payload:{ v:1, kind:'file', file:{ ...f.saved[0].payload.image, blobId:crypto.randomUUID(), originalName:'test.txt', mimeType:'text/plain' }, sentAt:f.saved[0].payload.sentAt } });
    f.app.messages = new Map(f.saved.map(record => [record.seq,record]));
    f.app.galleryKnownCounts = {};
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const gate = new Promise(resolve => { f.releaseHistory=resolve; });
    crypto.subtle.decrypt = async (...args) => {
      const aad = args[0]?.additionalData;
      if (aad && new TextDecoder().decode(aad).startsWith('quiet-room-history-v1:')) await gate;
      return decrypt(...args);
    };
    f.restoreDecrypt = () => { crypto.subtle.decrypt=decrypt; };
    f.app.renderGallery();
  });
  assert.equal(await page.locator('.gallery-initial-skeleton').count(), 12, 'Entry did not show skeletons while reading encrypted metadata');
  assert.equal(await page.locator('[data-gallery-count="files"]').isVisible(), true, 'Other tab has no entry count state');
  if (screenshotDirectory) await page.screenshot({ path:path.join(screenshotDirectory,'gallery-entry-skeleton-390.png') });
  await page.evaluate(() => { const f=window.galleryLoading; f.releaseHistory(); f.restoreDecrypt(); });
  await page.waitForFunction(() => document.querySelector('[data-gallery-count="images"]')?.textContent === '3' && document.querySelector('[data-gallery-count="files"]')?.textContent === '1');
  assert.equal(await page.locator('.gallery-initial-skeleton').count(), 0);
  assert.equal(await page.locator('.gallery-tile').count(), 3, 'Metadata pages appended incomplete thumbnail layouts');
  const independence = await page.evaluate(async () => {
    const f=window.galleryLoading;
    await f.app.deleteMessageForThisDevice(f.saved[0]);
    // Old-version records had no separate Safe row. Opening Safe migrates
    // that ciphertext without changing the authenticated source record.
    await new Promise((resolve,reject)=>{const opening=indexedDB.open('quiet-room');opening.onsuccess=()=>{
      const db=opening.result,tx=db.transaction('galleryHistory','readwrite');
      tx.objectStore('galleryHistory').delete(`${f.session.vault.roomId}:1`);
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
    };});
    await f.v.loadMediaHistoryPage(f.session,{beforeSeq:4});
    const migrated=await new Promise((resolve,reject)=>{const opening=indexedDB.open('quiet-room');opening.onsuccess=()=>{
      const db=opening.result,tx=db.transaction('galleryHistory','readonly'),req=tx.objectStore('galleryHistory').get(`${f.session.vault.roomId}:1`);
      tx.oncomplete=()=>{db.close();resolve(Boolean(req.result));};tx.onabort=()=>reject(tx.error);
    };});
    if(!migrated) throw Error('Legacy chat attachment did not gain an independent Safe record');
    const deleted={ ...f.saved[1], seq:227, clientMsgId:crypto.randomUUID(), payload:{v:1, kind:'message-delete', sentAt:f.saved[1].payload.sentAt,
      target:{clientMsgId:f.saved[1].clientMsgId,serverSeq:2,senderId:f.saved[1].senderId}} };
    await f.v.saveHistoryMessage(f.session,deleted);
    f.app.messageEventHistory.set(227,deleted);
    const chat=f.app.orderedMessages().map(message=>message.clientMsgId);
    f.app.renderGallery();
    return { chat, ids:f.saved.map(m=>m.clientMsgId) };
  });
  assert.deepEqual(independence.chat, [independence.ids[2]], 'Chat deletion no longer suppresses chat targets');
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile img').length===3);
  for (const id of independence.ids) assert.equal(await page.locator(`[data-gallery-asset-key="${id}:0"]`).count(),1,'Chat deletion removed a Safe copy');
  // Even removing one chat-store row cannot remove the independently persisted Safe record.
  const detached = await page.evaluate(async () => {
    const f=window.galleryLoading;
    await new Promise((resolve,reject)=>{const opening=indexedDB.open('quiet-room');opening.onsuccess=()=>{
      const db=opening.result,tx=db.transaction(['history','galleryHistory'],'readwrite');
      const req=tx.objectStore('galleryHistory').get(`${f.session.vault.roomId}:2`);
      req.onsuccess=()=>{if(!req.result)tx.abort();};
      tx.objectStore('history').delete(`${f.session.vault.roomId}:2`);
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(Error('Safe copy missing'));
    };});
    const result=await f.v.loadMediaHistoryPage(f.session,{beforeSeq:4});
    await f.v.saveHistoryMessage(f.session,f.saved[1]);
    return result.messages.some(m=>m.clientMsgId===f.saved[1].clientMsgId);
  });
  assert(detached, 'Safe still depends on the chat-store row');
  const deletedChatTile=page.locator(`[data-gallery-asset-key="${independence.ids[1]}:0"]`);
  await deletedChatTile.click(); await deletedChatTile.click();
  await page.locator('.viewer-stage img').waitFor();
  assert.equal(await page.evaluate(()=>window.galleryLoading.app.closeViewerIfProjectionDeleted()),false,'Safe viewer closed for a chat tombstone');
  await page.locator('[data-viewer-close]').click();
  await page.locator('.image-viewer').waitFor({state:'detached'});
  const keepChatTile=page.locator(`[data-gallery-asset-key="${independence.ids[2]}:0"]`);
  await keepChatTile.click(); await keepChatTile.click();
  await page.locator('.viewer-stage img').waitFor();
  await page.locator('[data-viewer-delete]').click();
  await page.locator('.media-delete-confirm:not([hidden])').waitFor();
  if (screenshotDirectory) await page.screenshot({path:path.join(screenshotDirectory,'safe-photo-delete-confirm-390.png'), animations:'disabled'});
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.image-viewer').count(),1);
  await page.locator('[data-viewer-delete]').click();
  await page.evaluate(()=>{const f=window.galleryLoading; f.savePreferences=f.app.saveUiPreferencesNow; f.app.saveUiPreferencesNow=async()=>{throw Error('synthetic write failure');};});
  await page.locator('[data-confirm-media-delete]').click();
  await page.locator('.media-delete-error:not([hidden])').waitFor();
  assert.equal(await page.evaluate(()=>window.galleryLoading.app.uiPreferences.galleryCuration?.some(item=>item.hidden)??false),false,'Failed deletion changed Safe preferences');
  await page.evaluate(()=>{const f=window.galleryLoading; f.app.saveUiPreferencesNow=f.savePreferences;});
  await page.locator('[data-confirm-media-delete]').click();
  await page.locator('.image-viewer').waitFor({state:'detached'});
  await page.waitForFunction(()=>document.querySelectorAll('.gallery-tile').length===2);
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(),'2');
  assert.equal(await page.evaluate(id=>window.galleryLoading.app.orderedMessages().some(m=>m.clientMsgId===id),independence.ids[2]),true,'Safe deletion removed chat');
  const durable=await page.evaluate(async()=>{const f=window.galleryLoading;const prefs=await f.v.loadUiPreferences(f.session);return prefs.galleryCuration?.some(item=>item.hidden&&item.clientMsgId===f.saved[2].clientMsgId);});
  assert(durable,'Safe deletion did not persist');

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
