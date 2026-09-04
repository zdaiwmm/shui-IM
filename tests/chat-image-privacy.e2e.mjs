import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Exercise real encrypted attachment bytes, caches and mounted chat listeners.
// The fixture replaces only the opaque chunk service and unrelated controls.
const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'chat-image-privacy-fixture', configureServer(vite) {
    vite.middlewares.use('/__chat_image_privacy', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});
const visualQaDirectory = process.argv[2];
const browserName = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
let browser;
try {
  await server.listen();
  browser = browserName === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }, hasTouch: true,
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__chat_image_privacy`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/gallery.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const { encryptImageFile } = await import('/src/lib/file-crypto.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities: ['image-album-v1'] };
    const peer = { deviceId: crypto.randomUUID(), role: 'joiner', status: 'active', capabilities: ['image-album-v1'] };
    const session = await vault.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'chat-image-privacy-test', role: 'creator', protocol: 'legacy-v1', lastSeq: 3, members: [own, peer], identity: { publicBundle: own } }, 'chat-image-privacy-passphrase', 'password');
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.flushUiPreferencesSave = () => {};
    app.unreadCounter.markRead = async () => {};
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    const encryptedChunks = new Map();
    const originals = new Map();
    const gate = { blobId: null, waiting: false, release: null };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const match = url.pathname.match(/\/blobs\/([^/]+)\/chunks\/(\d+)$/);
      const bytes = match && encryptedChunks.get(`${match[1]}:${match[2]}`);
      if (!bytes) return realFetch(input, init);
      if (match[1] === gate.blobId) {
        gate.waiting = true;
        await new Promise(resolve => { gate.release = resolve; });
      }
      init.signal?.throwIfAborted();
      return new Response(bytes);
    };
    let imageNumber = 0;
    const makeImage = async ({ cached = false, delayed = false } = {}) => {
      imageNumber++;
      const file = new File([`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><path fill="#809d97" d="M0 0h320v180H0z"/><circle fill="#eadbb7" cx="248" cy="42" r="20"/><path fill="#526c61" d="M0 180 105 40 240 180Z"/></svg>`], `聊天隐私-${imageNumber}.svg`, { type: 'image/svg+xml', lastModified: imageNumber });
      const manifest = await encryptImageFile(file, {
        reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
        upload: async (blobId, index, bytes) => { encryptedChunks.set(`${blobId}:${index}`, bytes); },
        complete: async () => {}, savePlan: async () => {},
      });
      originals.set(manifest.blobId, file);
      if (cached) app.cacheLocalImage(manifest, file);
      if (delayed) { gate.blobId = manifest.blobId; gate.waiting = false; gate.release = null; }
      return manifest;
    };
    const sentAt = '2026-09-04T10:00:00.000Z';
    const record = (seq, media, senderId = own.deviceId) => ({
      seq, clientMsgId: crypto.randomUUID(), senderId,
      payload: { v: 1, sentAt, ...media }, acceptedAt: sentAt, status: senderId === own.deviceId ? 'stored' : 'delivered',
    });
    const records = [
      record(1, { kind: 'image', image: await makeImage({ cached: true }) }),
      record(2, { kind: 'image', image: await makeImage() }, peer.deviceId),
      record(3, { kind: 'image-album', images: [await makeImage({ cached: true }), await makeImage()] }),
    ];
    for (const message of records) await vault.saveHistoryMessage(session, message);
    const reopen = async () => {
      app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
      app.messages = new Map((await vault.loadHistoryPage(session)).map(message => [message.seq, message]));
      app.pending = new Map(); app.uiPreferences = {}; app.restoreChatAnchorOnNextRender = false;
      app.renderChat();
    };
    const addImage = async options => {
      const message = record(records.length + 1, { kind: 'image', image: await makeImage(options) }, peer.deviceId);
      records.push(message);
      await vault.saveHistoryMessage(session, message);
      app.messages.set(message.seq, message);
      app.renderMessages({ scroll: 'bottom' });
      return message.payload.image.blobId;
    };
    window.chatPrivacy = { app, session, vault, originals, records, gate, addImage, reopen };
    await reopen();
  });

  const previews = page.locator('.message .image-preview');
  const assertVisibility = async (total, revealed, reason) => {
    await page.waitForFunction(({ total, revealed }) => {
      const buttons = [...document.querySelectorAll('.message .image-preview')];
      return buttons.length === total && buttons.every(button => ['true', 'false'].includes(button.dataset.revealed))
        && buttons.filter(button => button.dataset.revealed === 'true').length === revealed
        && buttons.every(button => {
          const image = button.querySelector('img');
          if (!image) return true;
          return button.dataset.revealed === 'false' ? getComputedStyle(image).filter.includes('blur(') : getComputedStyle(image).filter === 'none';
        });
    }, { total, revealed });
    assert.equal(await previews.locator('img').evaluateAll(images => images.filter(image => {
      const hidden = image.closest('.image-preview').dataset.revealed === 'false';
      return hidden ? !getComputedStyle(image).filter.includes('blur(') : getComputedStyle(image).filter !== 'none';
    }).length), 0, `${reason}: thumbnail styling disagrees with its reveal state`);
  };
  const waitForClicks = () => page.waitForFunction(() => Date.now() >= window.chatPrivacy.app.suppressMediaClickUntil);
  const drag = async (locator, { dx = 0, dy = 60, touch = false, followingClick = false } = {}) => locator.evaluate((element, { dx, dy, touch, followingClick }) => {
    if (touch) {
      // WebKit does not expose constructible Touch objects in this harness.
      // Supply the same read-only touch coordinates to the mounted listeners.
      const finger = (x, y) => ({ identifier: 9, target: element, clientX: x, clientY: y });
      const sendTouch = (type, touches, changedTouches) => {
        const event = new Event(type, { bubbles: true });
        Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
        element.dispatchEvent(event);
      };
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 9, isPrimary: true, button: 0, clientX: 120, clientY: 200 }));
      sendTouch('touchstart', [finger(120, 200)], [finger(120, 200)]);
      // Native document scrolling cancels pointer events while touch events
      // continue, so concealment must survive this real mobile event order.
      element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch', pointerId: 9, isPrimary: true, clientX: 120, clientY: 200 }));
      sendTouch('touchmove', [finger(120 + dx, 200 + dy)], [finger(120 + dx, 200 + dy)]);
      sendTouch('touchend', [], [finger(120 + dx, 200 + dy)]);
    } else {
      for (const [type, x, y] of [['pointerdown', 120, 200], ['pointermove', 120 + dx, 200 + dy], ['pointerup', 120 + dx, 200 + dy]]) {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 9, isPrimary: true, button: 0, clientX: x, clientY: y }));
      }
    }
    if (followingClick) element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, { dx, dy, touch, followingClick });

  await page.waitForFunction(() => document.querySelectorAll('.message .image-preview img').length === 4);
  await assertVisibility(4, 0, 'Initial cached and decrypted thumbnails');
  assert.equal(await page.locator('.image-album .image-preview').count(), 2, 'Album fixture does not exercise individual cells');
  const first = previews.first();
  // A long hold can outlast the ordinary click-suppression interval. The
  // visible message menu must still keep its thumbnail concealed on release.
  await first.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 12, isPrimary: true, button: 0, clientX: 120, clientY: 200 });
  await page.locator('.message-actions.is-visible .message-reaction-picker').waitFor();
  await waitForClicks();
  await first.evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 12, isPrimary: true, button: 0, clientX: 120, clientY: 200 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await assertVisibility(4, 0, 'Long-hold release after suppression timeout');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'Long-hold release opened a viewer behind the message menu');
  assert.equal(await page.locator('.message-actions.is-visible').count(), 1, 'Long-hold regression did not retain its visible menu');
  await page.evaluate(() => window.chatPrivacy.app.closeMessageActions(true, false));
  await first.click();
  await assertVisibility(4, 1, 'First tap');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'First thumbnail tap opened a viewer');
  await first.click();
  await page.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  const zoomState = await page.locator('.viewer-stage').evaluate(stage => {
    const image = stage.querySelector('img');
    const entryTransforms = image.getAnimations().flatMap(animation => animation.effect.getKeyframes()).filter(frame => frame.transform && frame.transform !== 'none');
    const fire = (type, id, x, y) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: id, button: 0, clientX: x, clientY: y }));
    fire('pointerdown', 31, 120, 300);
    fire('pointerdown', 32, 240, 300);
    fire('pointermove', 31, 60, 300);
    fire('pointermove', 32, 300, 300);
    const zoomed = new DOMMatrix(getComputedStyle(image).transform).a;
    fire('pointerup', 31, 60, 300);
    fire('pointermove', 32, 340, 300);
    const remainingFingerPans = new DOMMatrix(getComputedStyle(image).transform).e;
    fire('pointerup', 32, 340, 300);
    const remainsOpen = !stage.closest('.image-viewer').classList.contains('is-closing');
    fire('pointerdown', 33, 200, 300);
    fire('pointermove', 33, 270, 410);
    fire('pointerup', 33, 270, 410);
    const pan = new DOMMatrix(getComputedStyle(image).transform);
    image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 195, clientY: 422 }));
    return { entryTransforms: entryTransforms.length, zoomed, remainsOpen, remainingFingerPans: remainingFingerPans > 15, panned: pan.e !== 0, zoomAfterPan: pan.a, reset: new DOMMatrix(getComputedStyle(image).transform).a };
  });
  assert.deepEqual(zoomState, { entryTransforms: 0, zoomed: 2, remainsOpen: true, remainingFingerPans: true, panned: true, zoomAfterPan: 2, reset: 1 }, 'Image pinch/pan/reset either scaled on entry, dismissed during pinch or lost its zoom');
  await page.locator('[data-viewer-close]').click();
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  await assertVisibility(4, 1, 'Ordinary viewer return');
  await page.locator('.image-album .image-preview').first().click();
  await assertVisibility(4, 2, 'Album cell reveal');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'First album cell tap opened a viewer');

  // A deliberate pull conceals all thumbnails, including those outside the
  // gesture target; the browser's subsequent synthesized click stays inert.
  await drag(first, { dy: 12 });
  await assertVisibility(4, 2, 'Small touch movement');
  await drag(first, { dx: 80, dy: 30 });
  await assertVisibility(4, 2, 'Horizontal gesture');
  await drag(first, { dy: 24, followingClick: true });
  await assertVisibility(4, 0, 'Pointer pull and synthesized click');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'A pull opened the viewer');
  await waitForClicks();
  await first.click();
  await previews.nth(1).click();
  await drag(previews.nth(1), { touch: true, followingClick: true });
  await assertVisibility(4, 0, 'Touch pull and synthesized click');
  await waitForClicks();

  // Receipt-driven node replacement must retain concealment even when the
  // original is already decoded and immediately available in the cache.
  await page.evaluate(() => {
    const f = window.chatPrivacy;
    const message = f.app.messages.get(1);
    f.app.messages.set(1, { ...message, status: 'delivered' });
    f.app.renderMessages();
  });
  await assertVisibility(4, 0, 'Cached thumbnail after receipt rebuild');
  await first.click();
  const newId = await page.evaluate(() => window.chatPrivacy.addImage({ delayed: true }));
  const delayed = page.locator(`.image-preview[data-blob-id="${newId}"]`);
  await page.waitForFunction(() => window.chatPrivacy.gate.waiting);
  await assertVisibility(5, 1, 'New pending thumbnail');
  await delayed.click();
  await assertVisibility(5, 2, 'Reveal while loading');
  await drag(delayed, { followingClick: true });
  await page.evaluate(() => { const gate = window.chatPrivacy.gate; gate.blobId = null; gate.release(); });
  await delayed.locator('img').waitFor();
  await assertVisibility(5, 0, 'Pull before delayed decryption resolves');
  await waitForClicks();
  await delayed.click();
  await delayed.click();
  await page.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  await drag(page.locator('.viewer-stage'), { dy: 150 });
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  await assertVisibility(5, 0, 'Viewer downward dismissal');
  await waitForClicks();

  await delayed.click();
  const transient = await page.evaluate(() => {
    const f = window.chatPrivacy;
    window.dispatchEvent(new Event('blur'));
    const buttons = [...document.querySelectorAll('.message .image-preview')];
    const immediatelyHidden = buttons.length === 5 && buttons.every(button => button.dataset.revealed === 'false'
      && (!button.querySelector('img') || getComputedStyle(button.querySelector('img')).filter.includes('blur(')));
    const curtainVisible = getComputedStyle(document.querySelector('.privacy-curtain')).visibility === 'visible';
    window.dispatchEvent(new Event('focus'));
    return { immediatelyHidden, curtainVisible, unlockedAfterFocus: !f.app.privacyCovered };
  });
  assert.deepEqual(transient, { immediatelyHidden: true, curtainVisible: true, unlockedAfterFocus: true }, 'Transient privacy cover did not conceal thumbnails synchronously');
  await assertVisibility(5, 0, 'Rapid foreground restoration');
  await page.waitForTimeout(300);
  await assertVisibility(5, 0, 'After blur debounce');
  await delayed.click();
  await delayed.click();
  await page.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  const coveredViewer = await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    const viewerGone = document.querySelector('.image-viewer') === null;
    window.dispatchEvent(new Event('focus'));
    return viewerGone;
  });
  assert(coveredViewer, 'Transient privacy cover retained the full-resolution viewer');
  await assertVisibility(5, 0, 'Rapid foreground restoration from viewer');

  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    await page.screenshot({ path: path.join(visualQaDirectory, `chat-images-hidden-${browserName}-390.png`), animations: 'disabled' });
    await delayed.click();
    await page.screenshot({ path: path.join(visualQaDirectory, `chat-image-revealed-${browserName}-390.png`), animations: 'disabled' });
  }

  // Lock during a fetch, then invoke a detached button: neither asynchronous
  // completion nor a stale event listener may expose a new private surface.
  await first.click();
  await page.evaluate(async () => {
    const f = window.chatPrivacy;
    await f.addImage({ delayed: true });
    f.detachedPreview = document.querySelector('.message .image-preview');
  });
  await page.waitForFunction(() => window.chatPrivacy.gate.waiting);
  await page.evaluate(() => {
    const f = window.chatPrivacy;
    f.app.lockNow(); f.detachedPreview.click();
    f.gate.blobId = null; f.gate.release();
  });
  await page.waitForFunction(() => window.chatPrivacy.app.imageLoadPromises.size === 0);
  assert.equal(await page.locator('.chat-shell, .image-viewer').count(), 0, 'Late decrypt or detached click reopened a locked surface');
  assert.equal(await page.evaluate(() => window.chatPrivacy.app.imageCache.size), 0, 'Late decryption repopulated the locked image cache');
  await page.evaluate(() => window.chatPrivacy.reopen());
  await page.waitForFunction(() => document.querySelectorAll('.message .image-preview img').length === 6);
  await assertVisibility(6, 0, 'Durable history reentry');
  const originalUnchanged = await page.evaluate(async () => {
    const f = window.chatPrivacy;
    const manifest = f.records.at(-1).payload.image;
    const original = new Uint8Array(await f.originals.get(manifest.blobId).arrayBuffer());
    const verified = new Uint8Array(await f.app.imageCache.get(manifest.blobId).blob.arrayBuffer());
    return original.length === verified.length && original.every((byte, index) => byte === verified[index]);
  });
  assert(originalUnchanged, 'Concealment changed the decrypted original attachment bytes');

  // A peer may send the same valid attachment manifest in a new message.
  // Explicit reveal belongs to the original message, while receipt-driven
  // rebuilding of that original row must preserve its current reveal state.
  await first.click();
  const repeatedIds = await page.evaluate(async () => {
    const f = window.chatPrivacy;
    const original = f.app.messages.get(1);
    f.beforeRebuild = document.querySelector(`.message[data-client-msg-id="${original.clientMsgId}"] .image-preview`);
    const repeated = { ...original, seq: f.records.length + 1, clientMsgId: crypto.randomUUID(), senderId: f.records[1].senderId };
    f.records.push(repeated);
    await f.vault.saveHistoryMessage(f.session, repeated);
    f.app.messages.set(repeated.seq, repeated);
    f.app.messages.set(1, { ...original, status: 'delivered' });
    f.app.renderMessages();
    return { original: original.clientMsgId, repeated: repeated.clientMsgId };
  });
  const originalRow = page.locator(`.message[data-client-msg-id="${repeatedIds.original}"] .image-preview`);
  const repeatedRow = page.locator(`.message[data-client-msg-id="${repeatedIds.repeated}"] .image-preview`);
  await repeatedRow.locator('img').waitFor();
  assert.equal(await page.evaluate(() => window.chatPrivacy.beforeRebuild.isConnected), true, 'A receipt replaced the revealed media row and restarted its display');
  assert.equal(await originalRow.getAttribute('data-revealed'), 'true', 'Rebuilding the original message discarded its explicit reveal');
  assert.equal(await repeatedRow.getAttribute('data-revealed'), 'false', 'A new message inherited the reveal state of a reused attachment manifest');
  await assertVisibility(7, 1, 'Repeated manifest isolated from the original revealed message');
  await drag(originalRow, { followingClick: true });
  await assertVisibility(7, 0, 'Pull hides both messages sharing one attachment');
  await page.evaluate(() => {
    const f = window.chatPrivacy;
    f.app.openImageViewer([f.records[0].payload.image]);
  });
  await page.locator('.viewer-stage img').waitFor();
  const directCleanup = await page.evaluate(() => {
    const app = window.chatPrivacy.app;
    const stage = document.querySelector('.viewer-stage');
    const image = stage.querySelector('img');
    const before = image.style.transform;
    app.cleanupRuntime();
    image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 195, clientY: 422 }));
    return { cleanupReleased: app.viewerGestureCleanup === null, detached: !stage.isConnected, staleGestureIgnored: image.style.transform === before };
  });
  assert.deepEqual(directCleanup, { cleanupReleased: true, detached: true, staleGestureIgnored: true }, 'Direct runtime teardown retained a viewer gesture closure');
  await page.evaluate(() => window.chatPrivacy.app.lockNow());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browserName, defaultHidden: true, longHoldReleaseHidden: true, revealThenView: true, albumCells: true, pointerAndTouchPull: true, dragClickSuppressed: true, cachedRebuildHidden: true, reusedManifestIsolated: true, revealedReceiptRebuildPreserved: true, delayedDecodeHidden: true, viewerPullHidden: true, synchronousCoverHidden: true, rapidFocusHidden: true, lockAndReentryHidden: true, originalBytesPreserved: true }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
