import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Use the real message/card listeners and attachment decryption. Only the
// opaque chunk service is replaced so touch gestures need no paired devices.
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
const visualQaDirectory = process.argv[2];
server.middlewares.use('/__file_interactions', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, acceptDownloads: true });
  const errors = [];
  let downloadCount = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', () => downloadCount++);
  await page.goto(`http://localhost:${server.httpServer.address().port}/__file_interactions`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/gallery.css');
    await import('/src/chat-interactions.css');
    // The always-mounted privacy curtain must use the production fixed/hidden
    // styles; an unstyled curtain changes document height and chat scroll offsets.
    await import('/src/cover.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault } = await import('/src/lib/vault.ts');
    const { encryptFileAttachment } = await import('/src/lib/file-crypto.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    const capabilities = ['image-album-v1', 'file-message-v1', 'reply-v2', 'message-reactions-v1'];
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities };
    const peer = { deviceId: crypto.randomUUID(), role: 'joiner', status: 'active', capabilities };
    const session = await createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'file-interactions-test', role: 'creator', protocol: 'legacy-v1', lastSeq: 3, members: [own, peer], identity: { publicBundle: own } }, 'file-interactions-passphrase', 'password');
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.mountChatImageObserver = () => {};
    app.mountGalleryThumbnails = () => {};
    app.flushUiPreferencesSave = () => {};
    app.unreadCounter.markRead = async () => {};
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    const chunks = new Map();
    const manifest = await encryptFileAttachment(new File(['file interaction exact bytes'], '文件操作回归.pdf', { type: 'application/pdf', lastModified: 1 }), {
      reserve: async () => {},
      status: async () => ({ uploadedIndexes: [], completed: false }),
      upload: async (_blobId, index, bytes) => { chunks.set(index, bytes); },
      complete: async () => {},
      savePlan: async () => {},
    });
    const requests = { reads: 0 };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const chunk = url.pathname.match(new RegExp(`/blobs/${manifest.blobId}/chunks/(\\d+)$`));
      if (!chunk) return realFetch(input, init);
      init.signal?.throwIfAborted();
      requests.reads++;
      return new Response(chunks.get(Number(chunk[1])));
    };
    const sentAt = '2026-09-04T10:00:00.000Z';
    const record = (seq, senderId, kind) => ({ seq, clientMsgId: crypto.randomUUID(), senderId, payload: { v: 1, kind, file: manifest, sentAt }, acceptedAt: sentAt, status: 'delivered' });
    const messages = [record(1, own.deviceId, 'file'), record(2, peer.deviceId, 'file')];
    const gallery = record(3, own.deviceId, 'gallery-file');
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch++;
    app.runtimeAbort = new AbortController();
    app.restoreChatAnchorOnNextRender = false;
    app.messages = new Map(messages.map(message => [message.seq, message]));
    app.pending = new Map([[gallery.clientMsgId, gallery]]);
    app.renderChat();
    window.fileInteractions = { app, root, requests, gallery };
  });

  assert.equal(await page.locator('.message').count(), 2, 'Gallery-only file appeared in chat');
  assert.deepEqual(await page.locator('.privacy-curtain').evaluate(element => {
    const style = getComputedStyle(element);
    return { position: style.position, visibility: style.visibility };
  }), { position: 'fixed', visibility: 'hidden' }, 'Fixture privacy curtain differs from the unlocked production layout');
  const results = { longPress: [], ordinaryTapDownloads: 0, galleryHasNoMessageMenu: false };
  for (const direction of ['outgoing', 'incoming']) {
    const card = page.locator(`.message.${direction} .file-attachment`);
    const readsBefore = await page.evaluate(() => window.fileInteractions.requests.reads);
    const downloadsBefore = downloadCount;
    await card.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', clientX: 120, clientY: 200 });
    await page.locator('.message-actions.is-visible .message-reaction-picker').waitFor({ timeout: 2000 });
    await card.evaluate(element => {
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch' }));
      // Browsers can synthesize a click after releasing a long press; it must
      // not start a download underneath the newly opened actions.
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => window.fileInteractions.requests.reads), readsBefore, `${direction}: long-press release fetched file bytes`);
    assert.equal(downloadCount, downloadsBefore, `${direction}: long-press release downloaded a file`);
    assert.equal(await page.locator('.message-actions [data-reaction]').count(), 6, `${direction}: file reaction controls are missing`);
    assert.equal(await page.locator('.message-actions [data-message-action="reply"]').count(), direction === 'incoming' ? 1 : 0, `${direction}: file reply action has the wrong ownership`);
    await page.waitForFunction(() => document.activeElement?.closest('.message-actions'));
    const menuBounds = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      actions: [...document.querySelectorAll('.message-action-list, .message-reaction-picker')].map(element => {
        const rect = element.getBoundingClientRect();
        return { className: element.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          inViewport: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1 };
      }),
    }));
    assert(menuBounds.actions.every(element => element.inViewport),
      `${direction}: file actions overflow the mobile viewport: ${JSON.stringify(menuBounds)}`);
    await page.evaluate(() => window.fileInteractions.app.closeMessageActions(true, false));
    await page.waitForFunction(() => document.activeElement?.classList.contains('message'));
    results.longPress.push({ direction, menuOpened: true, followingClickSuppressed: true, focusRestored: true });
  }

  await page.waitForFunction(() => Date.now() >= window.fileInteractions.app.suppressMediaClickUntil);
  const readsBeforeTap = await page.evaluate(() => window.fileInteractions.requests.reads);
  const downloaded = page.waitForEvent('download');
  await page.locator('.message.incoming .file-attachment').tap();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), '文件操作回归.pdf');
  const stream = await download.createReadStream();
  assert(stream, 'Normal tap produced no readable file');
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  assert.equal(Buffer.concat(parts).toString(), 'file interaction exact bytes');
  assert.equal(await page.evaluate(() => window.fileInteractions.requests.reads), readsBeforeTap + 1, 'Normal tap did not read exactly one encrypted chunk');
  results.ordinaryTapDownloads = 1;

  await page.evaluate(() => window.fileInteractions.app.renderGallery());
  assert.equal(await page.locator('#gallery-tab-images').getAttribute('aria-selected'), 'true', 'Gallery did not open on images');
  assert.equal(await page.locator('.gallery-file:visible').count(), 0, 'Gallery files appeared on the default images tab');
  await page.locator('#gallery-tab-files').tap();
  assert.equal(await page.locator('#gallery-tab-files').getAttribute('aria-selected'), 'true', 'Tapping the files tab did not select it');
  assert.equal(await page.locator('.gallery-tile:visible').count(), 0, 'Gallery images appeared on the files tab');
  const galleryCard = page.locator('.gallery-file');
  await galleryCard.waitFor();
  assert.equal(await page.locator('.message').count(), 0, 'Gallery file was rendered as a chat message');
  const readsBeforeGalleryHold = await page.evaluate(() => window.fileInteractions.requests.reads);
  await galleryCard.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', clientX: 120, clientY: 200 });
  await page.waitForTimeout(600);
  await galleryCard.dispatchEvent('pointerup', { button: 0, pointerType: 'touch' });
  assert.equal(await page.locator('.message-actions, .message-reaction-picker').count(), 0, 'Gallery-only file opened chat actions');
  assert.equal(await page.evaluate(() => window.fileInteractions.requests.reads), readsBeforeGalleryHold, 'Holding a gallery file fetched bytes before a click');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Gallery file overflows the mobile viewport');
  results.galleryHasNoMessageMenu = true;

  // Exercise concealment with both the verified cache and real asynchronous
  // image decryption. Presentation state must not alter the original bytes.
  await page.evaluate(async () => {
    const { app, gallery } = window.fileInteractions;
    const { QuietRoomApp } = await import('/src/app.ts');
    const { encryptImageFile } = await import('/src/lib/file-crypto.ts');
    app.mountGalleryThumbnails = QuietRoomApp.prototype.mountGalleryThumbnails.bind(app);
    const session = app.session;
    const records = [gallery];
    const chunks = new Map();
    const gate = { blobId: null, release: null, waiting: false };
    const previousFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const match = url.pathname.match(/\/blobs\/([^/]+)\/chunks\/(\d+)$/);
      const bytes = match && chunks.get(`${match[1]}:${match[2]}`);
      if (!bytes) return previousFetch(input, init);
      if (match[1] === gate.blobId) {
        gate.waiting = true;
        await new Promise(resolve => { gate.release = resolve; });
      }
      init.signal?.throwIfAborted();
      return new Response(bytes);
    };
    const addImage = async ({ cache = false, delayed = false } = {}) => {
      const number = records.length;
      const colors = ['#586d81', '#aa8064', '#718b7b', '#807791', '#8f685b', '#627d98'];
      const file = new File([`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${colors[(number - 1) % colors.length]}"/><circle cx="230" cy="64" r="33" fill="#ebe2c6"/><path d="M0 270 80 90 160 220 220 140 300 300H0" fill="#c4c9bb"/><path d="M0 300 50 220 150 280 210 210 300 290V300" fill="#354d53"/></svg>`], `保险箱图片-${number}.svg`, { type: 'image/svg+xml', lastModified: number });
      const manifest = await encryptImageFile(file, {
        reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
        upload: async (blobId, index, bytes) => { chunks.set(`${blobId}:${index}`, bytes); },
        complete: async () => {}, savePlan: async () => {},
      });
      const record = { ...gallery, seq: number + 3, clientMsgId: crypto.randomUUID(), payload: { v: 1, kind: 'gallery-image', image: manifest, sentAt: new Date(Date.parse(gallery.payload.sentAt) + number * 60_000).toISOString() } };
      records.push(record);
      if (cache) app.cacheLocalImage(manifest, file);
      if (delayed) { gate.blobId = manifest.blobId; gate.waiting = false; gate.release = null; }
      app.pending.set(record.clientMsgId, record);
      return manifest.blobId;
    };
    for (let number = 0; number < 6; number++) await addImage({ cache: number === 0 });
    window.galleryPrivacy = { app, records, gate, addImage, reopen: () => {
      app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
      app.pending = new Map(records.map(record => [record.clientMsgId, record]));
      app.renderGallery();
    } };
    app.renderGallery();
  });
  const assertVisibility = async (total, revealed, reason) => {
    await page.waitForFunction(({ total, revealed }) => {
      const tiles = [...document.querySelectorAll('.gallery-tile')];
      return tiles.length === total && tiles.filter(tile => tile.dataset.revealed === 'true').length === revealed;
    }, { total, revealed });
    const wrongFilters = await page.locator('.gallery-tile img').evaluateAll(images => images.filter(image => {
      const hidden = image.closest('.gallery-tile').dataset.revealed === 'false';
      return hidden ? !getComputedStyle(image).filter.includes('blur(') : getComputedStyle(image).filter !== 'none';
    }).length);
    assert.equal(wrongFilters, 0, `${reason}: rendered blur differs from explicit reveal state`);
    assert.equal(await page.locator('#gallery-toggle-visibility').getAttribute('aria-label'), total > 0 && total === revealed ? '隐藏全部' : '显示全部', `${reason}: bulk action label is incorrect`);
  };
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile img').length === 6);
  await assertVisibility(6, 0, 'Initial entry with cached images');
  assert.equal(await page.locator('.gallery-header > .gallery-tabs').count(), 1, 'Segmented tabs are not in the header row');
  assert.equal(await page.locator('.gallery-header h1, .gallery-title, .gallery-tile time').count(), 0, 'Safe retained the removed title or thumbnail timestamps');
  assert.equal((await page.locator('#gallery-toggle-visibility').textContent()).trim(), '', 'Safe visibility action still has visible text');
  assert.equal(await page.locator('#gallery-toggle-visibility > svg').count(), 1, 'Safe visibility action is missing its eye icon');
  assert.equal(await page.locator('.gallery-tile').first().evaluate(tile => getComputedStyle(tile, '::before').content), 'none', 'Safe thumbnail still renders a reveal hint');
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(), '6', 'Image tab did not count all loaded images');
  assert.equal(await page.locator('[data-gallery-count="files"]').textContent(), '1', 'Known file count was lost when switching to images');
  const firstTile = page.locator('.gallery-tile').first();
  await firstTile.tap();
  await assertVisibility(6, 1, 'First tap');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'First tap opened the viewer before revealing the thumbnail');
  await firstTile.tap();
  await page.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  const imageTimes = await page.evaluate(() => window.galleryPrivacy.records.filter(record => record.payload.kind === 'gallery-image').map(record => record.payload.sentAt));
  assert.equal(await page.locator('[data-viewer-time]').getAttribute('datetime'), imageTimes[0], 'Viewer did not show the selected image timestamp');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('[data-viewer-time]').getAttribute('datetime'), imageTimes[1], 'Viewer timestamp did not follow the current image index');
  await page.keyboard.press('ArrowLeft');
  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    await page.locator('.viewer-stage img').evaluate(async image => {
      await image.decode();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await page.screenshot({ path: path.join(visualQaDirectory, 'safe-viewer-time-390.png'), animations: 'disabled' });
  }
  await page.locator('[data-viewer-close]').tap();
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  await assertVisibility(6, 1, 'Viewer return');
  await page.locator('#gallery-tab-files').tap();
  assert.equal(await page.locator('#gallery-toggle-visibility').count(), 0, 'Image visibility action appeared on files');
  await page.locator('#gallery-tab-images').tap();
  await assertVisibility(6, 1, 'Tab roundtrip');
  await page.locator('#gallery-toggle-visibility').tap();
  await assertVisibility(6, 6, 'Show all');
  await page.evaluate(() => window.galleryPrivacy.app.renderGallery());
  await assertVisibility(6, 6, 'Same-visit refresh');
  await page.evaluate(async () => { const f = window.galleryPrivacy; await f.addImage({ delayed: true }); f.app.renderGallery(); });
  await page.waitForFunction(() => window.galleryPrivacy.gate.waiting);
  await assertVisibility(7, 6, 'New image after show all');
  await page.locator('#gallery-toggle-visibility').tap();
  await assertVisibility(7, 7, 'Show all while decoding');
  await page.locator('#gallery-toggle-visibility').tap();
  await page.evaluate(() => { const gate = window.galleryPrivacy.gate; gate.blobId = null; gate.release(); });
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile img').length === 7);
  await assertVisibility(7, 0, 'Hide all before delayed decode completes');
  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    const assertToolbarGeometry = async label => {
      const geometry = await page.evaluate(() => {
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
        return { tabs: rect(document.querySelector('.gallery-tabs')), buttons: [...document.querySelectorAll('.gallery-header button')].map(rect), overflow: document.documentElement.scrollWidth > innerWidth,
          labelsOverflow: [...document.querySelectorAll('.gallery-tab > span')].some(span => {
            const parent = span.parentElement.getBoundingClientRect(); const bounds = span.getBoundingClientRect();
            return bounds.left < parent.left || bounds.right > parent.right;
          }) };
      });
      assert.equal(geometry.tabs.height, 44, `${label}: segmented tabs do not match 44px controls`);
      assert(geometry.buttons.every(button => button.height === 44 && button.width >= 44 && Math.abs(button.y - geometry.tabs.y) < 1), `${label}: toolbar targets are undersized or not aligned`);
      assert(geometry.buttons.every((button, index) => index === 0 || button.x >= geometry.buttons[index - 1].right - 1), `${label}: toolbar buttons overlap`);
      assert(!geometry.overflow && !geometry.labelsOverflow, `${label}: toolbar text or viewport overflows`);
    };
    for (const width of [316, 320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await assertToolbarGeometry(`${width}px images`);
      await page.screenshot({ path: path.join(visualQaDirectory, `safe-hidden-${width}.png`), animations: 'disabled' });
      await page.locator('#gallery-tab-files').click();
      await assertToolbarGeometry(`${width}px files`);
      await page.screenshot({ path: path.join(visualQaDirectory, `safe-files-${width}.png`), animations: 'disabled' });
      await page.locator('#gallery-tab-images').click();
    }
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: 'dark' });
      await assertToolbarGeometry(`${width}px dark`);
      await page.screenshot({ path: path.join(visualQaDirectory, `safe-hidden-${width}-dark.png`), animations: 'disabled' });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 316, height: 844 });
    await page.evaluate(() => document.documentElement.style.fontSize = '125%');
    await assertToolbarGeometry('316px 125% font');
    await page.screenshot({ path: path.join(visualQaDirectory, 'safe-hidden-316-large-text.png'), animations: 'disabled' });
    await page.evaluate(() => {
      const f = window.galleryPrivacy;
      f.previousCounts = f.app.galleryKnownCounts;
      f.app.galleryKnownCounts = Object.fromEntries(['images', 'files'].map((kind, index) => {
        const keys = new Set(f.previousCounts[kind]?.keys);
        while (keys.size < (index ? 12345 : 9999)) keys.add(`previously-loaded-${kind}-${keys.size}`);
        return [kind, { keys, complete: false }];
      }));
      f.app.renderGallery();
    });
    await assertToolbarGeometry('316px 125% font and large prior counts');
    assert((await page.locator('#gallery-tab-images').getAttribute('aria-label')).includes('已加载 9999 张图片'), 'Compact count lost its precise accessible label');
    await page.screenshot({ path: path.join(visualQaDirectory, 'safe-counts-316-large-text.png'), animations: 'disabled' });
    await page.evaluate(() => { const f = window.galleryPrivacy; f.app.galleryKnownCounts = f.previousCounts; f.app.renderGallery(); });
    await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
    await page.setViewportSize({ width: 390, height: 844 });
    await firstTile.tap();
    await page.screenshot({ path: path.join(visualQaDirectory, 'safe-one-revealed-390.png'), animations: 'disabled' });
  }
  await page.locator('#gallery-toggle-visibility').tap();
  await page.locator('#gallery-back').tap();
  await page.locator('#open-gallery').tap();
  await assertVisibility(7, 0, 'Leave and reenter');
  await page.evaluate(async () => {
    const f = window.galleryPrivacy;
    await f.addImage({ delayed: true }); f.app.renderGallery();
    f.detachedTile = document.querySelector('.gallery-tile');
    f.detachedToggle = document.querySelector('#gallery-toggle-visibility');
  });
  await page.waitForFunction(() => window.galleryPrivacy.gate.waiting);
  await firstTile.tap();
  await page.evaluate(() => {
    const f = window.galleryPrivacy;
    f.app.lockNow(); f.detachedTile.click(); f.detachedToggle.click();
    f.gate.blobId = null; f.gate.release();
  });
  assert.equal(await page.evaluate(() => window.galleryPrivacy.app.galleryRevealedAssets.size), 0, 'Detached controls restored reveal state after locking');
  await page.waitForFunction(() => window.galleryPrivacy.app.imageLoadPromises.size === 0);
  assert.equal(await page.locator('.gallery-shell, .image-viewer').count(), 0, 'Delayed decrypt restored private content after locking');
  await page.evaluate(() => window.galleryPrivacy.reopen());
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile img').length === 8);
  await assertVisibility(8, 0, 'Unlock reentry');
  results.safePrivacy = { cachedImagesHidden: true, revealThenView: true, tabAndViewerStatePreserved: true, newImagesHidden: true, hideDuringDecode: true, leaveAndLockReset: true, staleControlsBlocked: true, countsRetained: true, viewerTimeFollowsIndex: true };

  await page.evaluate(() => window.fileInteractions.app.lockNow());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
