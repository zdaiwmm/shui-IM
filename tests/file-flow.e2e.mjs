import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Exercise the real picker, attachment crypto and UI against an opaque in-memory
// blob service. Message transport is captured at enqueuePayload; MLS coverage
// belongs to the protocol tests and the full two-device browser suite.
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
const visualQaDirectory = process.argv[2];
server.middlewares.use('/__file_flow', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const errors = [];
  const downloads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => downloads.push(download.suggestedFilename()));
  const captureFiles = async surface => {
    if (!visualQaDirectory) return;
    await mkdir(visualQaDirectory, { recursive: true });
    await page.emulateMedia({ colorScheme: 'light' });
    for (const [width, height] of [[320, 760], [390, 844], [1280, 900]]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: path.join(visualQaDirectory, `${surface}-${width}.png`), fullPage: true, animations: 'disabled' });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${surface} overflows ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(visualQaDirectory, `${surface}-390-dark.png`), fullPage: true, animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
  };
  await page.goto(`http://localhost:${server.httpServer.address().port}/__file_flow`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/gallery.css');
    await import('/src/auth-recovery.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    await import('/src/voice-messages.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities: ['image-album-v1', 'file-message-v1'] };
    const session = await vault.createVault({
      v: 1, roomId: crypto.randomUUID(), accessToken: 'file-flow-test', role: 'creator', protocol: 'legacy-v1',
      lastSeq: 0, members: [own], identity: { publicBundle: own },
    }, 'file-flow-passphrase', 'password');
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.mountChatImageObserver = () => {};
    app.mountGalleryThumbnails = () => {};
    app.flushUiPreferencesSave = () => {};
    app.unreadCounter.markRead = async () => {};
    let focused = true;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    const check = (value, message) => { if (!value) throw Error(message); };
    const sent = [];
    const blobs = new Map();
    const requests = { reservations: 0, reads: 0, failUploads: false };
    const readGate = { enabled: false, release: null };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const match = url.pathname.match(/^\/api\/rooms\/[^/]+\/blobs(?:\/([^/]+))?(?:\/(chunks)\/(\d+)|(\/complete))?$/);
      if (!match) return realFetch(input, init);
      init.signal?.throwIfAborted();
      const method = init.method ?? 'GET';
      if (!match[1] && method === 'POST') {
        const plan = JSON.parse(init.body);
        requests.reservations++;
        if (!blobs.has(plan.blobId)) blobs.set(plan.blobId, { ...plan, chunks: new Map(), completed: false });
        return new Response('{}');
      }
      const blob = blobs.get(match[1]);
      check(blob, `Unreserved blob ${match[1]}`);
      if (match[2] === 'chunks') {
        const index = Number(match[3]);
        if (method === 'PUT') {
          if (requests.failUploads) return new Response(JSON.stringify({ error: 'Simulated interrupted upload', code: 'TEST_UPLOAD_FAILED' }), { status: 400 });
          blob.chunks.set(index, new Uint8Array(init.body).slice());
          return new Response('{}');
        }
        requests.reads++;
        if (readGate.enabled) await new Promise(resolve => { readGate.release = resolve; });
        init.signal?.throwIfAborted();
        check(blob.chunks.has(index), `Missing encrypted chunk ${index}`);
        return new Response(blob.chunks.get(index));
      }
      if (match[4] && method === 'POST') {
        check(blob.chunks.size === blob.chunkCount, 'Completed an incomplete blob');
        blob.completed = true;
        return new Response('{}');
      }
      return new Response(JSON.stringify({ uploadedIndexes: [...blob.chunks.keys()], completed: blob.completed }), { headers: { 'Content-Type': 'application/json' } });
    };
    app.enqueuePayload = async (payload, clientMsgId = crypto.randomUUID()) => {
      const record = { seq: sent.length + 1, clientMsgId, senderId: own.deviceId, payload, acceptedAt: payload.sentAt, status: 'stored' };
      sent.push(record);
      app.pending.set(clientMsgId, record);
      if (root.querySelector('.chat-shell')) app.renderMessages();
    };

    const reopen = (destination = 'chat', records = []) => {
      focused = true;
      app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
      app.pending = new Map(records.map(record => [record.clientMsgId, record]));
      app.messages = new Map(); app.uiPreferences = {}; app.restoreChatAnchorOnNextRender = false;
      if (destination === 'gallery') app.renderGallery(); else app.renderChat();
    };
    const fresh = (destination = 'chat', role = 'creator', capabilities = ['image-album-v1', 'file-message-v1']) => {
      app.lockNow(); sent.length = 0;
      session.vault.role = own.role = role; own.capabilities = capabilities;
      requests.failUploads = false;
      readGate.enabled = false; readGate.release = null;
      reopen(destination);
    };
    const fixtures = () => [
      new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path fill="red" d="M0 0h20v20H0z"/></svg>'], 'first.svg', { type: 'image/svg+xml', lastModified: 1 }),
      new File(['%PDF-1.7\nfile-flow exact bytes\n%%EOF'], '说明书.pdf', { type: 'application/pdf', lastModified: 2 }),
      new File([new Uint8Array([0, 255, 1, 128, 10, 13, 42])], 'opaque.unknown', { type: '', lastModified: 3 }),
    ];
    const choose = (destination, files) => {
      const input = root.querySelector(destination === 'gallery' ? '#gallery-image-input' : '#image-input');
      check(input && input.multiple, `${destination}: multiple file selection is unavailable`);
      const transfer = new DataTransfer();
      files.forEach(file => transfer.items.add(file));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
      return input;
    };
    const selectedNames = () => sent.map(({ payload }) => (payload.file ?? payload.image)?.originalName);
    const selectedKinds = () => sent.map(({ payload }) => payload.kind);
    window.fileFlow = { app, root, session, own, check, sent, blobs, requests, readGate, fresh, reopen, fixtures, choose, selectedNames, selectedKinds,
      blur: () => { focused = false; window.dispatchEvent(new Event('blur')); },
      focus: () => { focused = true; window.dispatchEvent(new Event('focus')); },
    };
    fresh();
  });

  const results = {};
  results.pickers = await page.evaluate(() => {
    const { root, fresh, check } = window.fileFlow;
    for (const destination of ['chat', 'gallery']) {
      fresh(destination);
      const input = root.querySelector(destination === 'gallery' ? '#gallery-image-input' : '#image-input');
      check(input && input.multiple && !input.getAttribute('accept'), `${destination}: picker still restricts file formats`);
    }
    return { chat: 'all files', gallery: 'all files', multiple: true };
  });

  await page.evaluate(() => { const f = window.fileFlow; f.fresh(); f.choose('chat', f.fixtures()); });
  await page.waitForFunction(() => window.fileFlow.sent.length === 3 && !window.fileFlow.app.imageBatchUploading);
  results.mixedChat = await page.evaluate(() => {
    const { root, sent, blobs, check, selectedKinds, selectedNames } = window.fileFlow;
    check(JSON.stringify(selectedKinds()) === '["image","file","file"]', 'Mixed chat selection lost its message kinds or order');
    check(JSON.stringify(selectedNames()) === '["first.svg","说明书.pdf","opaque.unknown"]', 'Mixed chat selection reordered or renamed files');
    check(root.querySelectorAll('.message .file-attachment').length === 2, 'Chat file cards are missing or duplicated');
    check(root.querySelectorAll('.message .image-preview').length === 1, 'Mixed selection changed the image preview');
    const cards = [...root.querySelectorAll('.message .file-attachment')];
    check(cards.every(card => card.querySelector('.file-attachment-name')?.textContent && card.querySelector('.file-attachment-meta')?.textContent), 'File cards lack their filename or size/type metadata');
    check(cards[0].querySelector('.file-attachment-name').textContent === '说明书.pdf' && cards[1].querySelector('.file-attachment-name').textContent === 'opaque.unknown', 'Visible file order differs from the selection');
    check(sent[2].payload.file.mimeType === '', 'Unknown MIME did not preserve the original file metadata');
    for (const record of sent) {
      const manifest = record.payload.file ?? record.payload.image;
      const blob = blobs.get(manifest.blobId);
      check(blob.completed && blob.encryptedSize === manifest.originalSize + 16 * manifest.chunkCount, 'File transfer did not retain authenticated encrypted chunks');
    }
    return { kinds: selectedKinds(), names: selectedNames(), cards: cards.length, unknownMime: sent[2].payload.file.mimeType };
  });
  await captureFiles('chat-files');

  const readDownload = async locator => {
    const pending = page.waitForEvent('download');
    await locator.click();
    const download = await pending;
    const stream = await download.createReadStream();
    assert(stream, 'Download did not expose a readable file');
    const parts = [];
    for await (const chunk of stream) parts.push(chunk);
    return { name: download.suggestedFilename(), bytes: Buffer.concat(parts) };
  };
  const pdf = await readDownload(page.locator('.message .file-attachment').filter({ hasText: '说明书.pdf' }));
  assert.equal(pdf.name, '说明书.pdf');
  assert.deepEqual(pdf.bytes, Buffer.from('%PDF-1.7\nfile-flow exact bytes\n%%EOF'));
  const binary = await readDownload(page.locator('.message .file-attachment').filter({ hasText: 'opaque.unknown' }));
  assert.equal(binary.name, 'opaque.unknown');
  assert.deepEqual(binary.bytes, Buffer.from([0, 255, 1, 128, 10, 13, 42]));
  results.downloads = { pdf: 'exact original bytes', binary: 'exact original bytes' };

  // Locking while a chunk is in flight must stop the late download; stale card
  // listeners must also be unable to start another read after the UI is gone.
  const staleCard = await page.locator('.message .file-attachment').filter({ hasText: '说明书.pdf' }).elementHandle();
  await page.evaluate(() => { window.fileFlow.readGate.enabled = true; });
  const beforeLockDownloads = downloads.length;
  await staleCard.evaluate(card => card.click());
  await page.waitForFunction(() => window.fileFlow.readGate.release !== null);
  const readsAtLock = await page.evaluate(() => {
    const f = window.fileFlow;
    f.app.lockNow(); f.readGate.enabled = false; f.readGate.release();
    return f.requests.reads;
  });
  await staleCard.evaluate(card => card.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForTimeout(250);
  assert.equal(downloads.length, beforeLockDownloads, 'A pending or stale file card downloaded after lock');
  assert.equal(await page.evaluate(() => window.fileFlow.requests.reads), readsAtLock, 'A stale card started a file read after lock');
  assert.equal(await page.locator('.cover-trigger').count(), 1);
  results.lockedDownloads = { inFlight: 'cancelled', staleCard: 'ignored' };

  const assertGalleryTab = async (selected, { images, files, focused = false } = {}) => {
    const state = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('[role="tab"]')].map(tab => ({
        id: tab.id, selected: tab.getAttribute('aria-selected'), tabIndex: tab.tabIndex,
        controls: tab.getAttribute('aria-controls'), focused: document.activeElement === tab,
      })),
      panel: { role: document.querySelector('#gallery-grid')?.getAttribute('role'), labelledBy: document.querySelector('#gallery-grid')?.getAttribute('aria-labelledby') },
      images: [...document.querySelectorAll('.gallery-tile')].filter(tile => tile.getClientRects().length).length,
      files: [...document.querySelectorAll('.gallery-file')].filter(card => card.getClientRects().length).length,
    }));
    assert.equal(state.tabs.length, 2, 'Gallery does not expose exactly two tabs');
    for (const tab of state.tabs) {
      const active = tab.id === `gallery-tab-${selected}`;
      assert.equal(tab.selected, String(active), `${tab.id}: selected state does not match ${selected}`);
      assert.equal(tab.tabIndex, active ? 0 : -1, `${tab.id}: keyboard tab order does not match selection`);
      assert.equal(tab.controls, 'gallery-grid', `${tab.id}: tab is not linked to its panel`);
      if (focused && active) assert(tab.focused, `${tab.id}: keyboard focus was lost during the tab switch`);
    }
    assert.equal(state.panel.role, 'tabpanel');
    assert.equal(state.panel.labelledBy, `gallery-tab-${selected}`);
    if (images !== undefined) assert.equal(state.images, images, `${selected}: unexpected visible images`);
    if (files !== undefined) assert.equal(state.files, files, `${selected}: unexpected visible files`);
  };
  await page.evaluate(() => window.fileFlow.fresh('gallery'));
  await assertGalleryTab('images', { images: 0, files: 0 });
  await page.waitForFunction(() => document.querySelector('[data-gallery-count="images"]')?.textContent === '0');
  assert.equal(await page.locator('[data-gallery-count="files"]').textContent(), '—', 'Unqueried file category incorrectly claims zero files');
  await page.evaluate(() => { const f = window.fileFlow; f.choose('gallery', f.fixtures()); });
  await page.waitForFunction(() => window.fileFlow.sent.length === 3 && !window.fileFlow.app.imageBatchUploading);
  results.gallery = await page.evaluate(() => {
    const f = window.fileFlow;
    f.check(JSON.stringify(f.selectedKinds()) === '["gallery-image","gallery-file","gallery-file"]', 'Mixed gallery selection lost its private kinds or order');
    f.check(JSON.stringify(f.selectedNames()) === '["first.svg","说明书.pdf","opaque.unknown"]', 'Mixed gallery selection reordered the files');
    f.check(f.root.querySelectorAll('.gallery-file').length === 2, 'Gallery file entries are missing');
    f.check(f.root.querySelectorAll('.gallery-file .file-attachment-name').length === 2, 'Gallery file names are missing');
    return { kinds: f.selectedKinds(), files: f.root.querySelectorAll('.gallery-file').length };
  });
  await assertGalleryTab('files', { images: 0, files: 2 });
  await captureFiles('gallery-files');
  const galleryPdf = await readDownload(page.locator('.gallery-file').filter({ hasText: '说明书.pdf' }));
  assert.equal(galleryPdf.name, '说明书.pdf');
  assert.deepEqual(galleryPdf.bytes, pdf.bytes);
  await page.locator('#gallery-tab-images').click();
  await assertGalleryTab('images', { images: 1, files: 0 });
  await captureFiles('gallery-images');
  await page.locator('#gallery-tab-images').focus();
  for (const [key, selected] of [['ArrowRight', 'files'], ['ArrowRight', 'images'], ['ArrowLeft', 'files'], ['Home', 'images'], ['End', 'files']]) {
    await page.keyboard.press(key);
    await assertGalleryTab(selected, { images: selected === 'images' ? 1 : 0, files: selected === 'files' ? 2 : 0, focused: true });
  }
  await page.locator('#gallery-back').click();
  await page.locator('.chat-shell').waitFor();
  await page.locator('#open-gallery').click();
  await page.locator('.gallery-shell').waitFor();
  await assertGalleryTab('images', { images: 1, files: 0 });
  results.gallery.tabs = { default: 'images', mixedUploadResult: 'files', categoriesSeparated: true, reentry: 'images', keyboard: 'arrows wrap; Home and End activate and focus their tab' };
  await page.evaluate(() => {
    const f = window.fileFlow;
    const records = [...f.sent];
    f.app.renderChat();
    f.check(f.root.querySelectorAll('.message').length === 0, 'Private gallery files leaked into the creator chat');
    f.session.vault.role = f.own.role = 'joiner';
    f.app.renderChat();
    f.check(!f.root.querySelector('#open-gallery'), 'Invited participant received a gallery entry');
    f.check(f.root.querySelectorAll('.message').length === 0, 'Private gallery files leaked into invited participant chat');
    f.app.renderGallery();
    f.check(!f.root.querySelector('.gallery-shell'), 'Invited participant opened the private gallery route');
    f.check(records.length === 3, 'Gallery fixture lost its private records');
  });
  results.gallery.privateFromChat = true;
  results.gallery.creatorOnly = true;

  results.guards = await page.evaluate(async () => {
    const f = window.fileFlow;
    f.fresh('chat', 'joiner');
    const beforeRole = f.requests.reservations;
    await f.app.processImageFiles([f.fixtures()[1]], 'gallery');
    f.check(f.requests.reservations === beforeRole && f.sent.length === 0, 'Invited participant uploaded a private gallery file');
    f.fresh('chat', 'creator', ['image-album-v1']);
    const beforeCapability = f.requests.reservations;
    await f.app.processImageFiles([f.fixtures()[1]], 'chat');
    f.check(f.requests.reservations === beforeCapability && f.sent.length === 0, 'Unsupported active devices allowed a new file message');
    return { galleryRole: 'blocked before upload', oldDevices: 'blocked before upload' };
  });

  results.unknownMimeResume = await page.evaluate(async () => {
    const f = window.fileFlow;
    f.fresh(); f.requests.failUploads = true;
    const file = f.fixtures()[2];
    await f.app.processImageFiles([file], 'chat');
    f.check(f.sent.length === 0 && f.app.uploadPlans.length === 1, 'Interrupted binary upload lost its resumable plan');
    const blobId = f.app.uploadPlans[0].blobId;
    f.requests.failUploads = false;
    await f.app.processImageFiles([f.fixtures()[2]], 'chat');
    f.check(f.sent.length === 1 && f.sent[0].payload.file.blobId === blobId, 'Reselecting the same empty-MIME file started a new upload');
    f.check(f.app.uploadPlans.length === 0, 'Completed binary upload left a stale resume reminder');
    return { originalBlobReused: true, queuedExactlyOnce: true, resumePlanCleared: true };
  });

  results.deferredSelection = [];
  for (const destination of ['chat', 'gallery']) {
    for (const order of ['focus-before-change', 'change-before-focus']) {
      await page.evaluate(({ destination, order }) => {
        const f = window.fileFlow;
        f.fresh(destination);
        const input = f.root.querySelector(destination === 'gallery' ? '#gallery-image-input' : '#image-input');
        input.addEventListener('click', event => event.preventDefault());
        f.root.querySelector(destination === 'gallery' ? '#open-gallery-image-picker' : '#open-image-picker').click();
        f.blur();
        f.check(f.app.privacyCovered && input.isConnected && input.hidden, 'Picker blur did not preserve a hidden selection input');
        if (order === 'focus-before-change') f.focus();
        const transfer = new DataTransfer();
        f.fixtures().slice(1).forEach(file => transfer.items.add(file));
        input.files = transfer.files; input.dispatchEvent(new Event('change'));
        if (order === 'change-before-focus') f.focus();
        f.check(f.app.privacyCovered && f.sent.length === 0, 'File selection uploaded before unlock');
        f.check(f.app.deferredImageUpload?.files.length === 2, 'Locked picker discarded a non-image selection');
        f.check(f.app.deferredImageUpload.files[1].type === '', 'Picker mutated the original unknown MIME before upload');
        f.reopen(destination);
        window.fileFlow.resume = f.app.resumeDeferredImage();
      }, { destination, order });
      await page.evaluate(() => window.fileFlow.resume);
      const state = await page.evaluate(() => {
        const f = window.fileFlow;
        f.check(f.sent.length === 2 && !f.app.deferredImageUpload, 'Non-image selection did not resume exactly once after unlock');
        f.check(JSON.stringify(f.selectedNames()) === '["说明书.pdf","opaque.unknown"]', 'Unlock lost the selected file order');
        return { kinds: f.selectedKinds(), names: f.selectedNames() };
      });
      results.deferredSelection.push({ destination, order, ...state });
    }
  }
  await page.evaluate(() => window.fileFlow.app.lockNow());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
