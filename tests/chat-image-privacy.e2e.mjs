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
    const makeImage = async ({ cached = false, delayed = false, width = 320, height = 180 } = {}) => {
      imageNumber++;
      const file = new File([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#809d97"/><rect x="0" y="${height * .18}" width="${width}" height="${height * .29}" fill="#eadbb7"/><rect x="0" y="${height * .68}" width="${width}" height="${height * .32}" fill="#526c61"/></svg>`], `聊天隐私-${imageNumber}.svg`, { type: 'image/svg+xml', lastModified: imageNumber });
      const manifest = await encryptImageFile(file, {
        includeDimensions: true,
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
    const record = (seq, media, senderId = peer.deviceId) => ({
      seq, clientMsgId: crypto.randomUUID(), senderId,
      payload: { v: 1, sentAt, ...media }, acceptedAt: sentAt, status: senderId === own.deviceId ? 'stored' : 'delivered',
    });
    const records = [
      record(1, { kind: 'image', presentation: 'expression', image: await makeImage({ cached: true }) }),
      record(2, { kind: 'image', image: await makeImage({ width: 8, height: 1200 }) }, peer.deviceId),
      record(3, { kind: 'image-album', images: [await makeImage({ cached: true, width: 1200, height: 8 }), await makeImage()] }),
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
          const backdrop = getComputedStyle(button, '::before');
          return button.dataset.revealed === 'false'
            ? Number(getComputedStyle(image).opacity) === 0 && getComputedStyle(image).filter === 'none' && backdrop.backgroundImage !== 'none'
              && backdrop.backgroundSize === 'cover' && backdrop.filter === 'none' && Number(backdrop.opacity) === 1
            : Number(getComputedStyle(image).opacity) === 1 && getComputedStyle(image).filter === 'none' && Number(backdrop.opacity) === 0;
        });
    }, { total, revealed });
    assert.equal(await previews.locator('img').evaluateAll(images => images.filter(image => {
      const hidden = image.closest('.image-preview').dataset.revealed === 'false';
      const backdrop = getComputedStyle(image.closest('.image-preview'), '::before');
      return hidden
        ? Number(getComputedStyle(image).opacity) !== 0 || getComputedStyle(image).filter !== 'none' || backdrop.backgroundImage === 'none'
          || backdrop.backgroundSize !== 'cover' || backdrop.filter !== 'none' || Number(backdrop.opacity) !== 1
        : Number(getComputedStyle(image).opacity) !== 1 || getComputedStyle(image).filter !== 'none' || Number(backdrop.opacity) !== 0;
    }).length), 0, `${reason}: thumbnail styling disagrees with its reveal state`);
  };
  const waitForClicks = () => page.waitForFunction(() => Date.now() >= window.chatPrivacy.app.suppressMediaClickUntil);
  const drag = async (locator, { dx = 60, dy = 0, touch = false, followingClick = false } = {}) => locator.evaluate((element, { dx, dy, touch, followingClick }) => {
    if (touch) {
      // WebKit does not expose constructible Touch objects in this harness.
      // Supply the same read-only touch coordinates to the mounted listeners.
      const finger = (x, y) => ({ identifier: 9, target: element, clientX: x, clientY: y });
      const sendTouch = (type, touches, changedTouches) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changedTouches } });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      };
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 9, isPrimary: true, button: 0, clientX: 120, clientY: 200 }));
      sendTouch('touchstart', [finger(120, 200)], [finger(120, 200)]);
      // Native document scrolling cancels pointer events while touch events
      // continue, so concealment must survive this real mobile event order.
      element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch', pointerId: 9, isPrimary: true, clientX: 120, clientY: 200 }));
      const scrollReserved = sendTouch('touchmove', [finger(120 + dx, 200 + dy)], [finger(120 + dx, 200 + dy)]);
      const clearDuringTouch = element.dataset.revealed === 'true' && getComputedStyle(element.querySelector('img')).filter === 'none';
      const displaced = new DOMMatrix(getComputedStyle(element.closest('.message-bubble')).transform).e;
      sendTouch('touchend', [], [finger(120 + dx, 200 + dy)]);
      if (followingClick) element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { scrollReserved, clearDuringTouch, displaced };
    } else {
      for (const [type, x, y] of [['pointerdown', 120, 200], ['pointermove', 120 + dx, 200 + dy], ['pointerup', 120 + dx, 200 + dy]]) {
        element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 9, isPrimary: true, button: 0, clientX: x, clientY: y }));
      }
    }
    if (followingClick) element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, { dx, dy, touch, followingClick });

  await page.waitForFunction(() => document.querySelectorAll('.message .image-preview img').length === 4);
  await assertVisibility(4, 0, 'Initial cached and decrypted thumbnails');
  // Sent photos, videos and expressions now share the same explicit reveal rule.
  const outgoingId = await page.evaluate(() => {
    const app = window.chatPrivacy.app;
    const message = app.messages.get(1);
    window.chatPrivacy.originalIncoming = message;
    app.messages.set(1, { ...message, senderId: app.session.vault.identity.publicBundle.deviceId, status: 'delivered' });
    app.renderMessages();
    return message.clientMsgId;
  });
  const outgoing = page.locator(`[data-client-msg-id="${outgoingId}"] .image-preview`);
  assert.equal(await outgoing.getAttribute('data-revealed'), 'false', 'Sent expression did not start concealed');
  await page.evaluate(() => {
    const app = window.chatPrivacy.app;
    const target = app.messages.get(1);
    const peer = app.session.vault.members.find(member => member.role !== app.session.vault.role);
    const acceptedAt = new Date(Date.now() - 11_000).toISOString();
    app.messages.set(90, { seq: 90, clientMsgId: crypto.randomUUID(), senderId: peer.deviceId,
      status: 'delivered', acceptedAt,
      payload: { v: 1, kind: 'media-read', sentAt: acceptedAt,
        target: { clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId } } });
    app.renderMessages();
  });
  assert.equal(await outgoing.getAttribute('data-revealed'), 'false', 'Peer read event revealed sent media');
  assert.equal(await page.locator('.message').count(), 3, 'Read event became a chat message');
  await outgoing.click();
  assert.equal(await outgoing.getAttribute('data-revealed'), 'true', 'Manual reveal of sent media failed');
  await page.evaluate(() => window.chatPrivacy.app.renderMessages());
  assert.equal(await outgoing.getAttribute('data-revealed'), 'true', 'Duplicate read projection undid manual reveal');
  await page.evaluate(() => {
    const f = window.chatPrivacy;
    f.app.messages.delete(90);
    f.app.messages.set(1, f.originalIncoming);
    f.app.concealChatImages();
    f.app.renderMessages();
  });
  await assertVisibility(4, 0, 'Return to incoming-media fixture');
  const bitmapEvidence = await page.evaluate(async () => {
    const entries = [...window.chatPrivacy.app.imageCache.values()];
    let maxJump = 0;
    for (const cached of entries) {
      if (!cached.concealedUrl || cached.concealedUrl === cached.url) return { valid: false };
      const image = new Image(); image.src = cached.concealedUrl; await image.decode();
      if (image.width > 128 || image.height > 128) return { valid: false };
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      for (let y = 1; y < image.height; y++) for (let x = 0; x < image.width; x++) {
        const offset = (y * image.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) maxJump = Math.max(maxJump, Math.abs(data[offset + channel] - data[offset - image.width * 4 + channel]));
      }
    }
    return { valid: true, maxJump };
  });
  assert(bitmapEvidence.valid && bitmapEvidence.maxJump <= 8, `Concealed bitmap has a discontinuous row: ${JSON.stringify(bitmapEvidence)}`);
  const cachedBlurReused = await page.evaluate(() => {
    const app = window.chatPrivacy.app;
    const before = [...app.imageCache.entries()].map(([blobId, cached]) => [blobId, cached.concealedUrl]).sort();
    app.renderMessages();
    const after = [...app.imageCache.entries()].map(([blobId, cached]) => [blobId, cached.concealedUrl]).sort();
    return before.length > 0 && before.every((entry, index) => entry[1] && entry[1] === after[index]?.[1]);
  });
  assert.equal(cachedBlurReused, true, 'A chat rerender regenerated an already cached concealed bitmap');
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
  const zoomState = await page.locator('.viewer-stage').evaluate(async stage => {
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
    const resetAnimation = image.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
    const resetStartsAt = new DOMMatrix(getComputedStyle(image).transform).a;
    const resetDuration = Number(resetAnimation?.effect.getTiming().duration ?? 0);
    await resetAnimation?.finished.catch(() => undefined);
    const reset = new DOMMatrix(getComputedStyle(image).transform).a;
    image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: 195, clientY: 422 }));
    const zoomAnimation = image.getAnimations().find(animation => animation.effect.getKeyframes().some(frame => frame.transform));
    const zoomStartsAt = new DOMMatrix(getComputedStyle(image).transform).a;
    const zoomDuration = Number(zoomAnimation?.effect.getTiming().duration ?? 0);
    await zoomAnimation?.finished.catch(() => undefined);
    const zoomIn = new DOMMatrix(getComputedStyle(image).transform).a;
    return { entryTransforms: entryTransforms.length, zoomed, remainsOpen, remainingFingerPans: remainingFingerPans > 15, panned: pan.e !== 0, zoomAfterPan: pan.a, resetStartsAt, resetDuration, reset, zoomStartsAt, zoomDuration, zoomIn };
  });
  assert.equal(zoomState.entryTransforms, 0, 'Viewer introduced an unrelated image scale transition on entry');
  assert.equal(zoomState.zoomed, 2, 'Pinch did not reach the expected zoom');
  assert.equal(zoomState.remainsOpen, true, 'Pinch unexpectedly dismissed the viewer');
  assert.equal(zoomState.remainingFingerPans, true, 'Pinch did not hand off naturally to the remaining finger');
  assert.equal(zoomState.panned, true, 'A zoomed image did not pan');
  assert.equal(zoomState.zoomAfterPan, 2, 'Panning changed the image zoom');
  assert.ok(zoomState.resetStartsAt > 1.2 && zoomState.resetDuration >= 250, `Double-click reset jumped instead of animating: ${JSON.stringify(zoomState)}`);
  assert.ok(Math.abs(zoomState.reset - 1) < 0.01, 'Animated double-click reset did not finish at 1×');
  assert.ok(zoomState.zoomStartsAt < 1.2 && zoomState.zoomDuration >= 250, `Double-click zoom-in jumped instead of animating: ${JSON.stringify(zoomState)}`);
  assert.ok(zoomState.zoomIn > 2.4, 'Animated double-click zoom-in did not reach its target');
  await page.locator('[data-viewer-close]').click();
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  await assertVisibility(4, 1, 'Ordinary viewer return');
  const pullFeedback = await first.evaluate(async element => {
    const bubble = element.closest('.message-bubble');
    const row = element.closest('.message');
    const before = bubble.getBoundingClientRect();
    const rowBefore = row.getBoundingClientRect();
    const fire = (type, x) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 61, isPrimary: true, button: 0, clientX: x, clientY: 200 }));
    fire('pointerdown', 200); fire('pointermove', 260);
    const firstPull = bubble.getBoundingClientRect().left - before.left;
    const clearDuringPull = element.dataset.revealed === 'true' && getComputedStyle(element.querySelector('img')).filter === 'none';
    fire('pointermove', 380);
    const longerPull = bubble.getBoundingClientRect().left - before.left;
    const stillClear = element.dataset.revealed === 'true';
    const stableRow = row.getBoundingClientRect().height === rowBefore.height && row.getBoundingClientRect().top === rowBefore.top;
    fire('pointerup', 380);
    const hiddenOnRelease = [...document.querySelectorAll('.message .image-preview')].every(preview => preview.dataset.revealed === 'false');
    const returnsSmoothly = bubble.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => frame.transform?.includes('translate3d')));
    await Promise.all(bubble.getAnimations().map(animation => animation.finished));
    return { firstPull, longerPull, clearDuringPull, stillClear, stableRow, hiddenOnRelease, returnsSmoothly, reset: getComputedStyle(bubble).transform === 'none' };
  });
  assert(pullFeedback.firstPull > 10 && pullFeedback.firstPull < 60 && pullFeedback.longerPull > pullFeedback.firstPull && pullFeedback.longerPull < 180, 'The media pull did not visibly follow with damping');
  assert((pullFeedback.longerPull - pullFeedback.firstPull) / 120 < pullFeedback.firstPull / 60, 'Longer media pulls did not increase resistance');
  assert.deepEqual(Object.fromEntries(Object.entries(pullFeedback).filter(([key]) => !['firstPull', 'longerPull'].includes(key))), { clearDuringPull: true, stillClear: true, stableRow: true, hiddenOnRelease: true, returnsSmoothly: true, reset: true }, 'Pulling concealed media before release, changed layout or did not return cleanly');
  await waitForClicks(); await first.click();
  const cancelledPull = await first.evaluate(element => {
    const bubble = element.closest('.message-bubble');
    for (const [type, y] of [['pointerdown', 200], ['pointermove', 270], ['pointercancel', 270]]) element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 62, isPrimary: true, button: 0, clientX: y, clientY: 200 }));
    return { hidden: element.dataset.revealed === 'false', reset: getComputedStyle(bubble).transform === 'none', animations: bubble.getAnimations().length };
  });
  assert.deepEqual(cancelledPull, { hidden: false, reset: true, animations: 0 }, 'Cancelled/native media scrolling must preserve visibility and release motion');
  await waitForClicks();
  const keyboardPriority = await first.evaluate(element => {
    const previous = document.documentElement.dataset.keyboardOpen;
    document.documentElement.dataset.keyboardOpen = 'true';
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 63, isPrimary: true, button: 0, clientX: 120, clientY: 200 }));
    // Even if keyboard dismissal clears its geometry before release, this
    // gesture remains owned by the keyboard and must not hide an image.
    document.documentElement.dataset.keyboardOpen = 'false';
    for (const type of ['pointermove', 'pointerup']) element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 63, isPrimary: true, button: 0, clientX: 120, clientY: 280 }));
    if (previous === undefined) delete document.documentElement.dataset.keyboardOpen; else document.documentElement.dataset.keyboardOpen = previous;
    return { clear: element.dataset.revealed === 'true', reset: getComputedStyle(element.closest('.message-bubble')).transform === 'none' };
  });
  assert.deepEqual(keyboardPriority, { clear: true, reset: true }, 'A keyboard-owned downward gesture also dragged or concealed the media');
  await page.locator('.image-album .image-preview').first().click();
  await assertVisibility(4, 2, 'Album cell reveal');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'First album cell tap opened a viewer');

  // A deliberate pull conceals all thumbnails, including those outside the
  // gesture target; the browser's subsequent synthesized click stays inert.
  await drag(first, { dx: 12 });
  await assertVisibility(4, 2, 'Small touch movement');
  await drag(first, { dx: 0, dy: 80 });
  await assertVisibility(4, 2, 'Downward scrolling preserves visibility');
  await drag(first, { dx: 24, followingClick: true });
  await assertVisibility(4, 0, 'Pointer pull and synthesized click');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'A pull opened the viewer');
  await waitForClicks();
  await first.click();
  await previews.nth(1).click();
  const touchFeedback = await drag(previews.nth(1), { touch: true, followingClick: true });
  assert(touchFeedback.scrollReserved && touchFeedback.clearDuringTouch && touchFeedback.displaced > 10 && touchFeedback.displaced < 60, 'The touch-owned pull concealed before release or failed to move the clear thumbnail with damping');
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
  const pendingBox = await delayed.boundingBox();
  await assertVisibility(5, 1, 'New pending thumbnail');
  await delayed.evaluate(element => {
    window.chatPrivacy.loadingFeedback = [element.querySelector('.media-load-status')?.textContent];
    new MutationObserver(() => window.chatPrivacy.loadingFeedback.push(element.querySelector('.media-load-status')?.textContent))
      .observe(element, { attributes: true, childList: true, subtree: true });
  });
  await delayed.click();
  await assertVisibility(5, 1, 'Tap while downloading does not reveal unverified media');
  assert.match(await delayed.locator('.media-load-status').textContent(), /^正在下载图片 \d+%$/, 'Pending thumbnail did not explain its download state');
  assert.equal(await delayed.getAttribute('aria-busy'), 'true', 'Pending thumbnail was not exposed as busy');
  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    await delayed.screenshot({ path: path.join(visualQaDirectory, `chat-image-loading-${browserName}-390.png`), animations: 'disabled' });
  }
  await drag(first, { followingClick: true });
  await page.evaluate(() => { const gate = window.chatPrivacy.gate; gate.blobId = null; gate.release(); });
  await delayed.locator('img').waitFor();
  const loadedBox = await delayed.boundingBox();
  assert(pendingBox && loadedBox && Math.abs(pendingBox.width - loadedBox.width) < 1 && Math.abs(pendingBox.height - loadedBox.height) < 1,
    `Known media dimensions shifted the placeholder: ${JSON.stringify({ pendingBox, loadedBox })}`);
  await assertVisibility(5, 0, 'Pull before delayed decryption resolves');
  const loadingFeedback = await page.evaluate(() => window.chatPrivacy.loadingFeedback.filter(Boolean));
  assert(loadingFeedback.some(value => value.startsWith('正在下载图片')), 'Loading feedback omitted the download stage');
  assert(loadingFeedback.some(value => value.startsWith('正在解密图片')), 'Loading feedback omitted the decrypt stage');
  assert(loadingFeedback.includes('正在生成模糊预览'), 'Loading feedback omitted the verified preview stage');
  await waitForClicks();
  await delayed.click();
  await delayed.click();
  await page.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  await drag(page.locator('.viewer-stage'), { dx: 0, dy: 150 });
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  await assertVisibility(5, 0, 'Viewer downward dismissal');
  await waitForClicks();

  await delayed.click();
  const transient = await page.evaluate(() => {
    const f = window.chatPrivacy;
    const element = [...document.querySelectorAll('.message .image-preview')].find(preview => preview.dataset.revealed === 'true');
    const bubble = element.closest('.message-bubble');
    for (const [type, y] of [['pointerdown', 200], ['pointermove', 280]]) element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 64, isPrimary: true, button: 0, clientX: y, clientY: 200 }));
    window.dispatchEvent(new Event('blur'));
    const buttons = [...document.querySelectorAll('.message .image-preview')];
    const immediatelyHidden = buttons.length === 5 && buttons.every(button => button.dataset.revealed === 'false'
      && (!button.querySelector('img') || Number(getComputedStyle(button.querySelector('img')).opacity) === 0));
    const curtainVisible = getComputedStyle(document.querySelector('.privacy-curtain')).visibility === 'visible';
    window.dispatchEvent(new Event('focus'));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 64, isPrimary: true, button: 0, clientX: 120, clientY: 280 }));
    return { immediatelyHidden, curtainVisible, unlockedAfterFocus: !f.app.privacyCovered, gestureReleased: getComputedStyle(bubble).transform === 'none' && bubble.getAnimations().length === 0 };
  });
  assert.deepEqual(transient, { immediatelyHidden: true, curtainVisible: true, unlockedAfterFocus: true, gestureReleased: true }, 'Transient privacy cover did not conceal thumbnails and release active pull motion synchronously');
  await assertVisibility(5, 0, 'Rapid foreground restoration');
  await page.waitForTimeout(300);
  await assertVisibility(5, 0, 'After blur debounce');
  await waitForClicks(); await delayed.click();
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
  // Actual encrypted outbox: hidden/away media cannot acknowledge reading.
  await originalRow.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const app = window.chatPrivacy.app;
    app.session.vault.members.forEach(member => member.capabilities.push('media-read-v1'));
    app.chatRestoreAnchor = null;
    app.markVisibleMessagesRead();
  });
  assert.equal(await page.evaluate(() => window.chatPrivacy.app.mediaReadQueued.size), 0, 'Blurred media emitted read intent');
  await page.evaluate(id => {
    const app = window.chatPrivacy.app;
    const preview = document.querySelector(`[data-client-msg-id="${id}"] .image-preview`);
    app.chatRevealedAssets.add(preview.dataset.revealKey);
    app.updateChatImageVisibility(preview);
    app.activeSurface = 'away';
    app.markVisibleMessagesRead();
  }, repeatedIds.original);
  assert.equal(await page.evaluate(() => window.chatPrivacy.app.mediaReadQueued.size), 0, 'Away surface emitted read intent');
  await page.evaluate(() => { const app = window.chatPrivacy.app; app.activeSurface = 'chat'; app.markVisibleMessagesRead(); });
  await page.waitForFunction(() => [...window.chatPrivacy.app.outbox.values()].some(item => item.payload.kind === 'media-read'));
  const readOutbox = await page.evaluate(async id => {
    const f = window.chatPrivacy;
    f.app.markVisibleMessagesRead();
    const items = (await f.vault.loadOutbox(f.session)).filter(item => item.payload.kind === 'media-read' && item.payload.target.clientMsgId === id);
    return { count: items.length, seq: items[0]?.payload.target.serverSeq, visibleRows: document.querySelectorAll('.message').length };
  }, repeatedIds.original);
  assert.deepEqual(readOutbox, { count: 1, seq: 1, visibleRows: 6 }, 'Visible-media read was not saved once in the encrypted outbox without a chat row');
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
    const concealedUrls = [...app.imageCache.values()].map(cached => cached.concealedUrl).filter(Boolean);
    const revoke = URL.revokeObjectURL;
    const revoked = [];
    URL.revokeObjectURL = url => { revoked.push(url); revoke.call(URL, url); };
    app.cleanupRuntime();
    URL.revokeObjectURL = revoke;
    image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 195, clientY: 422 }));
    return { cleanupReleased: app.viewerGestureCleanup === null && app.chatImageConcealGesture === null, detached: !stage.isConnected, staleGestureIgnored: image.style.transform === before,
      concealedUrlsRevoked: concealedUrls.length > 0 && concealedUrls.every(url => revoked.includes(url)) };
  });
  assert.deepEqual(directCleanup, { cleanupReleased: true, detached: true, staleGestureIgnored: true, concealedUrlsRevoked: true }, 'Direct runtime teardown retained a viewer gesture closure or concealed bitmap');
  await page.evaluate(async () => {
    const f = window.chatPrivacy;
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      return encode.call(this, blob => {
        if (!f.concealedEncodeGate) f.concealedEncodeGate = { release: () => callback(blob) };
        else callback(blob);
      }, ...args);
    };
    f.restoreEncoder = () => { HTMLCanvasElement.prototype.toBlob = encode; };
    await f.reopen();
  });
  await page.waitForFunction(() => window.chatPrivacy.concealedEncodeGate);
  const lateEncoding = await page.evaluate(async () => {
    const f = window.chatPrivacy;
    const pending = [...f.app.imageCache.values()].map(cached => cached.concealedPromise).filter(Boolean);
    f.app.lockNow();
    const create = URL.createObjectURL;
    let created = 0;
    URL.createObjectURL = blob => { created++; return create.call(URL, blob); };
    f.concealedEncodeGate.release();
    await Promise.allSettled(pending);
    URL.createObjectURL = create;
    f.restoreEncoder();
    return { hadPending: pending.length > 0, created, cache: f.app.imageCache.size, chat: Boolean(document.querySelector('.chat-shell')) };
  });
  assert.deepEqual(lateEncoding, { hadPending: true, created: 0, cache: 0, chat: false }, 'Late concealed PNG encoding revived a locked runtime');
  await page.evaluate(() => window.chatPrivacy.app.lockNow());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browserName, defaultHidden: true, cachedBlurReused: true, longHoldReleaseHidden: true, revealThenView: true, albumCells: true, pointerAndTouchPull: true, dampedClearPullUntilRelease: true, cancelledPullReleased: true, keyboardGesturePriority: true, dragClickSuppressed: true, cachedRebuildHidden: true, reusedManifestIsolated: true, revealedReceiptRebuildPreserved: true, delayedDecodeHidden: true, viewerPullHidden: true, synchronousCoverHidden: true, rapidFocusHidden: true, lockAndReentryHidden: true, originalBytesPreserved: true }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
