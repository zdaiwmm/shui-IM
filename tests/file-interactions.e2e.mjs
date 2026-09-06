import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
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
  const browserName = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  browser = browserName === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
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
    const manifest = await encryptFileAttachment(new File(['file interaction exact bytes'], '文件操作回归.txt', { type: 'text/plain', lastModified: 1 }), {
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
    assert.equal(await page.locator('.message-actions [data-message-action="reply"]').count(), 1, `${direction}: file reply action is missing`);
    const deleteAction = page.locator('.message-actions [data-message-action="delete"]');
    assert.equal(await deleteAction.count(), 1, `${direction}: file delete action is missing`);
    assert.equal(await deleteAction.getAttribute('data-danger'), 'true', `${direction}: delete action lost its danger treatment`);
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
    if (visualQaDirectory && direction === 'outgoing') {
      await mkdir(visualQaDirectory, { recursive: true });
      await deleteAction.tap();
      await page.locator('.message-actions.is-visible [data-message-action="delete-everyone"]').waitFor();
      await page.screenshot({ path: path.join(visualQaDirectory, 'message-delete-options-390.png'), animations: 'disabled' });
    }
    await page.evaluate(() => window.fileInteractions.app.closeMessageActions(true, false));
    await page.waitForFunction(() => document.activeElement?.classList.contains('message'));
    results.longPress.push({ direction, menuOpened: true, followingClickSuppressed: true, focusRestored: true });
  }

  // Reply must be reachable from a damped left swipe, without stealing a
  // vertical chat scroll or committing a short horizontal exploration.
  const swipeMessage = page.locator('.message.incoming');
  const swipeBounds = await swipeMessage.boundingBox();
  assert(swipeBounds, 'Incoming message has no bounds for the reply swipe');
  const swipeStart = { x: swipeBounds.x + swipeBounds.width - 22, y: swipeBounds.y + swipeBounds.height / 2 };
  const dispatchSwipe = async (pointerId, moves) => {
    await swipeMessage.dispatchEvent('pointerdown', {
      bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId, pointerType: 'touch',
      clientX: swipeStart.x, clientY: swipeStart.y,
    });
    for (const move of moves) {
      await swipeMessage.dispatchEvent('pointermove', {
        bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId, pointerType: 'touch',
        clientX: swipeStart.x - move.left, clientY: swipeStart.y + move.down,
      });
    }
    const last = moves.at(-1) ?? { left: 0, down: 0 };
    await swipeMessage.dispatchEvent('pointerup', {
      bubbles: true, button: 0, buttons: 0, isPrimary: true, pointerId, pointerType: 'touch',
      clientX: swipeStart.x - last.left, clientY: swipeStart.y + last.down,
    });
  };

  await dispatchSwipe(71, [{ left: 2, down: 20 }, { left: 5, down: 46 }]);
  assert.equal(await page.locator('#reply-draft').isHidden(), true, 'Vertical chat drag activated reply');
  assert.equal(await swipeMessage.evaluate(element => element.classList.contains('is-reply-swiping')), false,
    'Vertical chat drag entered horizontal reply visuals');

  await swipeMessage.dispatchEvent('pointerdown', {
    bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 72, pointerType: 'touch',
    clientX: swipeStart.x, clientY: swipeStart.y,
  });
  await swipeMessage.dispatchEvent('pointermove', {
    bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 72, pointerType: 'touch',
    clientX: swipeStart.x - 30, clientY: swipeStart.y + 1,
  });
  const shortSwipe = await swipeMessage.evaluate(element => ({
    offset: Number.parseFloat(element.style.getPropertyValue('--reply-swipe-offset')),
    swiping: element.classList.contains('is-reply-swiping'),
    armed: element.classList.contains('is-reply-armed'),
  }));
  assert(shortSwipe.swiping && !shortSwipe.armed && shortSwipe.offset === 30,
    `Short reply swipe stopped following the finger or armed early: ${JSON.stringify(shortSwipe)}`);
  await swipeMessage.dispatchEvent('pointerup', {
    bubbles: true, button: 0, buttons: 0, isPrimary: true, pointerId: 72, pointerType: 'touch',
    clientX: swipeStart.x - 30, clientY: swipeStart.y + 1,
  });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#reply-draft').isHidden(), true, 'Sub-threshold reply swipe committed');
  assert.equal(await swipeMessage.evaluate(element => element.classList.contains('is-reply-swiping')), false,
    'Sub-threshold reply swipe did not settle back to rest');

  await swipeMessage.dispatchEvent('pointerdown', {
    bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 73, pointerType: 'touch',
    clientX: swipeStart.x, clientY: swipeStart.y,
  });
  await swipeMessage.dispatchEvent('pointermove', {
    bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 73, pointerType: 'touch',
    clientX: swipeStart.x - 96, clientY: swipeStart.y + 2,
  });
  const armedSwipe = await swipeMessage.evaluate(element => ({
    offset: Number.parseFloat(element.style.getPropertyValue('--reply-swipe-offset')),
    armed: element.classList.contains('is-reply-armed'),
  }));
  assert(armedSwipe.armed && armedSwipe.offset === 96,
    `Armed reply swipe stopped following the finger: ${JSON.stringify(armedSwipe)}`);
  await swipeMessage.dispatchEvent('pointerup', {
    bubbles: true, button: 0, buttons: 0, isPrimary: true, pointerId: 73, pointerType: 'touch',
    clientX: swipeStart.x - 96, clientY: swipeStart.y + 2,
  });
  await page.locator('#reply-draft:not([hidden])').waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'message-input');
  const replyComposer = await page.locator('.composer-input-stack').evaluate(stack => {
    const draft = stack.querySelector('#reply-draft');
    const preview = draft?.querySelector('span');
    return {
      integrated: Boolean(draft && draft.parentElement === stack && stack.querySelector('.composer-field')),
      oneLine: preview ? getComputedStyle(preview).whiteSpace === 'nowrap' && preview.scrollHeight <= preview.getBoundingClientRect().height + 1 : false,
      withinStack: draft ? draft.getBoundingClientRect().left >= stack.getBoundingClientRect().left
        && draft.getBoundingClientRect().right <= stack.getBoundingClientRect().right + 1 : false,
    };
  });
  assert.deepEqual(replyComposer, { integrated: true, oneLine: true, withinStack: true },
    'Swipe reply composer is not an integrated, single-line layout');
  await page.locator('#reply-draft button[aria-label="取消回复"]').click();

  // Leaving the row or losing pointer capture while the finger is still down
  // must not settle the bubble. Safari can report both while a transformed
  // descendant crosses the row's original hit-test boundary.
  await swipeMessage.dispatchEvent('pointerdown', {
    bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 75, pointerType: 'touch',
    clientX: swipeStart.x, clientY: swipeStart.y,
  });
  await swipeMessage.dispatchEvent('pointermove', {
    bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 75, pointerType: 'touch',
    clientX: swipeStart.x - 120, clientY: swipeStart.y + 2,
  });
  await swipeMessage.dispatchEvent('pointerleave', {
    bubbles: false, button: 0, buttons: 1, isPrimary: true, pointerId: 75, pointerType: 'touch',
    clientX: swipeStart.x - 120, clientY: swipeStart.y + 2,
  });
  await swipeMessage.dispatchEvent('lostpointercapture', {
    bubbles: false, button: 0, buttons: 1, isPrimary: true, pointerId: 75, pointerType: 'touch',
    clientX: swipeStart.x - 120, clientY: swipeStart.y + 2,
  });
  const heldSwipe = await swipeMessage.evaluate(element => ({
    offset: Number.parseFloat(element.style.getPropertyValue('--reply-swipe-offset')),
    swiping: element.classList.contains('is-reply-swiping'),
    armed: element.classList.contains('is-reply-armed'),
  }));
  assert.deepEqual(heldSwipe, { offset: 120, swiping: true, armed: true },
    `Reply swipe settled before finger release: ${JSON.stringify(heldSwipe)}`);
  assert.equal(await page.locator('#reply-draft').isHidden(), true, 'Held reply swipe committed before pointerup');
  await page.locator('body').dispatchEvent('pointermove', {
    bubbles: true, button: 0, buttons: 1, isPrimary: true, pointerId: 75, pointerType: 'touch',
    clientX: swipeStart.x - 300, clientY: swipeStart.y + 3,
  });
  assert.equal(await swipeMessage.evaluate(element => Number.parseFloat(element.style.getPropertyValue('--reply-swipe-offset'))), 300,
    'Reply swipe stopped tracking after leaving the message row');
  assert.equal(await page.locator('#reply-draft').isHidden(), true, 'Continued held swipe committed before pointerup');
  await page.locator('body').dispatchEvent('pointerup', {
    bubbles: true, button: 0, buttons: 0, isPrimary: true, pointerId: 75, pointerType: 'touch',
    clientX: swipeStart.x - 300, clientY: swipeStart.y + 3,
  });
  await page.locator('#reply-draft:not([hidden])').waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'message-input');
  assert.equal(await page.locator('#reply-draft span').textContent(), '文件 · 文件操作回归.txt',
    'Pointerup did not expose the swiped message quote in the composer');
  await page.locator('#reply-draft button[aria-label="取消回复"]').click();

  // A horizontal bubble swipe keeps ownership when the keyboard is already
  // open; it must not require a first gesture to dismiss and a second gesture
  // to activate reply.
  await page.locator('#message-input').focus();
  await page.evaluate(() => { document.documentElement.dataset.keyboardOpen = 'true'; });
  await dispatchSwipe(74, [{ left: 96, down: 2 }]);
  await page.locator('#reply-draft:not([hidden])').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'message-input', 'Keyboard-open reply swipe blurred the composer');
  await page.locator('#reply-draft button[aria-label="取消回复"]').click();
  await page.evaluate(() => { delete document.documentElement.dataset.keyboardOpen; });
  results.replySwipe = { verticalScrollPreserved: true, shortSwipeCancelled: true, resistanceBounded: true,
    thresholdActivated: true, keyboardFocused: true, keyboardOpenGestureRetained: true, integratedSingleLineComposer: true,
    tracksOutsideRowUntilRelease: true, quoteRenderedAfterRelease: true };

  if (visualQaDirectory) {
    const incoming = page.locator('.message.incoming');
    await incoming.dispatchEvent('contextmenu', { button: 2, clientX: 120, clientY: 320 });
    await page.locator('.message-actions.is-visible [data-message-action="reply"]').tap();
    await page.locator('#reply-draft:not([hidden])').waitFor();
    await page.screenshot({ path: path.join(visualQaDirectory, 'reply-composer-390.png'), animations: 'disabled' });
    await page.locator('#reply-draft button[aria-label="取消回复"]').click();
  }

  await page.waitForFunction(() => Date.now() >= window.fileInteractions.app.suppressMediaClickUntil);
  const readsBeforeTap = await page.evaluate(() => window.fileInteractions.requests.reads);
  const opened = page.waitForEvent('popup');
  await page.locator('.message.incoming .file-attachment').tap();
  const reader = await opened;
  await reader.waitForURL('blob:**', { timeout: 5_000 });
  assert(reader.url().startsWith('blob:'), 'Normal tap did not hand the verified PDF to a system reader');
  await reader.close();
  assert.equal(await page.evaluate(() => window.fileInteractions.requests.reads), readsBeforeTap + 1, 'Normal tap did not read exactly one encrypted chunk');
  results.ordinaryTapSystemReader = 1;

  await page.evaluate(() => window.fileInteractions.app.renderGallery());
  assert.equal(await page.locator('#gallery-tab-images').getAttribute('aria-selected'), 'true', 'Gallery did not open on images');
  assert.equal(await page.locator('.gallery-file:visible').count(), 0, 'Gallery files appeared on the default images tab');
  await page.locator('#gallery-tab-files').tap();
  await page.locator('#gallery-grid[aria-labelledby="gallery-tab-files"]').waitFor();
  assert.equal(await page.locator('#gallery-tab-files').getAttribute('aria-selected'), 'true', 'Tapping the files tab did not select it');
  assert.equal(await page.locator('.gallery-tile:visible').count(), 0, 'Gallery images appeared on the files tab');
  const galleryCard = page.locator('.gallery-file');
  await galleryCard.waitFor();
  assert.equal(await page.locator('.message').count(), 0, 'Gallery file was rendered as a chat message');
  const readsBeforeGalleryHold = await page.evaluate(() => window.fileInteractions.requests.reads);
  await galleryCard.dispatchEvent('pointerdown', { button: 0, pointerId: 31, isPrimary: true, pointerType: 'touch', clientX: 120, clientY: 200 });
  await page.locator('.gallery-actions-sheet.is-visible').waitFor({ timeout: 2000 });
  await page.waitForFunction(() => Date.now() >= window.fileInteractions.app.suppressMediaClickUntil);
  await galleryCard.evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 31, isPrimary: true, pointerType: 'touch' }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.equal(await page.locator('.message-actions, .message-reaction-picker').count(), 0, 'Gallery-only file opened chat actions');
  assert.equal(await page.evaluate(() => window.fileInteractions.requests.reads), readsBeforeGalleryHold, 'Holding a gallery file fetched bytes before a click');
  assert.equal(await page.locator('.gallery-actions-menu [data-gallery-action]').count(), 2, 'Safe file actions are incomplete');
  assert.equal((await page.locator('.gallery-actions-menu [data-gallery-action="pin"] span').textContent()).trim(), '置顶', 'Safe file pin action has the wrong initial label');
  const galleryDelete = page.locator('.gallery-actions-menu [data-gallery-action="delete"]');
  assert.equal(await galleryDelete.getAttribute('data-danger'), 'true', 'Safe file delete action lost its danger treatment');
  assert.equal(await galleryDelete.evaluate(element => getComputedStyle(element).color), await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }), 'Safe file delete label and icon do not inherit the danger color');
  await page.locator('.gallery-actions-menu [data-gallery-action="pin"]').tap();
  await page.locator('.gallery-actions-sheet').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.fileInteractions.app.uiPreferences.galleryCuration?.some(record =>
    record.category === 'files' && record.clientMsgId === window.fileInteractions.gallery.clientMsgId && record.pinnedAt !== null));
  await galleryCard.dispatchEvent('pointerdown', { button: 0, pointerId: 32, isPrimary: true, pointerType: 'touch', clientX: 120, clientY: 200 });
  await page.locator('.gallery-actions-sheet.is-visible').waitFor({ timeout: 2000 });
  await galleryCard.dispatchEvent('pointerup', { button: 0, pointerId: 32, isPrimary: true, pointerType: 'touch' });
  assert.equal((await page.locator('.gallery-actions-menu [data-gallery-action="pin"] span').textContent()).trim(), '取消置顶', 'Pinned Safe file did not expose an unpin action');
  await page.locator('.gallery-actions-menu [data-gallery-action="pin"]').tap();
  await page.locator('.gallery-actions-sheet').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.fileInteractions.app.uiPreferences.galleryCuration?.some(record => record.category === 'files') ?? false), false, 'Unpin left a stale Safe file curation record');
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
    const addImage = async ({ cache = false, delayed = false, chat = false } = {}) => {
      const number = records.length;
      const colors = ['#586d81', '#aa8064', '#718b7b', '#807791', '#8f685b', '#627d98'];
      const file = new File([`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${colors[(number - 1) % colors.length]}"/><circle cx="230" cy="64" r="33" fill="#ebe2c6"/><path d="M0 270 80 90 160 220 220 140 300 300H0" fill="#c4c9bb"/><path d="M0 300 50 220 150 280 210 210 300 290V300" fill="#354d53"/></svg>`], `保险箱图片-${number}.svg`, { type: 'image/svg+xml', lastModified: number });
      const manifest = await encryptImageFile(file, {
        reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
        upload: async (blobId, index, bytes) => { chunks.set(`${blobId}:${index}`, bytes); },
        complete: async () => {}, savePlan: async () => {},
      });
      const sentAt = new Date(Date.parse(gallery.payload.sentAt) + number * 60_000).toISOString();
      const record = { ...gallery, seq: number + 3, clientMsgId: crypto.randomUUID(), acceptedAt: sentAt,
        payload: { v: 1, kind: chat ? 'image' : 'gallery-image', image: manifest, sentAt } };
      records.push(record);
      if (cache) app.cacheLocalImage(manifest, file);
      if (delayed) { gate.blobId = manifest.blobId; gate.waiting = false; gate.release = null; }
      app.pending.set(record.clientMsgId, record);
      return { blobId: manifest.blobId, clientMsgId: record.clientMsgId };
    };
    const chatImage = await addImage({ cache: true, chat: true });
    for (let number = 1; number < 6; number++) await addImage();
    app.renderChat();
    const chatOrderBefore = [...document.querySelectorAll('.message[data-client-msg-id]')].map(message => message.dataset.clientMsgId);
    window.galleryPrivacy = { app, records, gate, addImage, chatImageId: chatImage.clientMsgId, chatOrderBefore, reopen: () => {
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
  const baseSafeOrder = await page.locator('.gallery-tile').evaluateAll(tiles => tiles.map(tile => tile.dataset.galleryAssetKey));
  const chatSafeKey = `${await page.evaluate(() => window.galleryPrivacy.chatImageId)}:0`;
  assert.equal(baseSafeOrder.at(-1), chatSafeKey, 'Fixture chat image is not the ordinary oldest Safe asset');
  let safeHoldPointerId = 40;
  const openSafeImageActions = async (tile, { outlastClickWindow = false } = {}) => {
    const pointerId = safeHoldPointerId++;
    await tile.dispatchEvent('pointerdown', { button: 0, pointerId, isPrimary: true, pointerType: 'touch', clientX: 120, clientY: 440 });
    await page.locator('.gallery-actions-sheet.is-visible').waitFor({ timeout: 2000 });
    if (outlastClickWindow) await page.waitForFunction(() => Date.now() >= window.galleryPrivacy.app.suppressMediaClickUntil);
    await tile.evaluate((element, { pointerId, synthesizeClick }) => {
      element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId, isPrimary: true, pointerType: 'touch', clientX: 120, clientY: 440 }));
      if (synthesizeClick) element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, { pointerId, synthesizeClick: outlastClickWindow });
  };
  const longHeldImage = page.locator(`.gallery-tile[data-gallery-asset-key="${chatSafeKey}"]`);
  await openSafeImageActions(longHeldImage, { outlastClickWindow: true });
  assert.equal(await longHeldImage.getAttribute('data-revealed'), 'false', 'A long Safe hold revealed the image after the ordinary click-suppression window');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'A long Safe hold opened the image viewer behind its action sheet');
  assert.equal(await page.locator('.gallery-actions-menu [data-gallery-action]').count(), 2, 'Safe image actions are incomplete');
  assert.equal((await page.locator('.gallery-actions-menu [data-gallery-action="pin"] span').textContent()).trim(), '置顶', 'Unpinned Safe image has the wrong action label');
  assert.equal(await page.locator('.gallery-actions-menu [data-gallery-action="delete"]').getAttribute('data-danger'), 'true', 'Safe image delete action lost its danger treatment');
  await page.locator('.gallery-actions-menu [data-gallery-action="pin"]').tap();
  await page.waitForFunction(targetKey => document.querySelector('.gallery-tile')?.dataset.galleryAssetKey === targetKey, chatSafeKey);
  assert.equal(await page.locator('.gallery-tile').count(), 6, 'Pinning changed the Safe image count');
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(), '6', 'Pinning made the exact image count provisional');
  assert.equal(await page.evaluate(id => window.galleryPrivacy.app.uiPreferences.galleryCuration?.find(record =>
    record.category === 'images' && record.clientMsgId === id)?.pinnedAt != null, await page.evaluate(() => window.galleryPrivacy.chatImageId)), true,
  'Pinning did not persist an image-category curation record');

  await openSafeImageActions(page.locator('.gallery-tile').first());
  assert.equal((await page.locator('.gallery-actions-menu [data-gallery-action="pin"] span').textContent()).trim(), '取消置顶', 'Pinned Safe image did not expose an unpin action');
  await page.locator('.gallery-actions-menu [data-gallery-action="pin"]').tap();
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.gallery-tile')].map(tile => tile.dataset.galleryAssetKey)) === JSON.stringify(expected), baseSafeOrder);
  assert.equal(await page.evaluate(id => window.galleryPrivacy.app.uiPreferences.galleryCuration?.some(record =>
    record.category === 'images' && record.clientMsgId === id) ?? false, await page.evaluate(() => window.galleryPrivacy.chatImageId)), false,
  'Unpin did not restore ordinary Safe ordering or left stale curation state');

  await openSafeImageActions(page.locator(`.gallery-tile[data-gallery-asset-key="${chatSafeKey}"]`));
  await page.locator('.gallery-actions-menu [data-gallery-action="delete"]').tap();
  await page.waitForFunction(targetKey => {
    const tiles = [...document.querySelectorAll('.gallery-tile')];
    return tiles.length === 5 && tiles.every(tile => tile.dataset.galleryAssetKey !== targetKey);
  }, chatSafeKey);
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(), '5', 'Safe-local deletion did not update the exact image count');
  assert.equal(await page.evaluate(id => {
    const f = window.galleryPrivacy;
    const curation = f.app.uiPreferences.galleryCuration?.find(record => record.category === 'images' && record.clientMsgId === id);
    return Boolean(curation?.hidden && curation.pinnedAt === null && f.app.pending.get(id)?.payload.kind === 'image');
  }, await page.evaluate(() => window.galleryPrivacy.chatImageId)), true, 'Safe deletion mutated or removed the underlying chat message');
  await page.evaluate(() => window.galleryPrivacy.app.renderChat());
  await page.waitForFunction(id => document.querySelector(`.message[data-client-msg-id="${CSS.escape(id)}"]`), await page.evaluate(() => window.galleryPrivacy.chatImageId));
  assert.deepEqual(await page.locator('.message[data-client-msg-id]').evaluateAll(messages => messages.map(message => message.dataset.clientMsgId)),
    await page.evaluate(() => window.galleryPrivacy.chatOrderBefore), 'Safe-local deletion changed chat ordering');
  await page.evaluate(() => window.galleryPrivacy.app.renderGallery());
  await page.waitForFunction(targetKey => document.querySelectorAll('.gallery-tile').length === 5 &&
    ![...document.querySelectorAll('.gallery-tile')].some(tile => tile.dataset.galleryAssetKey === targetKey), chatSafeKey);
  await page.evaluate(() => {
    const f = window.galleryPrivacy;
    f.app.uiPreferences.galleryCuration = [];
    f.app.renderGallery();
  });
  await page.waitForFunction(targetKey => document.querySelectorAll('.gallery-tile').length === 6 &&
    [...document.querySelectorAll('.gallery-tile')].some(tile => tile.dataset.galleryAssetKey === targetKey), chatSafeKey);
  await assertVisibility(6, 0, 'Curation fixture reset');
  results.safeCuration = { longPressActions: true, pinAndUnpinOrdering: true, deleteIsLocalToSafe: true, chatOrderUnchanged: true, exactCountUpdated: true, viewerSurvivesQueuedRefresh: true };
  const safeTimeOrder = await page.locator('.gallery-tile').evaluateAll(tiles => {
    const byKey = new Map(window.galleryPrivacy.records
      .filter(record => record.payload.kind === 'image' || record.payload.kind === 'gallery-image')
      .map(record => [`${record.clientMsgId}:0`, record.payload.sentAt]));
    return tiles.map(tile => byKey.get(tile.dataset.galleryAssetKey));
  });
  await page.waitForFunction(() => Date.now() >= window.galleryPrivacy.app.suppressMediaClickUntil);
  const firstTile = page.locator('.gallery-tile').first();
  await firstTile.tap();
  await assertVisibility(6, 1, 'First tap');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'First tap opened the viewer before revealing the thumbnail');
  await firstTile.tap();
  await page.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  const viewerIdentity = await page.locator('.image-viewer').evaluate(viewer => {
    viewer.dataset.testIdentity = crypto.randomUUID();
    window.galleryPrivacy.app.renderGallery('images');
    return viewer.dataset.testIdentity;
  });
  assert.equal(await page.locator(`.image-viewer[data-test-identity="${viewerIdentity}"]`).count(), 1,
    'A queued Safe refresh dismantled the open viewer');
  assert.equal(await page.evaluate(() => window.galleryPrivacy.app.galleryRefreshPending), 'images',
    'An open viewer did not defer the underlying Safe refresh');
  assert.equal(await page.locator('[data-viewer-time]').getAttribute('datetime'), safeTimeOrder[0], 'Viewer did not show the selected image timestamp');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(expected => document.querySelector('[data-viewer-time]')?.getAttribute('datetime') === expected, safeTimeOrder[1]);
  assert.equal(await page.locator('[data-viewer-time]').getAttribute('datetime'), safeTimeOrder[1], 'Viewer timestamp did not follow the current image index');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(expected => document.querySelector('[data-viewer-time]')?.getAttribute('datetime') === expected, safeTimeOrder[0]);
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
  assert.equal(await page.evaluate(() => window.galleryPrivacy.app.galleryRefreshPending), null,
    'Closing the viewer did not apply its deferred Safe refresh');
  await assertVisibility(6, 1, 'Viewer return');
  await page.locator('#gallery-tab-files').tap();
  await page.locator('#gallery-grid[aria-labelledby="gallery-tab-files"]').waitFor();
  assert.equal(await page.locator('#gallery-toggle-visibility').count(), 0, 'Image visibility action appeared on files');
  await page.locator('#gallery-tab-images').tap();
  await page.locator('#gallery-grid[aria-labelledby="gallery-tab-images"]').waitFor();
  await assertVisibility(6, 1, 'Tab roundtrip');
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(), '6', 'Files-to-images tab switch added a provisional plus to the complete image count');
  assert.equal(await page.locator('[data-gallery-count="files"]').textContent(), '1', 'Files-to-images tab switch added a provisional plus to the complete file count');
  assert(!((await page.locator('.gallery-tabs').textContent()) ?? '').includes('+'), 'A stray plus appeared after switching from files to images');
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
          scrollX: window.scrollX,
          labelsOverflow: [...document.querySelectorAll('.gallery-tab > span')].some(span => {
            const parent = span.parentElement.getBoundingClientRect(); const bounds = span.getBoundingClientRect();
            return bounds.left < parent.left || bounds.right > parent.right;
          }) };
      });
      assert.equal(geometry.tabs.height, 44, `${label}: segmented tabs do not match 44px controls`);
      assert(geometry.buttons.every(button => button.height === 44 && button.width >= 44 && Math.abs(button.y - geometry.tabs.y) < 1), `${label}: toolbar targets are undersized or not aligned`);
      assert(geometry.buttons.every((button, index) => index === 0 || button.x >= geometry.buttons[index - 1].right - 1), `${label}: toolbar buttons overlap`);
      assert(geometry.tabs.x >= 0 && geometry.tabs.right <= page.viewportSize().width + 1
        && geometry.buttons.every(button => button.x >= 0 && button.right <= page.viewportSize().width + 1), `${label}: toolbar controls leave the viewport`);
      assert(!geometry.scrollX && !geometry.overflow && !geometry.labelsOverflow, `${label}: toolbar text or viewport overflows`);
    };
    for (const width of [316, 320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await assertToolbarGeometry(`${width}px images`);
      await page.screenshot({ path: path.join(visualQaDirectory, `safe-hidden-${width}.png`), animations: 'disabled' });
      await page.locator('#gallery-tab-files').click();
      await page.locator('#gallery-grid[aria-labelledby="gallery-tab-files"]').waitFor();
      await assertToolbarGeometry(`${width}px files`);
      await page.screenshot({ path: path.join(visualQaDirectory, `safe-files-${width}.png`), animations: 'disabled' });
      await page.locator('#gallery-tab-images').click();
      await page.locator('#gallery-grid[aria-labelledby="gallery-tab-images"]').waitFor();
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
    assert((await page.locator('#gallery-tab-images').getAttribute('aria-label')).includes('已加载 9999 项照片和视频'), 'Compact count lost its precise accessible label');
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
  console.log(JSON.stringify({ browser: process.env.QUIET_ROOM_TEST_BROWSER ?? 'chromium', ...results }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
