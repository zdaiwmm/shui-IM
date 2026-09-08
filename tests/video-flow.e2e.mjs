import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Use real encrypted attachment bytes, encrypted local history and the mounted
// chat/gallery listeners. Only the opaque chunk service and unrelated account
// controls are replaced. MLS transport is covered by the paired-device suite.
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
const visualQaDirectory = process.argv[2];
server.middlewares.use('/__video_flow', (_request, response) => {
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
  await page.goto(`http://localhost:${server.httpServer.address().port}/__video_flow`);
  const ids = await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/gallery.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    await import('/src/call.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const { encryptFileAttachment, encryptImageFile } = await import('/src/lib/file-crypto.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    const capabilities = ['image-album-v1', 'file-message-v1', 'reply-v2', 'message-reactions-v1'];
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities };
    const peer = { deviceId: crypto.randomUUID(), role: 'joiner', status: 'active', capabilities };
    const session = await vault.createVault({
      v: 1, roomId: crypto.randomUUID(), accessToken: 'video-flow-test', role: 'creator', protocol: 'legacy-v1',
      lastSeq: 5, members: [own, peer], identity: { publicBundle: own },
    }, 'video-flow-passphrase', 'password');
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.flushUiPreferencesSave = () => {};
    app.unreadCounter.markRead = async () => {};
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });

    // A genuine browser-generated, decodable video with no external fixture,
    // camera, microphone, production content or codec-tool dependency.
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    const draw = frame => {
      context.fillStyle = '#7295a2'; context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#f4d89a'; context.beginPath(); context.arc(248, 40, 19, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#455f65'; context.beginPath(); context.moveTo(0, 154); context.lineTo(92, 54); context.lineTo(196, 162); context.lineTo(270, 94); context.lineTo(320, 153); context.lineTo(320, 180); context.lineTo(0, 180); context.fill();
      context.fillStyle = '#a6bbb0'; context.fillRect(0, 150, 320, 30);
      context.fillStyle = '#f2efdc'; context.fillRect(18 + frame * 3, 163, 30, 3);
    };
    draw(0);
    const mediaStream = canvas.captureStream(20);
    const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw Error('This browser cannot generate the video regression fixture');
    const chunks = [];
    const recorder = new MediaRecorder(mediaStream, { mimeType });
    const recorded = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: 'video/webm' })), { once: true });
      recorder.addEventListener('error', event => reject(event.error ?? Error('Fixture recording failed')), { once: true });
    });
    recorder.start();
    for (let frame = 0; frame < 30; frame++) {
      draw(frame);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    recorder.stop();
    const videoBlob = await recorded;
    mediaStream.getTracks().forEach(track => track.stop());
    if (!videoBlob.size) throw Error('Video fixture contains no original bytes');

    const encryptedChunks = new Map();
    const originals = new Map();
    const encrypt = async (file, image = false) => {
      const manifest = await (image ? encryptImageFile : encryptFileAttachment)(file, {
        reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
        upload: async (blobId, index, bytes) => { encryptedChunks.set(`${blobId}:${index}`, bytes.slice()); },
        complete: async () => {}, savePlan: async () => {},
      });
      originals.set(manifest.blobId, file);
      return manifest;
    };
    const photo = await encrypt(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><path fill="#9caf9b" d="M0 0h320v180H0z"/><circle fill="#eadbb7" cx="248" cy="42" r="20"/><path fill="#526c61" d="M0 180 105 40 240 180Z"/></svg>'], '照片.svg', { type: 'image/svg+xml', lastModified: 1 }), true);
    const chatVideo = await encrypt(new File([videoBlob], '聊天视频.webm', { type: 'video/webm', lastModified: 2 }));
    const chatDocument = await encrypt(new File(['video regression ordinary file\n'], '普通文件.txt', { type: 'text/plain', lastModified: 3 }));
    const galleryVideo = await encrypt(new File([videoBlob], '保险箱视频.webm', { type: '', lastModified: 4 }));
    const galleryDocument = await encrypt(new File(['video regression gallery file\n'], '保险箱文档.txt', { type: 'text/plain', lastModified: 5 }));
    const restoredVideo = await encrypt(new File([videoBlob], '单独恢复的视频.webm', { type: 'video/webm', lastModified: 6 }));
    const delayedVideo = await encrypt(new File([videoBlob], '迟到的视频.webm', { type: 'video/webm', lastModified: 7 }));
    const sentAt = '2026-09-04T10:00:00.000Z';
    const message = (seq, kind, manifest, senderId = own.deviceId) => ({
      seq, clientMsgId: crypto.randomUUID(), senderId,
      payload: { v: 1, kind, [kind === 'image' ? 'image' : 'file']: manifest, sentAt },
      acceptedAt: sentAt, status: 'delivered',
    });
    const records = [message(1, 'image', photo), message(2, 'file', chatVideo, peer.deviceId), message(3, 'file', chatDocument), message(4, 'gallery-file', galleryVideo), message(5, 'gallery-file', galleryDocument)];
    const restored = message(30, 'file', restoredVideo, peer.deviceId);
    const delayed = message(31, 'file', delayedVideo, peer.deviceId);
    for (const record of records) await vault.saveHistoryMessage(session, record);

    const requests = { reads: 0 };
    const readGate = { blobId: null, waiting: false, release: null };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const match = url.pathname.match(/\/blobs\/([^/]+)\/chunks\/(\d+)$/);
      const encrypted = match && encryptedChunks.get(`${match[1]}:${match[2]}`);
      if (!encrypted) return realFetch(input, init);
      requests.reads++;
      if (match[1] === readGate.blobId) {
        readGate.waiting = true;
        await new Promise(resolve => { readGate.release = resolve; });
      }
      init.signal?.throwIfAborted();
      return new Response(encrypted);
    };
    const createdUrls = new Set();
    const revokedUrls = new Set();
    const createUrl = URL.createObjectURL.bind(URL);
    const revokeUrl = URL.revokeObjectURL.bind(URL);
    // Document export URLs intentionally have their own delayed browser cleanup;
    // this assertion tracks image/video originals and derived posters only.
    URL.createObjectURL = blob => { const url = createUrl(blob); if (/^(?:image|video)\//.test(blob.type)) createdUrls.add(url); return url; };
    URL.revokeObjectURL = url => { revokedUrls.add(url); revokeUrl(url); };
    const reopen = async (destination = 'chat') => {
      app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
      app.pending = new Map();
      app.messages = new Map((await vault.loadHistoryPage(session)).map(record => [record.seq, record]));
      app.uiPreferences = {}; app.restoreChatAnchorOnNextRender = false;
      if (destination === 'gallery') app.renderGallery(); else app.renderChat();
    };
    window.videoFlow = { app, root, session, vault, originals, records, restored, delayed, requests, readGate, createdUrls, revokedUrls, reopen, manifests: { photo, chatVideo, chatDocument, galleryVideo, galleryDocument, restoredVideo, delayedVideo } };
    await reopen();
    return Object.fromEntries(Object.entries(window.videoFlow.manifests).map(([name, manifest]) => [name, manifest.blobId]));
  });

  const capture = async name => {
    if (!visualQaDirectory) return;
    await mkdir(visualQaDirectory, { recursive: true });
    await page.screenshot({ path: path.join(visualQaDirectory, `${name}.png`), fullPage: true, animations: 'disabled' });
  };
  const awaitPlayingVideo = async () => {
    await page.waitForFunction(() => {
      const video = document.querySelector('.image-viewer.is-visible .viewer-stage video');
      return video && video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 0.05 && !video.paused;
    });
    return page.locator('.image-viewer .viewer-stage video');
  };
  const rememberPlayer = async () => page.evaluate(() => {
    window.videoFlow.previousPlayer = document.querySelector('.image-viewer .viewer-stage video');
    const video = window.videoFlow.previousPlayer;
    return { controls: video.controls, autoplay: video.autoplay, playsInline: video.playsInline, width: video.videoWidth, height: video.videoHeight };
  });
  const assertPlayerReleased = async reason => {
    const released = await page.evaluate(() => {
      const video = window.videoFlow.previousPlayer;
      return { paused: video.paused, src: video.getAttribute('src'), connected: video.isConnected, mediaObject: video.srcObject };
    });
    assert.deepEqual(released, { paused: true, src: null, connected: false, mediaObject: null }, `${reason}: the detached video retained playback resources`);
  };
  const closePlayer = async () => {
    if (await page.evaluate(() => Boolean(document.fullscreenElement))) {
      await page.evaluate(() => document.exitFullscreen());
    } else await page.locator('[data-viewer-close]').click();
    await page.locator('.image-viewer').waitFor({ state: 'detached' });
  };
  const openInReader = async locator => {
    const waiting = page.waitForEvent('popup');
    await locator.click();
    const reader = await waiting;
    await reader.waitForURL('blob:**', { timeout: 5_000 });
    assert(reader.url().startsWith('blob:'), 'Verified document did not open through a system reader');
    await reader.close();
  };

  const chatPreview = page.locator(`.message .image-preview.video-preview[data-blob-id="${ids.chatVideo}"]`);
  await chatPreview.locator('img').waitFor();
  await chatPreview.locator('img').evaluate(image => image.decode());
  assert.equal(await chatPreview.getAttribute('data-revealed'), 'false', 'Chat video poster was visible before an explicit reveal');
  assert(await chatPreview.locator('img').evaluate(image => Number(getComputedStyle(image).opacity) === 0
    && getComputedStyle(image.parentElement, '::before').backgroundImage !== 'none'), 'Chat video poster did not use the concealed bitmap');
  assert.equal(await chatPreview.locator('.video-play').count(), 1, 'Chat video has no visible play affordance');
  assert.equal(await page.locator('.message video').count(), 0, 'Chat preview started an inline video player before a click');
  assert.equal(await page.locator('.message').count(), 3, 'Gallery-only items leaked into chat');
  assert.equal(downloadCount, 0, 'Loading a video preview downloaded an exported file');
  const originalVerification = await page.evaluate(async () => {
    const f = window.videoFlow;
    const manifest = f.manifests.chatVideo;
    const cached = f.app.imageCache.get(manifest.blobId);
    const original = new Uint8Array(await f.originals.get(manifest.blobId).arrayBuffer());
    const restored = new Uint8Array(await cached.blob.arrayBuffer());
    const preview = document.querySelector(`.video-preview[data-blob-id="${manifest.blobId}"] img`);
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); context.drawImage(preview, 0, 0, 320, 180);
    const [red, green, blue] = context.getImageData(16, 16, 1, 1).data;
    return { identical: original.length === restored.length && original.every((byte, index) => byte === restored[index]), poster: Boolean(cached.posterUrl), originalAndPosterDiffer: cached.url !== cached.posterUrl, visibleFrame: red > 40 && green > 40 && blue > 40, sampledPixel: [red, green, blue] };
  });
  assert.deepEqual({ ...originalVerification, sampledPixel: undefined }, { identical: true, poster: true, originalAndPosterDiffer: true, visibleFrame: true, sampledPixel: undefined }, `Video poster generation changed the original bytes or failed to capture a visible frame: ${originalVerification.sampledPixel.join(',')}`);
  const readsBeforeRuntimeReactivation = await page.evaluate(() => window.videoFlow.requests.reads);
  await page.evaluate(async () => {
    const f = window.videoFlow;
    f.app.cleanupRuntime(false);
    await f.reopen();
  });
  await chatPreview.locator('img').waitFor();
  await chatPreview.locator('img').evaluate(image => image.decode());
  assert.equal(await page.evaluate(() => window.videoFlow.requests.reads), readsBeforeRuntimeReactivation,
    'Re-entering chat re-downloaded media instead of reconstructing it from authenticated local ciphertext');
  await capture('video-chat-390');
  await chatPreview.dispatchEvent('pointerdown', { button: 0, pointerType: 'touch', clientX: 120, clientY: 260 });
  await page.locator('.message-actions.is-visible').waitFor();
  await chatPreview.evaluate(element => {
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch' }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  assert.equal(await page.locator('.image-viewer').count(), 0, 'Releasing a long press accidentally played the chat video');
  assert.equal(downloadCount, 0, 'Long-pressing the video exported a file');
  await page.evaluate(() => window.videoFlow.app.closeMessageActions(true, false));
  await page.waitForFunction(() => Date.now() >= window.videoFlow.app.suppressMediaClickUntil);
  await chatPreview.click();
  assert.equal(await chatPreview.getAttribute('data-revealed'), 'true', 'First chat video click did not reveal its poster');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'First chat video click played a still-hidden video');
  const videoPull = await chatPreview.evaluate(async element => {
    const bubble = element.closest('.message-bubble');
    const fire = (type, y) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 91, isPrimary: true, button: 0, clientX: 120, clientY: y }));
    fire('pointerdown', 240); fire('pointermove', 330);
    const clearAndMoving = element.dataset.revealed === 'true' && getComputedStyle(element.querySelector('img')).filter === 'none' && new DOMMatrix(getComputedStyle(bubble).transform).f > 20;
    fire('pointerup', 330);
    const hiddenOnRelease = element.dataset.revealed === 'false';
    await Promise.all(bubble.getAnimations().map(animation => animation.finished));
    return { clearAndMoving, hiddenOnRelease, reset: getComputedStyle(bubble).transform === 'none' };
  });
  assert.deepEqual(videoPull, { clearAndMoving: true, hiddenOnRelease: true, reset: true }, 'Video poster did not share the image pull privacy behavior');
  await page.waitForFunction(() => Date.now() >= window.videoFlow.app.suppressMediaClickUntil);
  await chatPreview.click();
  await chatPreview.click();
  await awaitPlayingVideo();
  await page.waitForFunction(() => document.fullscreenElement === document.querySelector('.viewer-stage video'));
  assert.equal(await page.locator('[data-viewer-close]').isVisible(), false, 'A custom viewer header appeared before the native full-screen player');
  const player = await rememberPlayer();
  assert.deepEqual(player, { controls: true, autoplay: true, playsInline: true, width: 320, height: 180 }, 'Video did not open as an accessible, automatically playing viewer');
  const viewerBounds = await page.locator('.image-viewer').evaluate(viewer => {
    const rect = viewer.getBoundingClientRect();
    return { fixed: getComputedStyle(viewer).position === 'fixed', fillsViewport: rect.left <= 1 && rect.top <= 1 && rect.right >= innerWidth - 1 && rect.bottom >= innerHeight - 1 };
  });
  assert.deepEqual(viewerBounds, { fixed: true, fillsViewport: true }, 'Playing the video did not maximize the viewing surface');
  await capture('video-viewer-390');
  const readsBeforeClose = await page.evaluate(() => window.videoFlow.requests.reads);
  await closePlayer();
  await assertPlayerReleased('Native full-screen exit');

  // A denied native request keeps a playable native-controls fallback, without
  // exporting or re-fetching the already integrity-checked original.
  await page.evaluate(() => {
    window.videoFlow.nativeFullscreen = HTMLVideoElement.prototype.requestFullscreen;
    window.videoFlow.nativeAttempts = 0;
    HTMLVideoElement.prototype.requestFullscreen = function () {
      window.videoFlow.nativeAttempts++;
      return Promise.reject(new DOMException('Synthetic full-screen denial', 'NotAllowedError'));
    };
  });
  await chatPreview.click();
  await awaitPlayingVideo();
  await page.locator('.image-viewer:not([data-native-video]) [data-viewer-close]').waitFor();
  assert.equal(await page.evaluate(() => window.videoFlow.nativeAttempts), 1, 'Opening the fallback did not first request the native player');
  await rememberPlayer();
  await closePlayer();
  await assertPlayerReleased('Rejected full-screen fallback close');
  await page.evaluate(() => { HTMLVideoElement.prototype.requestFullscreen = window.videoFlow.nativeFullscreen; });

  // The Safari-only entry point takes precedence over element fullscreen. This
  // validates the event/cleanup contract, not an iPhone system UI simulation.
  await page.evaluate(() => {
    const f = window.videoFlow;
    f.webkitAttempts = 0;
    HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
      f.webkitAttempts++;
      this.webkitDisplayingFullscreen = true;
      this.dispatchEvent(new Event('webkitbeginfullscreen'));
    };
    HTMLVideoElement.prototype.webkitExitFullscreen = function () {
      this.webkitDisplayingFullscreen = false;
      this.dispatchEvent(new Event('webkitendfullscreen'));
    };
  });
  await chatPreview.click();
  await awaitPlayingVideo();
  await rememberPlayer();
  assert.equal(await page.evaluate(() => window.videoFlow.webkitAttempts), 1, 'Safari video did not directly request its system player');
  assert.equal(await page.locator('.viewer-stage video').getAttribute('playsinline'), null, 'Safari was forced to show an inline player first');
  assert.deepEqual(await page.locator('.image-viewer').evaluate(viewer => ({
    nativeState: viewer.dataset.nativeVideo,
    headerVisibility: getComputedStyle(viewer.querySelector('.viewer-header')).visibility,
  })), { nativeState: 'active', headerVisibility: 'hidden' },
  'A synchronous Safari native-player entry lost its active gate or flashed the custom header');
  await page.evaluate(() => document.querySelector('.viewer-stage video').webkitExitFullscreen());
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  await assertPlayerReleased('Safari system player Done');
  await page.evaluate(() => {
    delete HTMLVideoElement.prototype.webkitEnterFullscreen;
    delete HTMLVideoElement.prototype.webkitExitFullscreen;
  });

  // Fullscreen completion can arrive after Escape has begun closing the DOM.
  // Emulate that native timing explicitly and require the late entry to exit.
  await page.evaluate(() => {
    const f = window.videoFlow;
    f.nativeExit = document.exitFullscreen;
    f.lateFullscreen = null;
    f.lateExitCount = 0;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => f.lateFullscreen });
    document.exitFullscreen = () => { f.lateFullscreen = null; f.lateExitCount++; return Promise.resolve(); };
    HTMLVideoElement.prototype.requestFullscreen = function () {
      return new Promise(resolve => { f.resolveLateNative = () => { f.lateFullscreen = this; resolve(); }; });
    };
  });
  await chatPreview.click();
  await awaitPlayingVideo();
  await rememberPlayer();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.videoFlow.resolveLateNative());
  await page.waitForFunction(() => window.videoFlow.lateExitCount === 1 && document.fullscreenElement === null);
  await page.locator('.image-viewer').waitFor({ state: 'detached' });
  await assertPlayerReleased('Late native full-screen entry after Escape');
  await page.evaluate(() => {
    delete document.fullscreenElement;
    document.exitFullscreen = window.videoFlow.nativeExit;
    HTMLVideoElement.prototype.requestFullscreen = window.videoFlow.nativeFullscreen;
  });
  await chatPreview.click();
  await awaitPlayingVideo();
  assert.equal(await page.evaluate(() => window.videoFlow.requests.reads), readsBeforeClose, 'Reopening a video failed to reuse the verified original cache');
  await rememberPlayer();
  await page.evaluate(() => {
    window.videoFlow.app.updateCallView({ phase: 'incoming', callId: 'video-flow-incoming', kind: 'video', peerName: '对方', localStream: null, remoteStream: null, micMuted: false, cameraEnabled: false, remoteVideoEnabled: false, remoteMuted: false, facingMode: 'user', startedAt: null, statusText: '邀请你视频通话', quality: 'good', canSwitchCamera: false });
  });
  await page.locator('.call-answer').waitFor();
  await assertPlayerReleased('Incoming call');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'Incoming call left the attachment player behind it');
  await page.evaluate(() => window.videoFlow.app.updateCallView({ phase: 'idle' }));
  await chatPreview.click();
  await awaitPlayingVideo();
  await rememberPlayer();
  await page.evaluate(() => window.videoFlow.app.lockNow());
  await assertPlayerReleased('Lock');
  const locked = await page.evaluate(() => {
    const f = window.videoFlow;
    return { covered: f.app.privacyCovered, cacheSize: f.app.imageCache.size, inFlightLoads: f.app.imageLoadPromises.size, mediaNodes: f.root.querySelectorAll('.image-viewer, .image-preview, video').length, allUrlsRevoked: [...f.createdUrls].every(url => f.revokedUrls.has(url)) };
  });
  assert.deepEqual(locked, { covered: true, cacheSize: 0, inFlightLoads: 0, mediaNodes: 0, allUrlsRevoked: true }, 'Lock retained video content, a poster URL or a decrypted original URL');

  await page.evaluate(() => window.videoFlow.reopen());
  await openInReader(page.locator(`.message .file-attachment[data-blob-id="${ids.chatDocument}"]`));
  assert.equal(await page.locator('.image-viewer').count(), 0, 'An ordinary document opened a media preview');

  // Clear the currently mounted message page: the gallery must discover chat
  // videos through encrypted local media history, not just live chat memory.
  await page.evaluate(() => { window.videoFlow.app.messages.clear(); });
  await page.locator('#open-gallery').click();
  await page.waitForFunction(() => document.querySelectorAll('.gallery-tile').length === 3 && [...document.querySelectorAll('.gallery-tile img')].every(image => image.complete && image.naturalWidth > 0) && document.querySelectorAll('.gallery-tile img').length === 3);
  assert.equal((await page.locator('#gallery-tab-images > span').first().textContent()).trim(), '相册', 'The safe media category was not renamed to 相册');
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(), '3', 'Album did not count both photos and videos');
  assert.equal(await page.locator('.gallery-tile .video-play').count(), 2, 'Chat videos or gallery-only videos are missing from the album');
  assert.equal(await page.locator('.gallery-file').count(), 0, 'File cards appeared on the album tab');
  assert(await page.locator('.gallery-tile').evaluateAll(tiles => tiles.every(tile => tile.dataset.revealed === 'false' && getComputedStyle(tile.querySelector('img')).filter.includes('blur('))), 'A photo or video bypassed the default safe blur');
  await capture('video-album-hidden-390');
  const safeVideo = page.locator(`.gallery-tile[data-blob-id="${ids.galleryVideo}"]`);
  await safeVideo.click();
  assert.equal(await safeVideo.getAttribute('data-revealed'), 'true', 'First album click did not reveal the video poster');
  assert.equal(await page.locator('.image-viewer').count(), 0, 'First album click played a still-hidden video');
  await safeVideo.click();
  await awaitPlayingVideo();
  await rememberPlayer();
  assert.equal(await page.locator('[data-viewer-time]').getAttribute('datetime'), '2026-09-04T10:00:00.000Z', 'Video viewer lost the message/upload timestamp');
  await closePlayer();
  await assertPlayerReleased('Album close');
  assert.equal(await safeVideo.getAttribute('data-revealed'), 'true', 'Closing the viewer reset this visit’s reveal state');

  // Mixed media paging keeps the chrome mounted. An image-to-video page must
  // arrive paused, and that paused inline video must still yield the next
  // horizontal gesture back to an image.
  const safePhoto = page.locator(`.gallery-tile[data-blob-id="${ids.photo}"]`);
  await safePhoto.click();
  await safePhoto.click();
  await page.locator('.image-viewer.is-visible .viewer-stage img').waitFor();
  const readsBeforeMixedPaging = await page.evaluate(() => window.videoFlow.requests.reads);
  const imageSwipeChrome = await page.locator('.viewer-stage').evaluate(stage => {
    const fire = (type, x) => stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 211, isPrimary: true, button: 0, clientX: x, clientY: 430 }));
    fire('pointerdown', 320); fire('pointermove', 190);
    const header = stage.closest('.image-viewer').querySelector('.viewer-header');
    const media = stage.querySelector('img');
    const residualBeforeRelease = new DOMMatrix(getComputedStyle(media).transform).e;
    const state = {
      opacity: getComputedStyle(header).opacity,
      name: header.querySelector('[data-viewer-name]').textContent,
      paging: stage.closest('.image-viewer').classList.contains('is-paging'),
      backdropChanged: stage.closest('.image-viewer').style.getPropertyValue('--viewer-backdrop-opacity') !== '',
    };
    fire('pointerup', 190);
    const outgoingLayer = media.closest('.viewer-media-layer');
    const transferredOffset = new DOMMatrix(getComputedStyle(outgoingLayer).transform).e
      + new DOMMatrix(getComputedStyle(media).transform).e;
    return { ...state, continuousTransfer: Math.abs(transferredOffset - residualBeforeRelease) <= 1 };
  });
  assert.deepEqual(imageSwipeChrome, { opacity: '1', name: '照片.svg', paging: true, backdropChanged: false, continuousTransfer: true }, 'Horizontal image paging flashed, dimmed, or snapped during the residual-offset handoff');
  await page.waitForFunction(name => document.querySelector('[data-viewer-name]')?.textContent === name && document.querySelector('.viewer-stage video'), '保险箱视频.webm');
  const pausedArrival = await page.locator('.viewer-stage video').evaluate(video => ({ paused: video.paused, autoplay: video.autoplay, controls: video.controls }));
  assert.deepEqual(pausedArrival, { paused: true, autoplay: false, controls: true }, 'A video reached by paging started playback or lost native controls');
  const pagedVideoGeometry = await page.locator('.viewer-stage').evaluate(stage => {
    const layer = stage.querySelector('.viewer-media-layer.is-video');
    const video = layer?.querySelector('video');
    const stageRect = stage.getBoundingClientRect();
    const layerRect = layer?.getBoundingClientRect();
    const videoRect = video?.getBoundingClientRect();
    return {
      layerFillsStage: Boolean(layerRect && Math.abs(layerRect.left - stageRect.left) <= 1 && Math.abs(layerRect.top - stageRect.top) <= 1
        && Math.abs(layerRect.right - stageRect.right) <= 1 && Math.abs(layerRect.bottom - stageRect.bottom) <= 1),
      videoFillsLayer: Boolean(layerRect && videoRect && Math.abs(videoRect.left - layerRect.left) <= 1 && Math.abs(videoRect.top - layerRect.top) <= 1
        && Math.abs(videoRect.right - layerRect.right) <= 1 && Math.abs(videoRect.bottom - layerRect.bottom) <= 1),
    };
  });
  assert.deepEqual(pagedVideoGeometry, { layerFillsStage: true, videoFillsLayer: true }, 'Paged video did not occupy the same full viewer container as a photo');
  assert.equal(await page.evaluate(() => window.videoFlow.requests.reads), readsBeforeMixedPaging, 'Image-to-video paging re-fetched an already verified attachment');
  await page.locator('.viewer-stage video').evaluate(video => video.play());
  await page.waitForFunction(() => {
    const video = document.querySelector('.viewer-stage video');
    return video && !video.paused && video.currentTime > 0;
  });
  await page.evaluate(async () => {
    const f = window.videoFlow;
    const manifest = f.manifests.photo;
    const cached = f.app.imageCache.get(manifest.blobId);
    if (!cached) throw Error('The mixed-media photo was not cached before the delayed paging regression');
    URL.revokeObjectURL(cached.url);
    if (cached.posterUrl) URL.revokeObjectURL(cached.posterUrl);
    if (cached.concealedUrl) URL.revokeObjectURL(cached.concealedUrl);
    f.app.imageCache.delete(manifest.blobId);
    f.app.imageCacheBytes -= cached.bytes;
    await f.vault.deleteCachedMediaBlob(f.session, manifest.blobId);
    f.readGate.blobId = manifest.blobId;
    f.readGate.waiting = false;
    f.readGate.release = null;
  });
  const videoSwipeChrome = await page.locator('.viewer-stage').evaluate(stage => {
    const video = stage.querySelector('video');
    window.videoFlow.pagedPlayer = video;
    const fire = (type, x) => video.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 212, isPrimary: true, button: 0, clientX: x, clientY: 430 }));
    fire('pointerdown', 70); fire('pointermove', 210);
    const header = stage.closest('.image-viewer').querySelector('.viewer-header');
    const state = { opacity: getComputedStyle(header).opacity, paging: stage.closest('.image-viewer').classList.contains('is-paging') };
    fire('pointerup', 210);
    return state;
  });
  assert.deepEqual(videoSwipeChrome, { opacity: '1', paging: true }, 'Paused video did not page horizontally with stable chrome');
  await page.waitForFunction(() => window.videoFlow.readGate.waiting);
  assert.deepEqual(await page.locator('.image-viewer').evaluate(viewer => {
    const video = viewer.querySelector('.viewer-stage video');
    return {
      pausedImmediately: video?.paused,
      transitioning: viewer.classList.contains('is-transitioning'),
      busy: viewer.querySelector('.viewer-stage')?.getAttribute('aria-busy'),
      headerOpacity: getComputedStyle(viewer.querySelector('.viewer-header')).opacity,
      name: viewer.querySelector('[data-viewer-name]')?.textContent,
    };
  }), { pausedImmediately: true, transitioning: true, busy: 'true', headerOpacity: '1', name: '保险箱视频.webm' },
  'Paging toward a slow image left the old video playing or changed the persistent header before commit');
  await page.evaluate(() => {
    const gate = window.videoFlow.readGate;
    gate.blobId = null;
    gate.release();
  });
  await page.waitForFunction(() => document.querySelectorAll('.image-viewer.is-transitioning .viewer-media-layer').length === 2);
  assert.deepEqual(await page.locator('.image-viewer').evaluate(viewer => ({
    layers: [...viewer.querySelectorAll('.viewer-media-layer')].map(layer => ({
      inert: layer.inert,
      hidden: layer.getAttribute('aria-hidden'),
    })),
    incomingDecoded: (() => {
      const image = viewer.querySelector('.viewer-media-layer:last-child img');
      return Boolean(image?.complete && image.naturalWidth > 0);
    })(),
  })), {
    layers: [{ inert: true, hidden: 'true' }, { inert: true, hidden: 'true' }],
    incomingDecoded: true,
  }, 'Transition layers exposed controls/focus or mounted an undecoded incoming image');
  await page.waitForFunction(name => document.querySelector('[data-viewer-name]')?.textContent === name && document.querySelector('.viewer-stage img'), '照片.svg');
  const releasedPagedVideo = await page.evaluate(() => {
    const video = window.videoFlow.pagedPlayer;
    return { paused: video.paused, src: video.getAttribute('src'), connected: video.isConnected };
  });
  assert.deepEqual(releasedPagedVideo, { paused: true, src: null, connected: false }, 'Paging away retained the old video decoder or source');
  assert((await page.evaluate(() => window.videoFlow.requests.reads)) > readsBeforeMixedPaging, 'The delayed mixed-media regression never exercised a real encrypted refetch');
  await closePlayer();

  // A conflicting encrypted manifest must fail closed without leaving the
  // mounted viewer, navigation controls, or gesture state permanently busy.
  const errorsBeforeManifestConflict = errors.length;
  await page.evaluate(() => {
    const f = window.videoFlow;
    f.app.openImageViewer([
      f.manifests.photo,
      { ...f.manifests.photo, originalName: '冲突清单.svg' },
    ], 0);
  });
  await page.waitForFunction(() => document.querySelector('.image-viewer .viewer-stage img')
    && document.querySelector('.image-viewer .viewer-stage')?.getAttribute('aria-busy') === 'false');
  await page.locator('.viewer-next').evaluate(button => button.click());
  await page.waitForFunction(() => {
    const viewer = document.querySelector('.image-viewer');
    return viewer && viewer.querySelector('.viewer-stage')?.getAttribute('aria-busy') === 'false'
      && !viewer.classList.contains('is-transitioning');
  });
  assert.deepEqual(await page.locator('.image-viewer').evaluate(viewer => ({
    name: viewer.querySelector('[data-viewer-name]')?.textContent,
    index: viewer.querySelector('.viewer-media-layer')?.getAttribute('data-viewer-index'),
    previousDisabled: viewer.querySelector('.viewer-previous')?.disabled,
    nextDisabled: viewer.querySelector('.viewer-next')?.disabled,
    activeLayerInteractive: !viewer.querySelector('.viewer-media-layer')?.inert,
  })), {
    name: '照片.svg', index: '0', previousDisabled: false, nextDisabled: false, activeLayerInteractive: true,
  }, 'Manifest rejection changed the active page or left the viewer state locked');
  assert.equal(errors.length, errorsBeforeManifestConflict, 'Manifest rejection escaped as an unhandled page error');
  await closePlayer();

  await page.locator('#gallery-tab-files').click();
  await page.waitForFunction(() => document.querySelectorAll('.gallery-file').length === 2);
  assert.equal(await page.locator('.gallery-tile').count(), 0, 'Videos appeared in the file category');
  assert.equal(await page.locator('[data-gallery-count="files"]').textContent(), '2', 'A chat document was not projected into Safe or a video was counted as a generic file');
  await openInReader(page.locator('.gallery-file').filter({ hasText: '普通文件.txt' }));
  await page.locator('#gallery-tab-images').click();
  await safeVideo.waitFor();
  assert.equal(await safeVideo.getAttribute('data-revealed'), 'true', 'Switching categories reset this visit’s video reveal');
  await page.locator('#gallery-back').click();
  await page.locator('#open-gallery').click();
  await safeVideo.waitFor();
  assert.equal(await safeVideo.getAttribute('data-revealed'), 'false', 'Reentering the safe exposed a previously revealed video');

  // The restored-gallery store is intentionally separate from chat. Verify a
  // restored former chat video renders in the album without creating a local
  // chat/reply source or altering the device’s synchronization boundary.
  const restoredState = await page.evaluate(async () => {
    const f = window.videoFlow;
    const lastSeq = f.session.vault.lastSeq;
    const imported = await f.vault.importArchivedMessages(f.session, [f.restored], 'gallery');
    const chatRecord = await f.vault.loadHistoryMessage(f.session, f.restored.seq);
    f.app.renderGallery();
    return { imported, absentFromChat: chatRecord === null, cursorUnchanged: f.session.vault.lastSeq === lastSeq };
  });
  assert.deepEqual(restoredState, { imported: 1, absentFromChat: true, cursorUnchanged: true }, 'Independent video album restore violated the chat-history boundary');
  const restoredTile = page.locator(`.gallery-tile[data-blob-id="${ids.restoredVideo}"]`);
  await restoredTile.locator('img').waitFor();
  await restoredTile.locator('img').evaluate(image => image.decode());
  assert.equal(await page.locator('.gallery-tile').count(), 4, 'Restored chat video did not appear in the album');
  assert.equal(await restoredTile.getAttribute('data-revealed'), 'false', 'Restored video started revealed');
  await page.evaluate(() => window.videoFlow.reopen());
  assert.equal(await page.locator('.message').count(), 3, 'Restored album video became a chat message');
  assert.equal(await page.locator(`.message [data-blob-id="${ids.restoredVideo}"]`).count(), 0, 'Restored video preview leaked into chat');

  // A late chunk response must not repopulate either original or poster caches
  // after locking, even if the old preview element remains referenced by an
  // in-flight callback.
  await page.evaluate(() => {
    const f = window.videoFlow;
    f.app.lockNow();
    f.app.session = f.session; f.app.privacyCovered = false; f.app.runtimeEpoch++; f.app.runtimeAbort = new AbortController();
    f.app.pending = new Map(); f.app.messages = new Map([[f.delayed.seq, f.delayed]]);
    f.app.uiPreferences = {}; f.app.restoreChatAnchorOnNextRender = false;
    f.readGate.blobId = f.manifests.delayedVideo.blobId;
    f.app.renderChat();
  });
  await page.waitForFunction(() => window.videoFlow.readGate.waiting);
  await page.evaluate(() => {
    const f = window.videoFlow;
    f.app.lockNow();
    f.readGate.release();
  });
  await page.waitForFunction(() => window.videoFlow.app.imageLoadPromises.size === 0);
  await page.waitForTimeout(150);
  const lateState = await page.evaluate(() => {
    const f = window.videoFlow;
    return { covered: f.app.privacyCovered, cacheSize: f.app.imageCache.size, mediaNodes: f.root.querySelectorAll('img, video, .image-viewer').length, unreleasedUrls: [...f.createdUrls].filter(url => !f.revokedUrls.has(url)).length };
  });
  assert.deepEqual(lateState, { covered: true, cacheSize: 0, mediaNodes: 0, unreleasedUrls: 0 }, 'Late video decryption recreated visible content or retained an object URL after lock');
  assert.deepEqual(errors, [], `Video regression raised browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ videoPreview: 'verified original with local poster and play button', viewer: { autoplay: true, maximized: true, mixedPagingPaused: true, stablePagingHeader: true, longPressDoesNotPlay: true, closeReleasesMedia: true, incomingCallStopsPlayback: true }, safe: { label: '相册', photosAndVideos: true, firstClickReveals: true, secondClickPlays: true, genericFilesExcluded: true }, restore: 'album-only video stays outside chat history', ordinaryDownloads: 2, lifecycle: { lockRevokesOriginalAndPoster: true, lateLoadCannotRepopulateCache: true } }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
