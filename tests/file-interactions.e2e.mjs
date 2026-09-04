import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Use the real message/card listeners and attachment decryption. Only the
// opaque chunk service is replaced so touch gestures need no paired devices.
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
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

  await page.evaluate(() => window.fileInteractions.app.lockNow());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
