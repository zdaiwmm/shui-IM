import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'system-surfaces-fixture', configureServer(vite) {
    // Serve the isolated fixture before the SPA fallback can boot a second app.
    vite.middlewares.use('/__system_surfaces', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__system_surfaces`);
  const results = await page.evaluate(async () => {
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    const own = { deviceId: 'system-own', role: 'creator', status: 'active', capabilities: ['voice-message-v1', 'image-album-v1'] };
    const session = await vault.createVault({ v: 1, roomId: 'system-surfaces', accessToken: 'test', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'system-surfaces-passphrase', 'password');
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.mountChatImageObserver = () => {};
    app.mountGalleryThumbnails = () => {};
    app.flushUiPreferencesSave = () => {};
    const processed = [];
    app.processImageFiles = async (files, destination) => processed.push({ files, destination });
    const check = (value, message) => { if (!value) throw Error(message); };
    const covered = label => check(app.privacyCovered && !!root.querySelector('.cover-trigger') && !root.querySelector('.chat-shell, .gallery-shell'), `${label}: private content remained visible`);
    let focused = true;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    const blur = () => { focused = false; window.dispatchEvent(new Event('blur')); };
    const focus = () => { focused = true; window.dispatchEvent(new Event('focus')); };
    const hidden = value => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    const open = async (destination = 'chat') => {
      app.session = session;
      app.privacyCovered = false;
      app.runtimeEpoch++;
      app.runtimeAbort = new AbortController();
      if (destination === 'gallery') await app.renderGallery();
      else app.renderChat();
    };
    const fresh = async (destination = 'chat') => {
      app.lockNow();
      hidden(false); focus(); processed.length = 0;
      await open(destination);
    };
    const beginPicker = destination => {
      const input = root.querySelector(destination === 'chat' ? '#image-input' : '#gallery-image-input');
      check(input?.multiple, `${destination}: multiple selection is disabled`);
      // Exercise the real trigger and input listeners without opening an OS
      // dialog that the browser test runner cannot dismiss portably.
      input.addEventListener('click', event => event.preventDefault());
      root.querySelector(destination === 'chat' ? '#open-image-picker' : '#open-gallery-image-picker').click();
      check(app.imagePickerActive, `${destination}: picker was not registered`);
      check(!app.privacyCovered && !!root.querySelector(destination === 'chat' ? '.chat-shell' : '.gallery-shell'), `${destination}: clicking upload covered the page before window departure`);
      input.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      check(!app.privacyCovered && !document.documentElement.classList.contains('privacy-obscured'), `${destination}: a control blur was confused with a browser departure`);
      return input;
    };
    const select = async (input, count = 12) => {
      const transfer = new DataTransfer();
      for (let index = 0; index < count; index++) transfer.items.add(new File([new Uint8Array([index])], `photo-${index}.png`, { type: 'image/png' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change'));
      await Promise.resolve();
      await Promise.resolve();
    };

    await fresh(); blur(); focus();
    await new Promise(resolve => setTimeout(resolve, 300));
    check(!app.privacyCovered, 'Ordinary transient blur unexpectedly locked');
    blur(); await new Promise(resolve => setTimeout(resolve, 300)); covered('Ordinary sustained blur'); focus();

    // A delayed navigation must never restore private DOM after locking.
    await fresh();
    app.transitionPage('forward', () => app.renderGallery());
    app.lockNow();
    await new Promise(resolve => setTimeout(resolve, 350));
    covered('Lock during a page fade');

    await fresh();
    check(!root.querySelector('#toggle-notifications, #lock-room'), 'Removed local-safety actions are still visible');
    for (const target of [document.body, root.querySelector('.chat-header'), root.querySelector('#message-input')]) {
      const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      target.dispatchEvent(menu);
      check(menu.defaultPrevented, 'An incidental long press can open the native context menu');
    }

    const pickerResults = [];
    for (const destination of ['chat', 'gallery']) {
      for (const order of ['focus-before-change', 'change-before-focus']) {
        await fresh(destination);
        const input = beginPicker(destination);
        blur(); covered(`${destination} picker blur`);
        check(input.isConnected && input.hidden, `${destination}: active picker input was detached or exposed`);
        hidden(true); covered(`${destination} picker hidden`); hidden(false);
        if (order === 'focus-before-change') focus();
        await select(input);
        if (order === 'change-before-focus') focus();
        covered(`${destination} picker return`);
        check(processed.length === 0, `${destination}: selected images uploaded while locked`);
        check(app.deferredImageUpload?.files.length === 12 && app.deferredImageUpload.destination === destination, `${destination}: selected images were lost or truncated`);
        await open(destination);
        await app.resumeDeferredImage();
        check(processed.length === 1 && processed[0].files.length === 12 && processed[0].destination === destination, `${destination}: selection did not resume after unlocking`);
        check(app.deferredImageUpload === null, `${destination}: consumed selection remained queued`);
        pickerResults.push({ destination, order, selected: 12, uploadedAfterUnlock: true });
      }

      await fresh(destination);
      const canceled = beginPicker(destination);
      hidden(true); covered(`${destination} picker hidden without blur`); hidden(false); focus();
      canceled.dispatchEvent(new Event('cancel'));
      covered(`${destination} canceled picker return`);
      check(!app.imagePickerActive && !app.deferredImageUpload && processed.length === 0, `${destination}: canceled picker retained an upload`);

      for (const alreadyCovered of [false, true]) {
        await fresh(destination);
        const stale = beginPicker(destination);
        if (alreadyCovered) blur();
        app.lockNow();
        await select(stale);
        focus(); covered(`${destination} explicit lock`);
        check(!app.deferredImageUpload && processed.length === 0, `${destination}: late selection crossed explicit lock`);
      }

      await fresh(destination);
      const oldPicker = beginPicker(destination);
      blur();
      await open(destination);
      const currentPicker = beginPicker(destination);
      check(currentPicker !== oldPicker && app.imagePickerInput === currentPicker, `${destination}: newer picker did not acquire ownership`);
      oldPicker.dispatchEvent(new Event('cancel'));
      check(app.imagePickerActive && app.imagePickerInput === currentPicker, `${destination}: stale cancel canceled the newer picker`);
      blur(); covered(`${destination} newer picker blur`);
      await select(currentPicker, 2);
      check(app.deferredImageUpload?.files.length === 2 && processed.length === 0, `${destination}: newer picker selection was lost after stale cancel`);
      focus();
      await open(destination);
      await app.resumeDeferredImage();
      check(processed.length === 1 && processed[0].files.length === 2, `${destination}: newer picker could not resume after stale cancel`);

      for (const identityField of ['roomId', 'deviceId']) {
        await fresh(destination);
        const originalRoomId = session.vault.roomId;
        const originalDeviceId = session.vault.identity.publicBundle.deviceId;
        const ownedPicker = beginPicker(destination);
        blur();
        await select(ownedPicker, 2);
        check(app.deferredImageUpload?.roomId === originalRoomId && app.deferredImageUpload.deviceId === originalDeviceId, `${destination}: deferred selection lost its session ownership`);
        try {
          if (identityField === 'roomId') session.vault.roomId = 'different-room';
          else session.vault.identity.publicBundle.deviceId = 'different-device';
          focus();
          await open(destination);
          await app.resumeDeferredImage();
          check(processed.length === 0 && app.deferredImageUpload === null, `${destination}: deferred selection crossed a changed ${identityField}`);
        } finally {
          session.vault.roomId = originalRoomId;
          session.vault.identity.publicBundle.deviceId = originalDeviceId;
        }
      }

      await fresh(destination);
      const direct = beginPicker(destination);
      await select(direct);
      check(processed.length === 1 && processed[0].files.length === 12, `${destination}: selection without focus loss was truncated`);
    }

    for (const event of ['blur', 'hidden']) {
      await fresh(); app.beginFileExport();
      if (event === 'blur') blur(); else hidden(true);
      covered(`File export ${event}`);
      hidden(false); focus(); app.finishFileExport();
      covered(`File export ${event} return`);
    }

    await fresh();
    let completeSystemSurface;
    const clipboardOperation = app.withSystemSurface(() => new Promise(resolve => { completeSystemSurface = resolve; }));
    check(app.systemSurfaceTokens.size === 1, 'Pending clipboard-like operation did not register a system surface');
    blur(); covered('Clipboard-like system surface blur');
    focus(); covered('Clipboard-like system surface return');
    completeSystemSurface('copied');
    check(await clipboardOperation === 'copied' && app.systemSurfaceTokens.size === 0, 'Completed system surface retained its ownership token');
    covered('Clipboard-like system surface late completion');

    await fresh();
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const { IMAGE_CHUNK_SIZE } = await import('/src/lib/message-payload.ts');
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#0a84ff"/></svg>'], { type: 'image/svg+xml' });
    const svgBytes = await svg.arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', svgBytes));
    const manifest = {
      v: 1, blobId: crypto.randomUUID(), key: randomBase64Url(32), ivPrefix: randomBase64Url(8),
      chunkSize: IMAGE_CHUNK_SIZE, chunkCount: 1, originalSize: svg.size, originalName: 'cached.svg',
      mimeType: svg.type, lastModified: 0,
      sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''),
    };
    app.cacheLocalImage(manifest, svg);
    const firstPreview = app.createImagePreview(manifest, [manifest], 0);
    root.append(firstPreview);
    await app.hydrateImagePreview(firstPreview, manifest);
    check(firstPreview.dataset.imageState === 'loaded' && firstPreview.querySelector('img')?.naturalWidth === 320, 'Initial SVG preview did not decode');
    const cached = app.imageCache.get(manifest.blobId);
    check(cached?.width === 320 && cached.height === 240, 'Decoded image dimensions were not retained');
    app.renderChat();
    const rebuiltPreview = app.createImagePreview(manifest, [manifest], 0);
    check(rebuiltPreview.dataset.imageState === 'loaded' && rebuiltPreview.getAttribute('aria-busy') === 'false', 'Cached preview was not ready synchronously after rebuilding chat');
    check(rebuiltPreview.querySelector('img')?.getAttribute('src') === cached.url && !rebuiltPreview.querySelector('span'), 'Cached preview flashed a loading label');
    root.append(rebuiltPreview);
    app.lockNow(); covered('Cached image lock');
    check(app.imageCache.size === 0 && app.imageCacheBytes === 0 && app.imageManifestSignatures.size === 0, 'Lock retained decrypted image cache');

    await fresh();
    let grant;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
    app.beginVoiceRecording();
    const recorder = app.voiceRecorder;
    check(app.microphonePromptActive && recorder, 'Microphone permission was not pending');
    blur(); covered('Microphone prompt blur'); focus(); covered('Microphone prompt return');
    check(recorder.signal.aborted && !app.voiceRecorder, 'Locked microphone prompt retained its recorder');
    let stopped = 0;
    grant({ getTracks: () => [{ stop: () => stopped++ }] });
    await Promise.resolve(); await Promise.resolve();
    check(stopped === 1, 'Late microphone grant retained an active track');

    // Authentication is the only bounded exception: it is needed before any
    // conversation is opened, and focus returning must not invoke another lock.
    await fresh(); app.session = null; root.innerHTML = '<section class="gateway"></section>';
    let verify;
    const verification = app.withDeviceVerification(() => new Promise(resolve => { verify = resolve; }));
    blur(); hidden(true);
    check(!app.privacyCovered && app.deviceVerificationActive, 'Gateway verification was interrupted by its own prompt');
    hidden(false); focus(); verify('verified');
    check(await verification === 'verified' && !app.deviceVerificationActive && !app.privacyCovered, 'Gateway verification did not finish normally');
    await fresh();
    const conversationVerification = app.withDeviceVerification(async () => 'verified');
    check(!app.deviceVerificationActive, 'An open conversation acquired a verification exemption');
    hidden(true); covered('Open conversation verification'); hidden(false); focus();
    await conversationVerification;

    app.lockNow();
    delete document.hidden; delete document.hasFocus;
    return { ordinaryBlurDebounced: true, pickerResults, canceledSelectionsCleared: true, explicitLockDiscardsLateSelections: true, galleryMultiple: true, chatAboveNine: true, exportsLock: true, stalePickerCancelIgnored: true, deferredSelectionsStayInOriginalSession: true, pendingSystemSurfacesLock: true, decodedPreviewsReuseCache: true, lockingClearsImageCache: true, microphoneLocksAndStopsLateGrant: true, gatewayVerificationCompletes: true };
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
