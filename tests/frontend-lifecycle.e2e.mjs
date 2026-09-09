import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'frontend-lifecycle-fixture', configureServer(vite) {
    // Serve the isolated fixture before the SPA fallback can boot a second app.
    vite.middlewares.use('/__frontend_regression', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});
let browser;
const results = process.env.QUIET_ROOM_TEST_TRACE ? new Proxy({}, {
  set(target, key, value) { target[key] = value; console.log(`PASS ${String(key)}`); return true; },
}) : {};
const visualQaDirectory = process.argv[2];
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__frontend_regression`);
  const initializeRegression = async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/gallery.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    await import('/src/voice-messages.css');
    await import('/src/call.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    const member = { deviceId: 'regression-own', role: 'creator', status: 'active' };
    const session = await vault.createVault({ v: 1, roomId: 'frontend-regression', accessToken: 'test', role: 'creator', protocol: 'legacy-v1', lastSeq: 620, members: [member, { deviceId: 'regression-peer', role: 'joiner', status: 'active' }], identity: { publicBundle: member } }, 'frontend-regression-passphrase', 'password');
    const message = (seq, payload = { v: 1, kind: 'text', text: `历史消息 ${seq}`, sentAt: '2026-09-04T01:00:00.000Z' }) => ({ seq, clientMsgId: `message-${seq}`, senderId: 'regression-peer', payload, acceptedAt: '2026-09-04T01:00:00.000Z', status: 'delivered' });
    const fresh = () => {
      app.session = session; app.privacyCovered = false; app.runtimeEpoch += 1; app.runtimeAbort = new AbortController();
      app.updateSafetyCode = async () => {};
      app.updateBackgroundNotificationControl = async () => {};
      app.mountChatImageObserver = () => {}; app.mountGalleryThumbnails = () => {};
      app.messages = new Map(); app.pending = new Map(); app.messageEventHistory = new Map(); app.uiPreferences = {}; app.uiPreferencesHydrated = true; app.restoreChatAnchorOnNextRender = false;
      app.renderChat();
    };
    window.regression = { app, root, session, vault, message, fresh };
    // Measure the anchoring edge independently of any test-injected transform.
    window.composerBaseBounds = () => {
      const element = document.querySelector('#composer');
      const rect = element.getBoundingClientRect();
      const transform = getComputedStyle(element).transform;
      const y = transform === 'none' ? 0 : new DOMMatrix(transform).f;
      return { top: rect.top - y, bottom: rect.bottom - y, left: rect.left, right: rect.right,
        width: rect.width, height: rect.height };
    };
    fresh();
  };
  await page.evaluate(initializeRegression);

  // A disposable context owns only synthetic localhost IndexedDB data. It has
  // no persistent profile and cannot access the user's production-origin vault.
  const receiptContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const receiptPage = await receiptContext.newPage();
  await receiptPage.goto(`http://localhost:${server.httpServer.address().port}/__frontend_regression`);
  await receiptPage.evaluate(initializeRegression);
  results.paginatedReceiptSync = await receiptPage.evaluate(async () => {
    const { app, fresh, vault } = window.regression;
    fresh();
    const { generateIdentity, createDeliveryReceipt, encryptMessage } = await import('/src/lib/crypto.ts');
    const own = await generateIdentity();
    const peer = await generateIdentity();
    const roomId = crypto.randomUUID();
    const members = [{ ...own.publicBundle, role: 'creator', status: 'active' }, { ...peer.publicBundle, role: 'joiner', status: 'active' }];
    const session = await vault.createVault({ v: 1, roomId, accessToken: 'receipt-regression', role: 'creator', protocol: 'legacy-v1', lastSeq: 620, lastReceiptSeq: 0, members, identity: own }, 'receipt-regression-passphrase', 'password');
    app.session = session;
    const old = { seq: 1, clientMsgId: crypto.randomUUID(), senderId: own.publicBundle.deviceId, payload: { v: 1, kind: 'text', text: 'Archived receipt fixture', sentAt: new Date().toISOString() }, acceptedAt: new Date().toISOString(), status: 'stored' };
    await vault.saveHistoryMessage(session, old);
    const receipt = await createDeliveryReceipt({ ...session.vault, role: 'joiner', identity: peer }, { seq: old.seq, envelope: { roomId, clientMsgId: old.clientMsgId, senderId: old.senderId } });
    let syncRequests = 0;
    app.socket = { requestSync: () => { syncRequests++; }, requestReceiptSync: () => {}, close: () => {}, setChatPresence: () => {} };
    app.receiptQueue.set(1, { receiptSeq: 1, receipt, acceptedAt: new Date().toISOString() });
    await app.drainReceiptQueue();
    // Empty responses used to request another sync for the same old receipt.
    await app.drainServerQueue();
    await app.drainServerQueue();
    const saved = await vault.loadHistoryMessage(session, 1);
    if (syncRequests || saved.status !== 'delivered' || session.vault.lastReceiptSeq !== 1 || app.receiptQueue.size) {
      throw Error(`Paginated receipt caused a sync loop: ${JSON.stringify({ syncRequests, status: saved.status, receiptSeq: session.vault.lastReceiptSeq, queued: app.receiptQueue.size })}`);
    }
    if (app.messages.has(1)) throw Error('Receipt expanded the visible history page');
    let securityFailures = 0;
    const fatal = app.fatalSecurityError;
    app.fatalSecurityError = () => { securityFailures++; };
    app.receiptQueue.set(2, { receiptSeq: 2, receipt: { ...receipt, receivedAt: '2020-01-01T00:00:00.000Z' }, acceptedAt: new Date().toISOString() });
    await app.drainReceiptQueue();
    if (securityFailures !== 1 || session.vault.lastReceiptSeq !== 1) throw Error('Archived receipt bypassed signature verification');
    app.receiptQueue.set(2, { receiptSeq: 2, receipt: { ...receipt, seq: 2 }, acceptedAt: new Date().toISOString() });
    await app.drainReceiptQueue();
    if (securityFailures !== 2 || syncRequests || session.vault.lastReceiptSeq !== 1) throw Error('Missing durable history retried forever or advanced the receipt cursor');
    app.fatalSecurityError = fatal;
    app.receiptQueue.clear();
    const envelope = await encryptMessage(session.vault, old.payload);
    app.renderGallery();
    app.transitionPage('backward', () => app.renderChat());
    const returningChat = document.querySelector('#app > .chat-shell');
    app.serverQueue.set(621, { seq: 621, envelope, acceptedAt: new Date().toISOString() });
    await app.drainServerQueue();
    if (!returningChat.isConnected || app.activeSurface !== 'chat' || !app.messages.has(621)) throw Error('Incoming message reopened the outgoing gallery');
    await new Promise(resolve => setTimeout(resolve, 450));
    app.lockNow();
    return { syncRequests, persistedDelivery: true, historyWindowPreserved: true, invalidReceiptRejected: true, missingHistoryStopped: true, incomingMessagePreservedReturn: true };
  });
  await receiptContext.close();

  results.reconnectGalleryNavigation = await page.evaluate(async () => {
    const { app, fresh } = window.regression;
    fresh();
    app.renderGallery();
    const gallery = document.querySelector('.gallery-shell');
    await app.drainServerQueue();
    const emptySyncPreservedGallery = document.querySelector('.gallery-shell') === gallery;
    app.transitionPage('backward', () => app.renderChat());
    const chat = document.querySelector('#app > .chat-shell');
    await app.drainServerQueue();
    const returnSurvivedSync = chat?.isConnected && app.activeSurface === 'chat';
    await new Promise(resolve => setTimeout(resolve, 450));
    if (!emptySyncPreservedGallery || !returnSurvivedSync) {
      throw Error(`Reconnect interrupted gallery navigation: ${JSON.stringify({ emptySyncPreservedGallery, returnSurvivedSync })}`);
    }
    app.lockNow();
    return { emptySyncPreservedGallery, returnSurvivedSync };
  });

  results.messageMenuScrollOrdering = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 40 }, (_, index) => [index + 1, message(index + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const deadline = performance.now() + 800;
    while (app.chatViewportMotion?.moving && performance.now() < deadline) await settle();
    if (app.chatViewportMotion?.moving) throw Error('Initial viewport motion did not settle before menu scroll ordering');
    const list = document.querySelector('#message-list');
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    const source = document.querySelector('[data-client-msg-id="message-20"]');
    source.scrollIntoView({ block: 'center', behavior: 'instant' });
    window.dispatchEvent(new Event('scroll'));
    source.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle();
    if (!document.querySelector('.message-actions.is-visible')) throw Error('A queued pre-open scroll frame dismissed the newly opened message menu');
    window.dispatchEvent(new Event('scroll'));
    await settle();
    if (!document.querySelector('.message-actions.is-visible')) throw Error('A delayed scroll event without movement dismissed the message menu');
    window.scrollBy(0, 48); window.dispatchEvent(new Event('scroll'));
    await settle();
    if (document.querySelector('.message-actions:not(.is-closing)')) throw Error('Actual scrolling after opening left a detached message menu visible');
    return { preOpenScroll: 'preserved', unchangedDelayedEvent: 'preserved', laterMovement: 'dismissed' };
  });

  // Confirmed empty categories have no visible number, including when the
  // other category is selected. Loading and unknown counts retain their state.
  await page.evaluate(() => window.regression.app.renderGallery());
  await page.waitForFunction(() => window.regression.app.galleryKnownCounts.images?.complete);
  await page.locator('#gallery-tab-files').click();
  await page.waitForFunction(() => window.regression.app.galleryKnownCounts.files?.complete);
  results.emptyGalleryCounts = await page.evaluate(() => {
    for (const kind of ['images', 'files']) {
      const label = document.querySelector(`[data-gallery-count="${kind}"]`);
      if (!label.hidden || label.textContent !== '' || getComputedStyle(label).display !== 'none') throw Error(`Empty ${kind} tab still displayed a count`);
    }
    return { images: 'hidden', files: 'hidden' };
  });

  results.composerRecovery = await page.evaluate(async () => {
    const { app, fresh, session, vault, message } = window.regression;
    fresh();
    const input = document.querySelector('#message-input');
    input.value = '未发送的草稿\n继续输入';
    input.dispatchEvent(new Event('input'));
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 300));
    if (app.privacyCovered) throw Error('Transient blur covered the conversation');
    app.lockNow();
    await app.preferenceSaveChain;
    const saved = await vault.loadUiPreferences(session);
    if (saved.composerDraft !== '未发送的草稿\n继续输入') throw Error('Draft was not encrypted and saved before lock');
    fresh(); app.uiPreferences = saved; app.renderChat();
    if (document.querySelector('#message-input').value !== saved.composerDraft) throw Error('Draft was not restored');
    app.messages = new Map(Array.from({ length: 80 }, (_, index) => [index + 1, message(index + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    document.querySelector('#message-input').value = '多行草稿\n'.repeat(8);
    document.querySelector('#message-input').dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const list = document.querySelector('#message-list');
    if (document.documentElement.scrollHeight - window.scrollY - window.innerHeight > 2) throw Error('Composer resize lost bottom position');
    const last = list.querySelector('.message:last-child').getBoundingClientRect();
    const composer = window.composerBaseBounds();
    if (last.bottom > composer.top) throw Error(`Latest message is covered by composer: ${JSON.stringify({ lastBottom: last.bottom, composerTop: composer.top, composerHeight: composer.height, padding: getComputedStyle(list).paddingBottom, scrollY, scrollHeight: document.documentElement.scrollHeight, pinned: app.chatPinnedToBottom })}`);
    return { transientBlur: 'visible', encryptedDraft: 'restored', latestMessage: 'above composer' };
  });

  results.imagePaste = await page.evaluate(async () => {
    const { app, fresh } = window.regression;
    fresh();
    const input = document.querySelector('#message-input');
    input.value = '保留草稿'; input.setSelectionRange(2, 2);
    const original = app.processImageFiles;
    const notice = app.showNotice;
    const batches = []; const notices = [];
    app.processImageFiles = async (files, destination) => batches.push({ files, destination });
    app.showNotice = text => notices.push(text);
    const paste = data => {
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      input.dispatchEvent(event); return event;
    };
    const text = new DataTransfer(); text.setData('text/plain', '正常文字');
    if (paste(text).defaultPrevented || batches.length) throw Error('Ordinary text paste was intercepted');
    const one = new File([new Uint8Array([1, 2, 3])], 'clipboard.png', { type: 'image/png' });
    const two = new File([new Uint8Array([4, 5])], 'clipboard.webp', { type: 'image/webp' });
    const images = new DataTransfer(); images.items.add(one); images.items.add(two);
    images.setData('text/plain', 'copied image'); images.setData('text/html', '<img src="https://example.invalid/image.png">');
    if (!paste(images).defaultPrevented || batches.length !== 1 || batches[0].files.length !== 2 || batches[0].destination !== 'chat') throw Error('Images were lost or duplicated during paste');
    if (input.value !== '保留草稿' || input.selectionStart !== 2) throw Error('Image paste overwrote the text draft');
    const bytes = await Promise.all(batches[0].files.map(async file => [...new Uint8Array(await file.arrayBuffer())]));
    if (JSON.stringify(bytes) !== '[[1,2,3],[4,5]]') throw Error('Paste transformed the original bytes');
    app.imageBatchUploading = true; paste(images); app.imageBatchUploading = false;
    if (batches.length !== 1 || !notices.length) throw Error('An overlapping paste was silently lost');
    document.documentElement.classList.add('privacy-obscured'); paste(images);
    document.documentElement.classList.remove('privacy-obscured');
    if (batches.length !== 1) throw Error('Privacy curtain allowed a paste upload');
    app.processImageFiles = original; app.showNotice = notice;
    app.lockNow(); paste(images);
    if (!app.privacyCovered) throw Error('A stale paste reopened the conversation');
    return { images: 2, originalBytes: true, ordinaryText: 'native', draftPreserved: true, busyFeedback: true, coveredPasteBlocked: true };
  });

  results.deliveryIcons = await page.evaluate(() => {
    const { app, fresh, message, session } = window.regression; fresh();
    const own = session.vault.identity.publicBundle.deviceId;
    for (const [index, status] of ['pending', 'stored', 'sent', 'delivered', 'failed'].entries()) {
      app.messages.set(index + 1, { ...message(index + 1), senderId: own, status });
    }
    app.renderMessages();
    const row = status => document.querySelector(`.message.is-${status}`);
    for (const status of ['stored', 'sent']) if (row(status).querySelectorAll('.message-delivery path').length !== 1) throw Error('Sent receipt did not have one check arm');
    if (row('delivered').querySelectorAll('.message-delivery path').length !== 2) throw Error('Delivered receipt did not have two check arms');
    if (row('pending').querySelector('.message-delivery') || row('failed').querySelector('.message-delivery')) throw Error('Unconfirmed message displayed a success check');
    if (!row('failed').querySelector('.message-retry') || !row('delivered').querySelector('.message-meta').getAttribute('aria-label')) throw Error('Receipt accessibility or retry was lost');
    return { sentArms: 1, deliveredArms: 2, pendingAndFailure: 'explicit', retry: true, accessibleDescriptions: true };
  });

  // A saved offset may sit deep inside a tall photo. A cold 128px placeholder
  // must not replace that anchor with the next message before the photo decodes.
  results.coldImageAnchor = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression;
    app.lockNow(); fresh();
    const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="red"/></svg>'], { type: 'image/svg+xml' });
    const manifests = Array.from({ length: 15 }, (_, index) => ({
      v: 1, blobId: `cold-anchor-${index}`, originalName: `cold-anchor-${index}.svg`, originalSize: blob.size, mimeType: blob.type,
    }));
    const messages = (count = manifests.length) => new Map(manifests.slice(0, count).map((image, index) => [index + 1, message(index + 1, { v: 1, kind: 'image', image, sentAt: '2026-09-04T01:00:00.000Z' })]));
    const warm = async () => {
      for (const manifest of manifests) {
        app.cacheLocalImage(manifest, blob);
        const cached = app.imageCache.get(manifest.blobId);
        cached.width = 300; cached.height = 400;
        const decoded = new Image(); decoded.src = cached.url; await decoded.decode();
        await app.ensureChatConcealedImage(manifest, cached, decoded);
      }
    };
    const settleLayout = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sameAnchor = (actual, expected) => actual?.clientMsgId === expected.clientMsgId && Math.abs(actual.offset - expected.offset) <= 2 && !actual.pinnedToBottom;
    await warm(); app.messages = messages(); app.renderChat();
    let list = document.querySelector('#message-list');
    // Cached dimensions do not mean the newly mounted <img> has decoded.
    // Establish an actually warm baseline before saving a position that the
    // later, deliberately cold placeholder phase must preserve.
    const warmImages = [...list.querySelectorAll('.image-preview img')];
    await Promise.all(warmImages.map(image => image.decode()));
    if (warmImages.length !== manifests.length || warmImages.some(image => image.naturalWidth !== 300 || image.naturalHeight !== 400)) throw Error('Warm-image anchor fixture did not decode its complete baseline');
    await settleLayout();
    const target = list.querySelector('[data-client-msg-id="message-8"]');
    window.scrollBy(0, target.getBoundingClientRect().top + 196);
    await settleLayout();
    const saved = structuredClone(app.captureChatAnchor());
    if (saved.clientMsgId !== 'message-8' || Math.abs(saved.offset + 196) > 2) throw Error(`Tall-image anchor fixture did not reach the expected offset: ${JSON.stringify({ saved, scrollY, height: document.documentElement.scrollHeight })}`);
    const reopenCold = (count = manifests.length) => {
      app.lockNow();
      if (app.imageCache.size) throw Error('Lock retained decrypted image cache');
      fresh(); app.messages = messages(count); app.uiPreferences = { chatAnchor: structuredClone(saved) };
      app.restoreChatAnchorOnNextRender = true; app.renderChat();
      return document.querySelector('#message-list');
    };
    list = reopenCold(); await settleLayout();
    if (!sameAnchor(app.uiPreferences.chatAnchor, saved) || !sameAnchor(app.chatRestoreAnchor, saved)) throw Error('Cold placeholder replaced the intended restored anchor');
    await warm();
    for (const button of list.querySelectorAll('.image-preview')) {
      const manifest = manifests.find(item => item.blobId === button.dataset.blobId);
      await app.renderImageIntoButton(button, manifest, app.imageCache.get(manifest.blobId));
    }
    await settleLayout();
    const restored = structuredClone(app.captureChatAnchor());
    if (!sameAnchor(restored, saved) || app.chatRestoreAnchor) throw Error(`Decoded images lost the restored anchor: ${JSON.stringify({ saved, restored })}`);

    // Two cold rows below message 8 cannot provide enough scrollable space
    // for its deep saved offset until those rows decode too.
    list = reopenCold(10); await settleLayout(); await warm();
    let tailWasClamped = false;
    for (const [index, button] of [...list.querySelectorAll('.image-preview')].entries()) {
      const manifest = manifests.find(item => item.blobId === button.dataset.blobId);
      await app.renderImageIntoButton(button, manifest, app.imageCache.get(manifest.blobId));
      if (index === 7) {
        const offset = list.querySelector('[data-client-msg-id="message-8"]').getBoundingClientRect().top;
        tailWasClamped = Math.abs(offset - saved.offset) > 2;
        if (!tailWasClamped || !sameAnchor(app.chatRestoreAnchor, saved)) throw Error('A temporarily clamped tail discarded its intended restore anchor');
      }
    }
    await settleLayout();
    if (!sameAnchor(app.captureChatAnchor(), saved) || app.chatRestoreAnchor) throw Error('Decoding the trailing rows did not finish the exact saved offset');

    // With only one final row, even the fully decoded tail cannot reach that
    // offset. Earlier offscreen pending media must not stall restoration.
    list = reopenCold(9); await settleLayout(); await warm();
    for (const button of [...list.querySelectorAll('.image-preview')].slice(7)) {
      const manifest = manifests.find(item => item.blobId === button.dataset.blobId);
      await app.renderImageIntoButton(button, manifest, app.imageCache.get(manifest.blobId));
    }
    await settleLayout();
    if (app.chatRestoreAnchor || list.querySelectorAll('.image-preview[data-image-state="pending"]').length !== 7) throw Error('Earlier pending media kept an unreachable tail anchor suspended');

    list = reopenCold(); await settleLayout();
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
    if (app.chatRestoreAnchor) throw Error('User scroll did not cancel pending image-anchor restoration');
    const newerTarget = list.querySelector('[data-client-msg-id="message-10"]');
    window.scrollBy(0, newerTarget.getBoundingClientRect().top);
    await settleLayout();
    const userAnchor = structuredClone(app.captureChatAnchor());
    if (userAnchor.clientMsgId === saved.clientMsgId) throw Error('User-scroll fixture did not move away from the original anchor');
    warm();
    for (const button of list.querySelectorAll('.image-preview')) {
      const manifest = manifests.find(item => item.blobId === button.dataset.blobId);
      await app.renderImageIntoButton(button, manifest, app.imageCache.get(manifest.blobId));
    }
    await settleLayout();
    const afterUserScroll = structuredClone(app.captureChatAnchor());
    if (!sameAnchor(afterUserScroll, userAnchor)) throw Error(`Late image decode overrode user scrolling: ${JSON.stringify({ userAnchor, afterUserScroll })}`);
    // Page transitions retain the outgoing chat DOM for their exit animation.
    // Its image decode may finish after the gallery has reset document scroll.
    // Connected old rows must not replace the active reading-anchor record.
    const beforeAwayDecode = structuredClone(app.uiPreferences.chatAnchor);
    app.cancelViewportWork(); app.activeSurface = 'away';
    window.scrollTo(0, 0);
    const outgoingImage = list.querySelector('.image-preview');
    const outgoingManifest = manifests.find(item => item.blobId === outgoingImage.dataset.blobId);
    await app.renderImageIntoButton(outgoingImage, outgoingManifest, app.imageCache.get(outgoingManifest.blobId));
    if (!sameAnchor(app.uiPreferences.chatAnchor, beforeAwayDecode)) throw Error('Outgoing chat image decode overwrote the gallery return anchor');
    app.lockNow();
    return { saved, restored, tailWasClamped, stableShortTailReleased: true, userScrollPreserved: true, outgoingDecodePreserved: true, lockClearsCache: true };
  });

  results.sendDraftDurability = await page.evaluate(async () => {
    const { app, fresh, session, vault } = window.regression;
    const enqueue = app.enqueuePayload;
    fresh();
    const input = document.querySelector('#message-input');
    input.value = '等待安全保存'; input.dispatchEvent(new Event('input'));
    let finish;
    app.enqueuePayload = () => new Promise(resolve => { finish = resolve; });
    const sending = app.handleSendText(new Event('submit'));
    if (input.value !== '等待安全保存') throw Error('Draft cleared before persistence');
    finish(); await sending; await app.preferenceSaveChain;
    if (input.value || (await vault.loadUiPreferences(session)).composerDraft) throw Error('Persisted send left a stale draft');
    input.value = '发送时继续编辑';
    const next = app.handleSendText(new Event('submit'));
    input.value = '后续新草稿'; input.dispatchEvent(new Event('input'));
    finish(); await next;
    if (input.value !== '后续新草稿') throw Error('Successful send erased newer input');
    app.enqueuePayload = enqueue;
    return { beforePersistence: 'retained', afterPersistence: 'cleared', newerInput: 'retained' };
  });

  // Hold an actual Clipboard API promise across the real cleanup/cover path.
  results.clipboard = await page.evaluate(async () => {
    const { app, message, fresh } = window.regression;
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    for (const outcome of ['reject', 'resolve']) {
      fresh();
      let settle;
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => new Promise((resolve, reject) => { settle = outcome === 'reject' ? () => reject(new Error('Document is not focused')) : resolve; }) });
      const copy = app.copyMessageText('must stay hidden', message(1));
      app.lockNow();
      settle();
      await copy;
      if (!document.querySelector('.cover-trigger') || document.querySelector('.message-text-selection')) throw Error(`Clipboard ${outcome} crossed lock boundary`);
    }
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText });
    return { rejectedAfterLock: 'covered', resolvedAfterLock: 'covered' };
  });

  // A late clipboard result belongs to the menu that requested it, even when
  // the runtime stays unlocked and a different message is opened meanwhile.
  results.clipboardSource = await page.evaluate(async () => {
    const { app, message, fresh } = window.regression;
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    for (const outcome of ['reject', 'resolve']) {
      fresh();
      const first = message(1); const second = message(2);
      app.messages = new Map([[1, first], [2, second]]); app.renderMessages();
      app.openMessageActions(document.querySelector('[data-client-msg-id="message-1"]'), first);
      let settle;
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => new Promise((resolve, reject) => { settle = outcome === 'reject' ? () => reject(new Error('Clipboard rejected')) : resolve; }) });
      const copying = app.copyMessageText(first.payload.text, first);
      app.openMessageActions(document.querySelector('[data-client-msg-id="message-2"]'), second);
      settle(); await copying;
      const current = document.querySelector('.message-actions:not(.is-closing)');
      if (current?.dataset.sourceId !== 'message-2' || document.querySelector('.message-text-selection')) throw Error(`Old clipboard ${outcome} replaced the newer menu`);
      app.closeMessageActions(false, false);
    }
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText });
    return { rejectedAfterMenuSwitch: 'ignored', resolvedAfterMenuSwitch: 'ignored' };
  });

  // Selection stays inside the original bubble. Menu animation frames must
  // never replace a range the user has already adjusted using native handles.
  results.selectiveCopyReadiness = await page.evaluate(async () => {
    const { app, message, fresh, session } = window.regression; fresh();
    const source = { ...message(1, { v: 1, kind: 'text', text: 'browser-e2e-live', sentAt: '2026-09-04T01:00:00.000Z' }), senderId: session.vault.identity.publicBundle.deviceId, status: 'pending' };
    app.messages = new Map([[1, source]]); app.renderMessages();
    const article = document.querySelector('[data-client-msg-id="message-1"]');
    const before = article.querySelector('.message-text').getBoundingClientRect();
    const requestFrame = window.requestAnimationFrame;
    const frames = [];
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    app.openMessageActions(article, source);
    document.querySelector('[data-message-action="select"]').click();
    const textarea = article.querySelector('textarea.message-text.message-text-selection');
    if (!textarea || !textarea.readOnly || textarea.inputMode !== 'none') throw Error('Message selection was not installed as a native readonly inline field');
    if (document.querySelector('.message-actions, .message-copy-sheet, [role="dialog"]')) throw Error('Choosing text opened a popup');
    if (document.activeElement !== textarea || textarea.selectionStart !== 0 || textarea.selectionEnd !== source.payload.text.length) throw Error('Message text was not selected synchronously');
    const after = textarea.getBoundingClientRect();
    if (Math.abs(after.width - before.width) > 1 || Math.abs(after.height - before.height) > 1) throw Error('Inline selection changed the message dimensions');
    textarea.focus(); textarea.setSelectionRange(8, 11);
    window.requestAnimationFrame = requestFrame;
    for (const callback of frames) callback(performance.now());
    const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (selected !== 'e2e') throw Error(`A deferred frame replaced the native selection: range=${textarea.selectionStart}:${textarea.selectionEnd}`);
    app.messages.set(source.seq, { ...source, status: 'delivered' });
    app.renderMessages({ scroll: 'preserve' });
    if (article.querySelector('.message-text-selection') !== textarea || textarea.value.slice(textarea.selectionStart, textarea.selectionEnd) !== 'e2e') throw Error('A message status update replaced the active native selection');
    if (!article.classList.contains('is-delivered') || !article.querySelector('.message-meta')?.textContent.includes('已送达')) throw Error('A receipt left stale delivery metadata during native selection');
    for (const attributes of [{ key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
      const event = new KeyboardEvent('keydown', { ...attributes, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      if (event.defaultPrevented || article.querySelector('.message-text-selection') !== textarea || document.querySelector('.message-actions')) throw Error('The native context-menu gesture was intercepted while selecting text');
    }
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (article.querySelector('textarea') || article.querySelector('.message-text')?.textContent !== source.payload.text) throw Error('Leaving selection did not restore the original message');
    if (!article.querySelector('.message-meta')?.textContent.includes('已送达')) throw Error('Leaving native selection restored outdated receipt metadata');
    return { originalBubblePreserved: true, nativeSelectionReady: true, selectionBeforeInitialFramePreserved: true, selectedText: selected };
  });

  results.privacySnapshot = await page.evaluate(() => {
    const { app, message, fresh } = window.regression; fresh();
    const source = message(1);
    app.messages = new Map([[1, source]]); app.renderMessages();
    document.querySelector('#message-input').focus();
    document.querySelector('.message').focus();
    if (document.documentElement.classList.contains('privacy-obscured') || app.privacyCovered) throw Error('Moving focus between an input and a message triggered the browser privacy curtain');
    app.openMessageTextSelection(source);
    window.dispatchEvent(new Event('blur'));
    // This assertion runs before timers, animation frames, or lifecycle cleanup.
    if (!document.documentElement.classList.contains('privacy-obscured')) throw Error('Blur left the current frame exposed before the lock timer');
    if (!document.elementFromPoint(20, 20)?.closest('.privacy-curtain')) throw Error('The synchronous curtain did not cover the browser snapshot area');
    window.dispatchEvent(new Event('focus'));
    if (app.privacyCovered || document.documentElement.classList.contains('privacy-obscured')) throw Error('Immediate focus did not restore a transiently covered conversation');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try { document.dispatchEvent(new Event('visibilitychange')); }
    finally { delete document.hidden; }
    window.dispatchEvent(new Event('focus'));
    if (!app.privacyCovered || !document.querySelector('.cover-trigger') || document.querySelector('.message, .message-text-selection')) throw Error('Returning from background exposed message content or native selection');
    if (app.messages.size || app.pending.size || app.messageEventHistory.size) throw Error('Background lock retained decrypted message state');
    return { blurCoverage: 'same event stack', transientFocus: 'restored', backgroundReturn: 'authentication required', selection: 'cleared' };
  });

  await page.evaluate(async () => {
    const { app, message, fresh } = window.regression; fresh();
    app.messages = new Map([[1, message(1)]]); app.renderMessages({ scroll: 'bottom' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  // Playwright's pointer sequence is trusted. A synthetic PointerEvent cannot
  // authorize the narrowly scoped native-keyboard focus handoff.
  await page.locator('#message-input').click();
  results.keyboardNativeHandoff = await page.evaluate(async () => {
    const { app } = window.regression;
    const input = document.querySelector('#message-input');
    const viewport = window.visualViewport;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    if (document.activeElement !== input || !app.keyboardHandoff || app.keyboardHandoff.blurred) throw Error('Trusted primary textarea click did not authorize one keyboard handoff');
    window.dispatchEvent(new Event('blur'));
    if (app.privacyCovered || document.documentElement.classList.contains('privacy-obscured')
      || !app.keyboardHandoff?.blurred) throw Error('First native-keyboard window blur was not consumed without exposing a privacy curtain');
    Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 180 });
    viewport.dispatchEvent(new Event('resize')); await frame();
    if (app.keyboardHandoff || document.documentElement.dataset.keyboardOpen !== 'true'
      || document.documentElement.classList.contains('privacy-obscured')) throw Error('Keyboard viewport target did not settle the one-use handoff token');
    window.dispatchEvent(new Event('blur'));
    if (!document.documentElement.classList.contains('privacy-obscured')
      || !document.elementFromPoint(20, 20)?.closest('.privacy-curtain')) throw Error('Second window blur after keyboard handoff did not fail closed synchronously');
    window.dispatchEvent(new Event('focus'));
    input.blur(); delete viewport.height; delete viewport.offsetTop;
    viewport.dispatchEvent(new Event('resize')); await frame();
    app.lockNow();
    return { trustedTextareaPointer: true, firstBlurConsumed: true, targetClearedToken: true, secondBlurCoveredSynchronously: true };
  });

  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(async () => {
    const { app, message, fresh } = window.regression; fresh();
    const source = message(1, { v: 1, kind: 'text', text: '这是一条较长的聊天消息，用来检查小屏幕上的表情回应和消息操作是否依然完整可见。\n'.repeat(18), sentAt: '2026-09-04T01:00:00.000Z' });
    app.messages = new Map([[1, source]]); app.renderMessages({ scroll: 'bottom' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    app.openMessageActions(document.querySelector('[data-client-msg-id="message-1"]'), source);
  });
  await page.locator('.message-actions.is-visible').waitFor();
  await page.waitForTimeout(200);
  results.longMessageActions = await page.evaluate(() => {
    const rect = selector => {
      const { left, right, top, bottom, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const picker = rect('.message-reaction-picker');
    const actions = rect('.message-action-list');
    const source = document.querySelector('.message.is-action-source > .message-bubble');
    const preview = document.querySelector('.message-actions-backdrop .message-action-preview > .message-bubble');
    if (!preview || preview.textContent !== source.textContent) throw Error('Selected text must be copied above the blur layer');
    const originalRect = source.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    if (Math.abs(originalRect.left - previewRect.left) > 1 || Math.abs(originalRect.top - previewRect.top) > 1 || Math.abs(originalRect.width - previewRect.width) > 1) throw Error('Menu preview must preserve the original bubble position and width');
    if (getComputedStyle(preview).visibility !== 'visible' || getComputedStyle(preview).backgroundColor !== getComputedStyle(source).backgroundColor) throw Error('Menu preview must remain visible in the source bubble color');
    for (const box of [picker, actions]) {
      if (box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight || !box.width || !box.height) throw Error(`Long message actions are clipped at 320px: ${JSON.stringify({ picker, actions })}`);
    }
    if (Math.min(picker.right, actions.right) > Math.max(picker.left, actions.left) && Math.min(picker.bottom, actions.bottom) > Math.max(picker.top, actions.top)) throw Error('Long message action list overlaps its reaction bar');
    return { viewportWidth: innerWidth, picker, actions, overlap: false };
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.message-actions-backdrop')).opacity === '1');
  results.messageDismissContinuity = await page.evaluate(async () => {
    const source = document.querySelector('.message.is-action-source');
    const bubble = source.querySelector('.message-bubble');
    const backdrop = document.querySelector('.message-actions-backdrop');
    const preview = backdrop.querySelector('.message-action-preview');
    window.regression.app.closeMessageActions();
    let frames = 0;
    const started = performance.now();
    while (performance.now() - started < 380) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const originalVisible = getComputedStyle(bubble).visibility === 'visible';
      const previewVisible = preview.isConnected && getComputedStyle(preview).visibility === 'visible' && Number(getComputedStyle(backdrop).opacity) >= 0.99;
      if (!originalVisible && !previewVisible) throw Error('Selected bubble faded out before the original returned');
      frames++;
    }
    if (preview.isConnected || source.classList.contains('is-action-source')) throw Error('Closing retained the selected preview');
    window.regression.app.openMessageActions(source, window.regression.app.messages.get(1));
    return { frames, continuous: true };
  });
  await page.locator('.message-actions.is-visible').waitFor();
  if (visualQaDirectory) {
    await mkdir(visualQaDirectory, { recursive: true });
    await page.screenshot({ path: path.join(visualQaDirectory, 'message-menu-long-320.png') });
    await page.locator('[data-message-action="select"]').click();
    await page.locator('.message-text-selection').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.message-text-selection').evaluate(textarea => document.activeElement === textarea && textarea.selectionEnd > textarea.selectionStart), true, 'Selection screenshot would not contain a focused native selection');
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('privacy-obscured')), false, 'Selection screenshot would capture the privacy curtain');
    await page.screenshot({ path: path.join(visualQaDirectory, 'message-native-selection-320.png') });
    await page.evaluate(() => window.regression.app.lockNow());
    await page.screenshot({ path: path.join(visualQaDirectory, 'privacy-cover-320.png') });
  }
  await page.evaluate(() => { window.regression.app.closeMessageActions(false, false); window.regression.app.clearMessageTextSelection(); });
  results.shortMessageBadges = await page.evaluate(() => {
    const { app, message, fresh } = window.regression; fresh();
    const source = message(1, { v: 1, kind: 'text', text: '好', sentAt: '2026-09-04T01:00:00.000Z' });
    app.messages = new Map([[1, source]]);
    app.messageEventHistory = new Map(['regression-own', 'regression-peer'].map((senderId, index) => {
      const seq = index + 2;
      return [seq, { ...message(seq), senderId, payload: { v: 1, kind: 'reaction', sentAt: source.payload.sentAt, target: { clientMsgId: source.clientMsgId, serverSeq: source.seq, senderId: source.senderId }, emoji: index ? '❤️' : '👍' } }];
    }));
    app.renderMessages({ scroll: 'bottom' });
    const badges = [...document.querySelectorAll('.message-reaction')];
    if (badges.length !== 2) throw Error('Two participants did not receive independent reaction badges');
    const bounds = badges.map(badge => { const { left, right, width } = badge.getBoundingClientRect(); return { left, right, width }; });
    if (bounds.some(rect => rect.left < 0 || rect.right > innerWidth || rect.width < 44)) throw Error(`Short incoming message clips its reaction controls: ${JSON.stringify(bounds)}`);
    return { viewportWidth: innerWidth, count: badges.length, bounds };
  });
  if (visualQaDirectory) await page.screenshot({ path: path.join(visualQaDirectory, 'message-short-badges-320.png') });
  await page.setViewportSize({ width: 390, height: 844 });

  // Changing the current session must never retarget an already queued payload.
  results.sendQueue = await page.evaluate(async () => {
    const { app, fresh } = window.regression;
    fresh();
    let release;
    app.sendChain = new Promise(resolve => { release = resolve; });
    const original = app.sendPayload;
    const sent = [];
    app.sendPayload = async payload => { sent.push(payload); };
    const queued = app.enqueuePayload({ v: 1, kind: 'text', text: 'only for old session', sentAt: new Date().toISOString() });
    app.lockNow(); fresh();
    release(); await queued;
    app.sendPayload = original;
    if (sent.length) throw Error('Queued payload ran in a later runtime');
    return { retargetedPayloads: sent.length };
  });

  results.sendComposer = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression;
    const enqueue = app.enqueuePayload; const showNotice = app.showNotice;
    let notices = 0; app.showNotice = () => notices++;
    for (const outcome of ['reject', 'resolve']) {
      fresh(); const oldInput = document.querySelector('#message-input'); oldInput.value = 'old runtime draft';
      app.replyTarget = message(3);
      let settle;
      app.enqueuePayload = () => new Promise((resolve, reject) => { settle = outcome === 'reject' ? () => reject(new Error('late write failure')) : resolve; });
      const operation = app.handleSendText(new Event('submit'));
      app.lockNow(); fresh(); const nextReply = message(3); app.replyTarget = nextReply;
      settle(); await operation;
      if (oldInput.value || document.querySelector('#message-input').value || app.replyTarget !== nextReply || notices) throw Error(`Old send ${outcome} changed the later composer`);
    }
    app.enqueuePayload = enqueue; app.showNotice = showNotice;
    return { resolvedAfterRuntimeChange: 'ignored', rejectedAfterRuntimeChange: 'ignored' };
  });

  // Exercise the production IndexedDB encrypt/decrypt helpers with > 200 rows.
  await page.evaluate(async () => {
    const { vault, session, message } = window.regression;
    const records = [];
    for (let seq = 1; seq <= 620; seq++) {
      const payload = seq % 10 === 0 ? { v: 1, kind: 'gallery-image', sentAt: '2026-09-04T01:00:00.000Z', image: { blobId: `photo-${seq}`, originalName: `photo-${seq}.png`, originalSize: 10, mimeType: 'image/png' } } : undefined;
      records.push(message(seq, payload));
    }
    for (let offset = 0; offset < records.length; offset += 40) await Promise.all(records.slice(offset, offset + 40).map(record => vault.saveHistoryMessage(session, record)));
    window.regression.records = records;
  });

  // Delay WebCrypto within real IndexedDB pagination, then abort the runtime.
  for (const direction of ['older', 'newer']) {
    await page.evaluate((direction) => {
      const { app, fresh, message } = window.regression;
      fresh(); app.messages = new Map([[421, message(421)]]); app.renderMessages();
      app.historyHasMore = true; app.historyHasNewer = true; app.historyForwardCursor = 200;
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      let blocked = false;
      Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
        if (!blocked) { blocked = true; await new Promise(resolve => { window.releaseHistory = resolve; }); }
        return decrypt(...args);
      } });
      window.restoreDecrypt = () => Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: decrypt });
      window.pendingHistory = direction === 'older' ? app.loadOlderHistory(document.querySelector('#message-list')) : app.loadNewerHistory(document.querySelector('#message-list'));
    }, direction);
    await page.waitForFunction(() => typeof window.releaseHistory === 'function');
    results[`history-${direction}`] = await page.evaluate(async () => {
      const { app } = window.regression;
      app.lockNow();
      window.releaseHistory(); await window.pendingHistory;
      window.releaseHistory = undefined; window.restoreDecrypt();
      if (app.messages.size || document.querySelector('.message')) throw Error('Historical plaintext returned after lock');
      return { retainedMessages: app.messages.size, covered: Boolean(document.querySelector('.cover-trigger')) };
    });
  }

  // An away overlay deliberately leaves the chat DOM connected. A historical
  // page that began underneath it must not merge plaintext, rerender that
  // inactive list or surface an operational error when its decrypt completes.
  results.historyAwayOwner = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression;
    fresh(); app.messages = new Map([[421, message(421)]]); app.renderMessages();
    app.historyHasMore = true;
    const list = document.querySelector('#message-list');
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const renderMessages = app.renderMessages;
    const operationalError = app.operationalError;
    let blocked = false; let renderCalls = 0; let errorCalls = 0; let release;
    Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
      if (!blocked) { blocked = true; await new Promise(resolve => { release = resolve; }); }
      return decrypt(...args);
    } });
    app.renderMessages = function (...args) { renderCalls++; return renderMessages.apply(this, args); };
    app.operationalError = () => { errorCalls++; };
    const pending = app.loadOlderHistory(list);
    while (typeof release !== 'function') await new Promise(resolve => setTimeout(resolve));
    app.setActiveSurface('away');
    if (!list.isConnected) throw Error('Away-owner regression did not retain the underlying chat list');
    release(); await pending;
    Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: decrypt });
    app.renderMessages = renderMessages; app.operationalError = operationalError;
    if (renderCalls || errorCalls || app.messages.size !== 1 || app.historyLoading
      || list.hasAttribute('data-history-loading')) {
      throw Error(`Inactive connected chat accepted historical continuation: ${JSON.stringify({ renderCalls, errorCalls, messages: app.messages.size, historyLoading: app.historyLoading, marker: list.hasAttribute('data-history-loading') })}`);
    }
    return { connectedList: true, renderCalls, errorCalls, retainedMessages: app.messages.size };
  });

  results.localHistory = await page.evaluate(async () => {
    const { app, fresh, records } = window.regression;
    fresh(); app.messages = new Map(records.filter(record => record.seq > 420).map(record => [record.seq, record])); app.renderMessages();
    if (document.querySelector('[data-client-msg-id="message-3"]')) throw Error('Old reference unexpectedly started in the visible history page');
    await app.jumpToReplyTarget('message-3', 3);
    if (!document.querySelector('[data-client-msg-id="message-3"]')) throw Error('Local historical reference was not loaded');
    app.renderGallery();
    return { oldReferenceLoaded: true };
  });
  await page.locator('[data-gallery-load-more]:not(:disabled)').waitFor();
  const initialSafeImages = await page.locator('.gallery-tile').count();
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(), `${initialSafeImages}+`, 'Partial safe count does not disclose remaining local history');
  await page.locator('#gallery-toggle-visibility').click();
  let pages = 0;
  while (await page.locator('[data-gallery-load-more]').isVisible()) {
    await page.locator('[data-gallery-load-more]').click();
    await page.waitForFunction(() => !document.querySelector('[data-gallery-load-more]')?.disabled);
    if (++pages > 5) throw Error('Gallery scan did not advance');
  }
  results.gallery = { images: await page.locator('.gallery-tile').count(), olderImage: await page.locator('.gallery-tile[data-blob-id="photo-10"]').count(), pages };
  assert.equal(results.gallery.images, 62);
  assert.equal(results.gallery.olderImage, 1);
  assert.equal(await page.locator('[data-gallery-count="images"]').textContent(), '62', 'Completed safe pagination did not show its loaded count');
  assert.equal(await page.locator('.gallery-tile[data-revealed="true"]').count(), initialSafeImages, 'Loading older safe images automatically revealed them');
  results.gallerySpacing = await page.evaluate(() => {
    const grid = document.querySelector('.gallery-grid'); grid.scrollTop = grid.scrollHeight;
    const tile = [...grid.querySelectorAll('.gallery-tile')].at(-1).getBoundingClientRect();
    const label = grid.querySelector('.gallery-scan-status').getBoundingClientRect();
    const gap = label.top - tile.bottom;
    if (gap < 35 || Math.abs(tile.width - tile.height) > 1) throw Error(`Gallery compressed rows into the footer: gap=${gap}`);
    return { gap, squareTiles: true };
  });
  if (visualQaDirectory) await page.screenshot({ path: path.join(visualQaDirectory, 'gallery-bottom-spacing.png') });

  await page.locator('#gallery-toggle-visibility').click();
  assert.equal(await page.locator('.gallery-tile[data-revealed="true"]').count(), 62);
  await page.locator('#gallery-tab-files').click();
  await page.locator('#gallery-grid[aria-labelledby="gallery-tab-files"]').waitFor();
  await page.locator('#gallery-tab-images').click();
  await page.locator('[data-gallery-load-more]:not(:disabled)').waitFor();
  assert.equal(await page.locator('#gallery-toggle-visibility').getAttribute('aria-label'), '隐藏全部');
  await page.locator('#gallery-toggle-visibility').click();
  while (await page.locator('[data-gallery-load-more]').isVisible()) {
    await page.locator('[data-gallery-load-more]').click();
    await page.waitForFunction(() => !document.querySelector('[data-gallery-load-more]')?.disabled);
  }
  assert.equal(await page.locator('.gallery-tile[data-revealed="true"]').count(), 0, 'Hide all left an older unmounted safe page revealed');
  results.galleryPrivacyPagination = { newlyLoadedHidden: true, hideAllIncludesUnmountedPages: true };

  // Delay the first historical lookup, then jump to another visible reference.
  // Finishing the older lookup may not move focus/scroll to an obsolete intent.
  await page.evaluate(() => {
    const { app, fresh, records } = window.regression;
    fresh(); app.messages = new Map(records.filter(record => record.seq > 420).map(record => [record.seq, record])); app.renderMessages();
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let blocked = false;
    Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
      if (!blocked) { blocked = true; await new Promise(resolve => { window.releaseReplyLookup = resolve; }); }
      return decrypt(...args);
    } });
    window.restoreReplyDecrypt = () => Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: decrypt });
    window.pendingReplyLookup = app.jumpToReplyTarget('message-3', 3);
  });
  await page.waitForFunction(() => typeof window.releaseReplyLookup === 'function');
  results.replyIntent = await page.evaluate(async () => {
    const { app } = window.regression;
    await app.jumpToReplyTarget('message-619', 619);
    window.releaseReplyLookup(); await window.pendingReplyLookup; window.restoreReplyDecrypt();
    if (document.querySelector('[data-client-msg-id="message-3"]')) throw Error('Obsolete reference lookup changed the current history');
    if (!document.querySelector('[data-client-msg-id="message-619"]')?.classList.contains('is-highlighted')) throw Error('Latest reference lost its highlight');
    return { supersededLookupIgnored: true };
  });

  // A device-link result arriving after cleanup may not reopen its secret.
  results.deviceLinkRace = await page.evaluate(async () => {
    const { app, fresh } = window.regression;
    fresh(); const fetch = window.fetch;
    let release;
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith('/device-links')) return fetch(input, init);
      return new Promise(resolve => { release = () => resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); });
    };
    const operation = app.startDeviceLink(document.querySelector('#open-gallery'));
    app.lockNow(); release(); await operation;
    window.fetch = fetch;
    if (document.querySelector('.device-link-sheet')) throw Error('Device invitation reappeared after lock');
    return { leakedDialogs: 0 };
  });

  // Device approval safety-code generation must not repaint a later runtime.
  await page.evaluate(() => {
    const { app, fresh, session } = window.regression; fresh();
    session.vault.pendingDeviceLinkId = 'pending-regression';
    session.vault.pendingDeviceLinks = [{ linkId: 'pending-regression', secret: 'test' }];
    session.vault.members[0].addedBy = 'regression-peer';
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (...args) => {
      await new Promise(resolve => { window.releaseSafetyCode = resolve; });
      return digest(...args);
    } });
    window.restoreSafetyDigest = () => Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: digest });
    window.pendingSafetyCode = app.renderPendingDeviceLink();
  });
  await page.waitForFunction(() => typeof window.releaseSafetyCode === 'function');
  results.pendingLinkSafety = await page.evaluate(async () => {
    const { app, fresh, session } = window.regression;
    app.lockNow(); fresh(); window.releaseSafetyCode(); await window.pendingSafetyCode; window.restoreSafetyDigest();
    delete session.vault.pendingDeviceLinkId; delete session.vault.pendingDeviceLinks; delete session.vault.members[0].addedBy;
    if (!document.querySelector('.chat-shell') || document.querySelector('.device-safety-code')) throw Error('Old device safety code replaced the new runtime');
    return { delayedSafetyCodeIgnored: true };
  });

  for (const kind of ['join', 'link']) {
    results[`pending-${kind}-retry`] = await page.evaluate(async kind => {
      const { app, fresh } = window.regression; fresh();
      const method = kind === 'join' ? 'completePendingJoin' : 'completePendingDeviceLink';
      const original = app[method];
      let reject;
      app[method] = () => new Promise((_resolve, failure) => { reject = failure; });
      if (kind === 'join') app.renderPendingJoin(); else await app.renderPendingDeviceLink();
      document.querySelector(kind === 'join' ? '#retry-join' : '#retry-device-link').click();
      app.lockNow(); fresh(); reject(new Error('Late request failure'));
      await new Promise(resolve => setTimeout(resolve, 0)); app[method] = original;
      if (!document.querySelector('.chat-shell') || document.querySelector('.gateway')) throw Error(`Old pending ${kind} retry replaced the new runtime`);
      app.lockNow(); app.renderPendingJoin(); await app.renderPendingDeviceLink();
      if (!document.querySelector('.cover-trigger')) throw Error('Pending renderer replaced privacy cover');
      return { rejectedAfterRuntimeChange: 'ignored', coveredRender: 'ignored' };
    }, kind);
  }

  await page.evaluate(async () => {
    const { app, fresh, session } = window.regression;
    fresh();
    const origin = document.querySelector('#open-gallery'); origin.focus();
    await app.showDeviceInvite({
      v: 1,
      kind: 'device-link',
      roomId: crypto.randomUUID(),
      linkId: crypto.randomUUID(),
      secret: 's'.repeat(43),
      role: 'creator',
      authorizerId: crypto.randomUUID(),
      authorizerFingerprint: 'a'.repeat(43),
      creatorFingerprint: 'c'.repeat(43),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }, session, app.runtimeEpoch, origin);
  });
  await page.locator('.device-link-sheet.is-visible').waitFor();
  for (let index = 0; index < 7; index++) {
    await page.keyboard.press(index % 2 ? 'Shift+Tab' : 'Tab');
    const focusState = await page.evaluate(() => ({
      inside: Boolean(document.activeElement.closest('.device-link-sheet')),
      active: document.activeElement.outerHTML.slice(0, 180),
      obscured: document.documentElement.classList.contains('privacy-obscured'),
      covered: window.regression.app.privacyCovered,
    }));
    assert.equal(focusState.inside, true, `Dialog focus escaped on step ${index}: ${JSON.stringify(focusState)}`);
  }
  assert.equal(await page.locator('.chat-shell').evaluate(element => element.inert), true);
  await page.keyboard.press('Escape');
  await page.locator('.device-link-sheet').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'open-gallery');
  assert.equal(await page.locator('.chat-shell').evaluate(element => element.inert), false);
  results.deviceDialog = { focusTrapped: true, backgroundInert: true, focusRestored: true };

  // External route removal must release each dialog's ownership exactly once.
  results.dialogDetach = await page.evaluate(async () => {
    const { fresh } = window.regression; fresh();
    const { mountDialog, closeDialog } = await import('/src/lib/dialog.ts');
    const root = document.querySelector('#app'); const background = document.querySelector('.chat-shell');
    let closedA = 0; let closedB = 0;
    const abortA = new AbortController(); const abortB = new AbortController();
    const first = document.createElement('section'); first.innerHTML = '<button>First</button>'; root.append(first);
    mountDialog(first, { isActive: () => true, signal: abortA.signal, onClose: () => closedA++ });
    const second = document.createElement('section'); second.innerHTML = '<button>Second</button>'; root.append(second);
    mountDialog(second, { isActive: () => true, signal: abortB.signal, onClose: () => closedB++ });
    first.remove(); await Promise.resolve();
    if (!background.inert || closedA !== 1 || closeDialog(first)) throw Error('Removing first dialog released another dialog ownership or retained its closer');
    second.remove(); await Promise.resolve();
    if (background.inert || closedB !== 1 || closeDialog(second)) throw Error('Removing last dialog did not restore the background');
    abortA.abort(); abortB.abort();
    if (closedA !== 1 || closedB !== 1) throw Error('Disposed dialog retained abort listeners');
    return { overlappingDialogsReleased: true, onCloseCalledOnce: true, staleClosersRemoved: true };
  });

  results.exportPrivacy = await page.evaluate(() => {
    const { app, fresh } = window.regression;
    fresh(); const hasFocus = document.hasFocus.bind(document);
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    app.beginFileExport(); window.dispatchEvent(new Event('blur'));
    if (!app.privacyCovered) throw Error('Export blur did not cover private content');
    app.finishFileExport(true);
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: hasFocus });
    if (!app.privacyCovered || !document.querySelector('.cover-trigger')) throw Error('Suppressed export blur was not covered on completion');
    window.dispatchEvent(new Event('focus'));
    if (!app.privacyCovered) throw Error('Export return revealed private content');
    return { immediateBlurCovered: true };
  });

  // Measure structural work rather than relying on machine-specific timing.
  results.longHistory = await page.evaluate(() => {
    const { app, fresh, message } = window.regression;
    fresh(); app.messages = new Map(Array.from({ length: 5000 }, (_, index) => [index + 1, message(index + 1)]));
    const initialStart = performance.now(); app.renderMessages(); const initialMs = performance.now() - initialStart;
    const list = document.querySelector('#message-list');
    const focused = list.querySelector('[data-client-msg-id="message-3000"]'); focused.focus({ preventScroll: true });
    const observer = new MutationObserver(() => {}); observer.observe(list, { childList: true });
    app.messages.set(5001, message(5001));
    const updateStart = performance.now(); app.renderMessages({ scroll: 'position' }); const updateMs = performance.now() - updateStart;
    const mutations = observer.takeRecords(); observer.disconnect();
    const added = mutations.reduce((total, record) => total + record.addedNodes.length, 0);
    const removed = mutations.reduce((total, record) => total + record.removedNodes.length, 0);
    if (added !== 1 || removed !== 0 || document.activeElement !== focused) throw Error(`Full history was remounted: added=${added} removed=${removed}`);
    window.scrollTo(0, document.documentElement.scrollHeight / 2);
    let boundsReads = 0;
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () { if (this.classList.contains('message')) boundsReads++; return getRect.call(this); };
    const ordered = app.orderedMessages; app.orderedMessages = () => { throw Error('Scrolling sorted every message'); };
    app.captureChatAnchor();
    app.orderedMessages = ordered; HTMLElement.prototype.getBoundingClientRect = getRect;
    if (boundsReads > 16) throw Error(`Scroll anchor read too many rows: ${boundsReads}`);
    app.lockNow();
    return { rows: 5001, unchangedNodesRemoved: removed, newNodesAdded: added, anchorBoundsReads: boundsReads, focusPreserved: true, initialMs: Math.round(initialMs), appendMs: Math.round(updateMs) };
  });

  results.scrollWork = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 5000 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settle();
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    const captureAnchor = app.captureChatAnchor;
    const markVisible = app.markVisibleMessagesRead;
    const markRead = app.unreadCounter.markRead;
    const viewport = window.visualViewport;
    let boundsReads = 0; let anchorCalls = 0; let readCalls = 0;
    const acknowledged = [];
    app.unreadCounter.markRead = async (_vault, seq) => { acknowledged.push(seq); };
    const samples = [];
    try {
      for (const fraction of [0.1, 0.5, 0.9]) {
        window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * fraction);
        await settle();
        // Drive one real displacement after the previous frame is fully
        // accounted for, then prove a burst of duplicate notifications still
        // produces just one bookkeeping pass.
        window.scrollBy(0, 4);
        const top = document.querySelector('.chat-header').getBoundingClientRect().bottom;
        const bottom = window.composerBaseBounds().top;
        const visible = app.renderedMessageOrder.filter(row => {
          const rect = getRect.call(row); return rect.top < bottom && rect.bottom > top;
        });
        const expected = Math.max(...visible.map(row => app.renderedMessageSeq.get(row.dataset.clientMsgId)));
        boundsReads = 0; anchorCalls = 0; readCalls = 0; acknowledged.length = 0;
        HTMLElement.prototype.getBoundingClientRect = function () {
          if (this.classList.contains('message')) boundsReads++;
          return getRect.call(this);
        };
        app.captureChatAnchor = function (...args) { anchorCalls++; return captureAnchor.apply(this, args); };
        app.markVisibleMessagesRead = function (...args) { readCalls++; return markVisible.apply(this, args); };
        for (let i = 0; i < 12; i++) window.dispatchEvent(new Event('scroll'));
        if (boundsReads || anchorCalls || readCalls) throw Error('Scroll events synchronously measured history');
        await settle();
        if (anchorCalls !== 1 || readCalls !== 1) throw Error(`One frame repeated scroll bookkeeping: ${anchorCalls}/${readCalls}`);
        if (boundsReads > 48) throw Error(`Reading ${fraction * 100}% of history measured ${boundsReads} rows`);
        if (acknowledged.length !== 1 || acknowledged[0] !== expected) throw Error('Optimized read search acknowledged a message outside the visible chat area');
        samples.push({ historyPosition: fraction, events: 12, anchorCalls, readCalls, messageBoundsReads: boundsReads });
        HTMLElement.prototype.getBoundingClientRect = getRect;
        app.captureChatAnchor = captureAnchor; app.markVisibleMessagesRead = markVisible;
      }
      const rootStyle = document.documentElement.getAttribute('style');
      let rootStyleWrites = 0;
      const rootObserver = new MutationObserver(records => { rootStyleWrites += records.length; });
      rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      try {
        // A collapsing Safari toolbar reveals 60px over consecutive frames.
        // Each native event is merged into one animation frame; that frame
        // must position the composer immediately, without an
        // inherited viewport variable invalidating all 5000 message styles.
        for (const inset of [72, 60, 48, 36, 24, 12]) {
          const height = document.documentElement.clientHeight - inset;
          Object.defineProperty(viewport, 'height', { configurable: true, value: height });
          Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 0 });
          viewport.dispatchEvent(new Event('resize'));
          window.dispatchEvent(new Event('scroll'));
          await frame();
          const composer = document.querySelector('#composer');
          if (Math.abs(composer.getBoundingClientRect().bottom - height) > 1
            || composer.dataset.viewportMotion !== 'positioning' || getComputedStyle(composer).opacity !== '1'
            || getComputedStyle(composer).transform !== 'none') {
            throw Error('Composer disappeared or lagged the current toolbar frame');
          }
          if (document.querySelector('#message-list').style.getPropertyValue('--keyboard-space')) throw Error('Viewport spacing still inherits through the message history');
        }
        const composer = document.querySelector('#composer');
        const revealDeadline = performance.now() + 600;
        while (composer.dataset.viewportMotion && performance.now() < revealDeadline) await new Promise(requestAnimationFrame);
        const revealAnimation = composer.getAnimations().find(animation =>
          animation.effect?.getKeyframes().some(frame => frame.opacity !== undefined || frame.transform !== undefined));
        if (composer.dataset.viewportMotion || revealAnimation) {
          throw Error('Composer retained motion state or started an extra reveal animation after settlement');
        }
        if (getComputedStyle(composer).opacity !== '1'
          || Math.abs(window.composerBaseBounds().bottom - (document.documentElement.clientHeight - 12)) > 1) {
          throw Error('Composer reveal did not finish at the settled viewport edge');
        }
        rootStyleWrites += rootObserver.takeRecords().length;
        if (rootStyleWrites || document.documentElement.getAttribute('style') !== rootStyle) throw Error('Toolbar animation rewrote inherited root viewport styles');
      } finally { rootObserver.disconnect(); }
      return { rows: 5000, samples, toolbarFrames: 6, rootStyleWrites, revealDuration: 280 };
    } finally {
      HTMLElement.prototype.getBoundingClientRect = getRect;
      app.captureChatAnchor = captureAnchor; app.markVisibleMessagesRead = markVisible;
      app.unreadCounter.markRead = markRead;
      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize')); await settle();
    }
  });

  results.manualScrollEndpointBookkeeping = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression;
    fresh();
    app.messages = new Map(Array.from({ length: 120 }, (_, index) => [index + 1, message(index + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const waitForReveal = async () => {
      const composer = document.querySelector('#composer');
      const deadline = performance.now() + 1200;
      while ((composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1)
        && performance.now() < deadline) await frame();
      if (composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) {
        throw Error('Manual scroll did not reach its stable composer endpoint');
      }
    };
    await waitForReveal();
    const list = document.querySelector('#message-list');
    const loadOlder = app.loadOlderHistory;
    const loadNewer = app.loadNewerHistory;
    const captureAnchor = app.captureChatAnchor;
    const markVisible = app.markVisibleMessagesRead;
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    let olderCalls = 0; let newerCalls = 0; let anchorCalls = 0; let readCalls = 0; let bottomBoundsReads = 0;
    app.loadOlderHistory = async target => { if (target === list) olderCalls++; };
    app.loadNewerHistory = async target => { if (target === list) newerCalls++; };
    app.captureChatAnchor = function (...args) { anchorCalls++; return captureAnchor.apply(this, args); };
    app.markVisibleMessagesRead = function () { readCalls++; };
    HTMLElement.prototype.getBoundingClientRect = function (...args) {
      if (this.id === 'chat-bottom-control') bottomBoundsReads++;
      return getRect.apply(this, args);
    };
    try {
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
      window.scrollTo(0, 0);
      window.dispatchEvent(new Event('scroll'));
      await frame(); await frame();
      if (!app.chatViewportMotion?.moving || olderCalls || newerCalls || anchorCalls || readCalls || bottomBoundsReads) {
        throw Error(`Manual-scroll motion performed message bookkeeping before settlement: ${JSON.stringify({ olderCalls, newerCalls, anchorCalls, readCalls, bottomBoundsReads })}`);
      }
      await waitForReveal();
      if (olderCalls !== 1 || newerCalls !== 0 || anchorCalls !== 1 || readCalls !== 1 || bottomBoundsReads !== 1) {
        throw Error(`Manual-scroll endpoint did not commit exactly one bookkeeping pass: ${JSON.stringify({ olderCalls, newerCalls, anchorCalls, readCalls, bottomBoundsReads })}`);
      }
      return { duringMotion: 0, olderCalls, newerCalls, anchorCalls, readCalls, bottomBoundsReads };
    } finally {
      app.loadOlderHistory = loadOlder;
      app.loadNewerHistory = loadNewer;
      app.captureChatAnchor = captureAnchor;
      app.markVisibleMessagesRead = markVisible;
      HTMLElement.prototype.getBoundingClientRect = getRect;
    }
  });

  results.stableMediaReceipts = await page.evaluate(async () => {
    const { app, fresh, message, session } = window.regression; fresh();
    const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600"><rect width="900" height="1600" fill="navy"/></svg>'], { type: 'image/svg+xml' });
    const manifest = { v: 1, blobId: 'stable-media-receipt', originalName: 'portrait.svg', originalSize: blob.size, mimeType: blob.type };
    app.cacheLocalImage(manifest, blob);
    const cached = app.imageCache.get(manifest.blobId); cached.width = 900; cached.height = 1600;
    const decoded = new Image(); decoded.src = cached.url; await decoded.decode();
    await app.ensureChatConcealedImage(manifest, cached, decoded);
    const outgoing = { ...message(1, { v: 1, kind: 'image', image: manifest, sentAt: '2026-09-04T01:00:00.000Z' }), senderId: session.vault.identity.publicBundle.deviceId, status: 'pending' };
    app.pending.set(outgoing.clientMsgId, { ...outgoing, seq: Number.MAX_SAFE_INTEGER }); app.renderMessages({ scroll: 'bottom' });
    const row = document.querySelector('[data-client-msg-id="message-1"]');
    const media = row.querySelector('img'); await media.decode();
    const preview = row.querySelector('.image-preview');
    const initial = preview.getBoundingClientRect();
    if (initial.width > 290 || initial.height > 322) throw Error(`Chat media remained oversized: ${initial.width} x ${initial.height}`);
    const initialOpacity = getComputedStyle(row).opacity;
    const viewport = visualViewport;
    try {
      for (const height of [780, 808, 844, 816, 788]) {
        Object.defineProperty(viewport, 'height', { configurable: true, value: height });
        viewport.dispatchEvent(new Event('resize'));
        const rect = preview.getBoundingClientRect();
        if (Math.abs(rect.width - initial.width) > 1 || Math.abs(rect.height - initial.height) > 1) throw Error('Toolbar geometry resized loaded media');
      }
      for (const status of ['stored', 'delivered']) {
        app.pending.delete(outgoing.clientMsgId);
        app.messages.set(1, { ...outgoing, payload: structuredClone(outgoing.payload), status }); app.renderMessages();
        if (document.querySelector('[data-client-msg-id="message-1"]') !== row || row.querySelector('img') !== media) throw Error('Receipt replaced decoded media or its message row');
        if (getComputedStyle(row).opacity !== initialOpacity || !row.classList.contains(`is-${status}`)) throw Error('Receipt flashed full-message opacity or failed to update status');
        if (row.querySelectorAll('.message-delivery path').length !== (status === 'delivered' ? 2 : 1)) throw Error('Preserved message lost delivery decoration');
      }
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      if (document.querySelectorAll('.message-reaction-picker [data-reaction]').length !== 6) throw Error('Retained message actions used the unconfirmed pending sequence');
      app.closeMessageActions(false, false);
      return { compactBounds: { width: initial.width, height: initial.height }, toolbarSizes: 'stable', decodedNode: 'preserved through both receipts', opacity: initialOpacity };
    } finally {
      delete viewport.height; viewport.dispatchEvent(new Event('resize'));
    }
  });

  results.sendMotion = await page.evaluate(async () => {
    const { app, fresh, message, session } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 40 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame(); await frame();
    const input = document.querySelector('#message-input');
    input.value = '发送时标题与输入栏保持稳定'; input.dispatchEvent(new Event('input'));
    await frame(); await frame();
    const header = document.querySelector('.chat-header'); const composer = document.querySelector('#composer');
    const headerTop = header.getBoundingClientRect().top; const composerTop = composer.getBoundingClientRect().top;
    const previous = document.querySelector('[data-client-msg-id="message-40"]');
    const previousBubble = previous.querySelector('.message-bubble');
    const previousTop = previousBubble.getBoundingClientRect().top;
    const outgoing = { ...message(41), senderId: session.vault.identity.publicBundle.deviceId, status: 'pending' };
    app.messages.set(41, outgoing); app.renderMessages({ scroll: 'send' });
    input.value = ''; input.dispatchEvent(new Event('input'));
    const animated = [...app.chatMessageAnimations];
    if (!animated.length) throw Error('Send skipped the message translation');
    const topAtStart = previousBubble.getBoundingClientRect().top;
    if (Math.abs(topAtStart - previousTop) > 2) throw Error('Send snapped existing messages to their destination before animation');
    if (animated.some(animation => !animation.effect.target.closest('.message'))) throw Error('Send motion included a fixed page control');
    await new Promise(resolve => setTimeout(resolve, 85));
    const topDuring = previousBubble.getBoundingClientRect().top;
    const newest = document.querySelector('[data-client-msg-id="message-41"]');
    app.messages.set(41, { ...outgoing, status: 'delivered' }); app.renderMessages();
    if (document.querySelector('[data-client-msg-id="message-41"]') !== newest || !animated.some(animation => animation.playState === 'running')) throw Error('Receipt interrupted an active send animation');
    await Promise.all(animated.map(animation => animation.finished));
    const topAtEnd = previousBubble.getBoundingClientRect().top;
    if (!(topAtStart > topDuring && topDuring > topAtEnd)) throw Error(`Send did not translate smoothly upward: ${topAtStart}, ${topDuring}, ${topAtEnd}`);
    if (Math.abs(header.getBoundingClientRect().top - headerTop) > 1 || Math.abs(composer.getBoundingClientRect().top - composerTop) > 1) throw Error('Sending moved the header or single-line composer');
    if (app.chatBottomGap() > 2) throw Error('Animated send lost the latest-message anchor');
    app.messages.set(42, message(42)); app.renderMessages({ scroll: 'send' });
    if (!app.chatMessageAnimations.size) throw Error('Second send did not start motion');
    document.querySelector('#message-list').dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }));
    if (app.chatMessageAnimations.size || app.chatPinnedToBottom) throw Error('History gesture did not cancel send motion and follow');
    return { duration: 280, visibleContentOnly: true, receiptPreserved: true, fixedBarsStable: true, upwardSamples: [topAtStart, topDuring, topAtEnd], gestureCancels: true };
  });

  results.continuousViewportSampling = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages.set(1, message(1)); app.renderMessages({ scroll: 'bottom' });
    const viewport = visualViewport;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      // No interaction or browser event starts this late native-toolbar frame.
      Object.defineProperty(viewport, 'height', { configurable: true, value: 780 });
      await frame();
      const composer = document.querySelector('#composer');
      const bottom = composer.getBoundingClientRect().bottom;
      const concealShift = new DOMMatrix(getComputedStyle(composer).transform).f;
      if (Math.abs(bottom - concealShift - 780) > 1 || composer.dataset.viewportMotion !== 'positioning') {
        throw Error(`Input stopped sampling or concealing at toolbar geometry after the previous interaction: ${bottom}`);
      }
      // The media viewer leaves and returns to the existing chat without a
      // layout mount or changed viewport; dismissal must restart sampling.
      app.setActiveSurface('away');
      app.setActiveSurface('chat');
      Object.defineProperty(viewport, 'height', { configurable: true, value: 808 });
      await frame();
      const resumedBottom = document.querySelector('#composer').getBoundingClientRect().bottom;
      const resumedShift = new DOMMatrix(getComputedStyle(composer).transform).f;
      if (Math.abs(resumedBottom - resumedShift - 808) > 1 || composer.dataset.viewportMotion !== 'positioning') {
        throw Error(`Returning to unchanged chat geometry failed to restart concealed sampling: ${resumedBottom}`);
      }
      return { sameGeometryReturn: 'sampling resumed', eventlessChangeAfterIdle: 'followed in one frame' };
    } finally {
      delete viewport.height; viewport.dispatchEvent(new Event('resize')); await frame();
    }
  });

  results.queuedViewportLock = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 50 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settle();
    const viewport = window.visualViewport;
    const cancelFrame = window.cancelAnimationFrame;
    const scrollBottom = app.scrollChatToBottom;
    const markVisible = app.markVisibleMessagesRead;
    let cancelledFrames = 0; let lateWork = 0; let locked = false;
    window.cancelAnimationFrame = id => { cancelledFrames++; cancelFrame.call(window, id); };
    app.scrollChatToBottom = function (...args) { if (locked) lateWork++; return scrollBottom.apply(this, args); };
    app.markVisibleMessagesRead = function (...args) { if (locked) lateWork++; return markVisible.apply(this, args); };
    try {
      Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
      viewport.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('scroll'));
      app.lockNow(); locked = true;
      if (app.chatLayoutElements !== null || app.chatScrollFrame !== null) throw Error('Lock retained cached chat elements or scheduled scrolling');
      if (cancelledFrames < 2) throw Error('Lock did not cancel both queued viewport and scroll frames');
      await settle();
      if (lateWork) throw Error('Queued viewport work survived privacy teardown');
      return { cachedChatReleased: true, queuedFramesCancelled: cancelledFrames, lateWork: 0 };
    } finally {
      window.cancelAnimationFrame = cancelFrame;
      app.scrollChatToBottom = scrollBottom; app.markVisibleMessagesRead = markVisible;
      delete viewport.height; viewport.dispatchEvent(new Event('resize')); await settle();
    }
  });

  results.documentScroll = await page.evaluate(async () => {
    const { app, fresh, message, session } = window.regression; fresh();
    app.uiPreferences.recoveryReminderDismissed = true; app.renderChat();
    app.messages = new Map(Array.from({ length: 50 }, (_, i) => [i + 1, {
      ...message(i + 1, { v: 1, kind: 'text', text: i % 2 ? '消息会从玻璃控件后面自然透过。' : '看到了，等会儿见。', sentAt: '2026-09-04T01:00:00.000Z' }),
      senderId: i % 2 ? session.vault.identity.publicBundle.deviceId : 'regression-peer', status: i === 49 ? 'stored' : 'delivered',
    }]));
    app.renderMessages({ scroll: 'bottom' });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const settleViewport = async () => {
      const composer = document.querySelector('#composer');
      const deadline = performance.now() + 1200;
      // Native viewport events enter the application on the next merged frame;
      // do not mistake the still-visible pre-event state for a settled endpoint.
      await new Promise(resolve => requestAnimationFrame(resolve));
      while ((composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) && performance.now() < deadline) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) throw Error('Viewport did not reach its stable endpoint');
    };
    await settle();
    const list = document.querySelector('#message-list');
    if (getComputedStyle(list).overflowY !== 'visible' || window.scrollY <= 0) throw Error('Chat still clips a nested scroller');
    const top = document.querySelector('.chat-header').getBoundingClientRect().top;
    window.scrollBy(0, -240); await settle();
    if (Math.abs(document.querySelector('.chat-header').getBoundingClientRect().top - top) > 1) throw Error('Native scrolling moved the header');
    const saved = structuredClone(app.captureChatAnchor());
    if (saved.pinnedToBottom) throw Error('Native user scroll was pinned back to the bottom');
    app.renderMessages(); await settle();
    if (Math.abs(app.captureChatAnchor().offset - saved.offset) > 2) throw Error('Native scroll update lost the reading anchor');
    const { mountDialog } = await import('/src/lib/dialog.ts');
    const sheet = document.createElement('section'); sheet.innerHTML = '<button>关闭</button>'; app.root.append(sheet);
    const dialog = mountDialog(sheet, { isActive: () => true });
    if (getComputedStyle(document.documentElement).overflowY !== 'hidden') throw Error('Modal did not lock document scrolling');
    dialog.close({ animate: false });
    if (getComputedStyle(document.documentElement).overflowY !== 'auto') throw Error('Closing modal did not restore document scrolling');
    const viewport = window.visualViewport;
    if (viewport) {
      app.renderMessages({ scroll: 'bottom' }); await settle();
      Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 24 });
      viewport.dispatchEvent(new Event('resize')); await settleViewport();
      const composer = window.composerBaseBounds();
      const latest = list.lastElementChild.getBoundingClientRect();
      if (Math.abs(composer.bottom - 444) > 1 || latest.bottom > composer.top - 12) {
        throw Error(`Keyboard viewport covered the latest message or displaced the composer: ${JSON.stringify({ composer, latest: latest.toJSON(), paddingBottom: getComputedStyle(list).paddingBottom, minHeight: getComputedStyle(list).minHeight, scrollY, scrollHeight: document.documentElement.scrollHeight, pinned: app.chatPinnedToBottom })}`);
      }
      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize')); await settleViewport();
      if (app.chatBottomGap() > 2) throw Error('Closing the keyboard lost the latest message');
    }
    return { scroller: 'document', headerFixed: true, scrollPreserved: true, dialogScrollLock: true, keyboardViewport: 'composer and latest message remain visible' };
  });

  results.viewportPanStability = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 60 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const settleViewport = async () => {
      const composer = document.querySelector('#composer');
      const deadline = performance.now() + 1200;
      await new Promise(resolve => requestAnimationFrame(resolve));
      while ((app.composerHeightMotion || composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) && performance.now() < deadline) {
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (app.composerHeightMotion || composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) throw Error('Viewport pan fixture did not reach its stable endpoint');
    };
    await settle();
    const viewport = window.visualViewport;
    const list = document.querySelector('#message-list');
    const style = document.documentElement.style;
    style.setProperty('--safe-bottom', '34px');
    Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 24 });
    viewport.dispatchEvent(new Event('resize')); await settleViewport();
    const composer = window.composerBaseBounds();
    const visualComposer = document.querySelector('#composer').getBoundingClientRect();
    const input = document.querySelector('#message-input').getBoundingClientRect();
    const keyboardInnerGap = visualComposer.bottom - input.bottom;
    if (Math.abs(composer.bottom - 444) > 1 || keyboardInnerGap > 10) throw Error('Keyboard retained an extra safe-area gap below the input');
    const padding = getComputedStyle(list).paddingBottom;
    const scrollTo = window.scrollTo; const scrollBy = window.scrollBy;
    let corrections = 0;
    window.scrollTo = (...args) => { corrections++; scrollTo.apply(window, args); };
    window.scrollBy = (...args) => { corrections++; scrollBy.apply(window, args); };
    try {
      // A viewport pan, even while pinned, must not change document extent or
      // force-scroll. This used to feed Safari's pan back into itself.
      for (const top of [30, 18, 24]) {
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
        viewport.dispatchEvent(new Event('scroll')); await settle();
        if (getComputedStyle(list).paddingBottom !== padding) throw Error('Viewport pan changed document padding');
      }
      await settleViewport();
      if (corrections) throw Error(`Offset-only panning forced ${corrections} scrolls`);
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }));
      scrollBy.call(window, 0, -12); await settle();
      if (app.chatPinnedToBottom || app.captureChatAnchor().pinnedToBottom) throw Error('A small upward scroll was still pinned');
      const before = window.scrollY;
      for (const top of [32, 20, 24]) {
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
        viewport.dispatchEvent(new Event('scroll')); await settle();
      }
      await settleViewport();
      if (window.scrollY !== before || corrections) throw Error('Viewport panning pulled the reader back to the bottom');
      app.messages.set(60, { ...app.messages.get(60), status: 'stored' });
      app.renderMessages(); await settle();
      if (Math.abs(window.scrollY - before) > 1 || app.captureChatAnchor().pinnedToBottom) throw Error('Receipt update re-pinned a small upward scroll');
      const anchor = structuredClone(app.captureChatAnchor());
      const textarea = document.querySelector('#message-input');
      textarea.value = '多行草稿\n'.repeat(5); textarea.dispatchEvent(new Event('input')); await settle();
      if (app.captureChatAnchor().clientMsgId !== anchor.clientMsgId || Math.abs(app.captureChatAnchor().offset - anchor.offset) > 1) throw Error('Composer growth moved an unpinned reader');
      corrections = 0;
      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize')); await settleViewport();
      if (app.chatPinnedToBottom || corrections) throw Error('Keyboard dismissal forced bottom-follow after upward intent');
      scrollTo.call(window, 0, document.documentElement.scrollHeight); await settle();
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: 12, bubbles: true }));
      if (!app.captureChatAnchor().pinnedToBottom) throw Error('Downward intent at the clamped bottom did not resume follow');
      Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
      viewport.dispatchEvent(new Event('resize')); await settleViewport();
      textarea.focus({ preventScroll: true });
      const beforeGesture = { focused: document.activeElement?.id, connected: textarea.isConnected, disabled: textarea.disabled, visibility: getComputedStyle(textarea).visibility, obscured: document.documentElement.classList.contains('privacy-obscured'), inert: !!textarea.closest('[inert]') };
      list.lastElementChild.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      if (document.activeElement !== textarea) throw Error('History pointerdown prematurely blurred the keyboard');
      list.lastElementChild.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      const gestureStart = { beforeGesture, pinned: app.chatPinnedToBottom, intent: app.chatScrollIntent, focused: document.activeElement?.id, keyboard: document.documentElement.dataset.keyboardOpen };
      corrections = 0;
      delete viewport.height; viewport.dispatchEvent(new Event('resize')); await settleViewport();
      if (app.chatPinnedToBottom || corrections) throw Error(`Keyboard blur before touchmove stole the gesture position: ${JSON.stringify({ gestureStart, pinned: app.chatPinnedToBottom, intent: app.chatScrollIntent, corrections })}`);
    } finally {
      window.scrollTo = scrollTo; window.scrollBy = scrollBy;
      delete viewport.height; delete viewport.offsetTop;
      style.removeProperty('--safe-bottom');
      viewport.dispatchEvent(new Event('resize')); await settleViewport();
    }
    return { smallUpwardScroll: 'preserved', panScrollCorrections: 0, keyboardInnerGap, ackAndComposerGrowth: 'anchor preserved' };
  });

  results.keyboardEventFrames = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 70 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    await frame(); await frame();
    const viewport = window.visualViewport;
    const list = document.querySelector('#message-list');
    const input = document.querySelector('#message-input');
    const composer = document.querySelector('#composer');
    const header = document.querySelector('.chat-header');
    const layoutHeight = document.documentElement.clientHeight;
    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const scrollTo = window.scrollTo; const scrollBy = window.scrollBy;
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    const alignBottom = app.alignChatBottom;
    const listStyle = list.style;
    let forcedScrolls = 0; let bottomReads = 0; let alignments = 0; let listWrites = [];
    const resetWork = () => { forcedScrolls = 0; bottomReads = 0; alignments = 0; listWrites = []; };
    const documentGeometry = () => ({
      paddingBottom: listStyle.getPropertyValue('padding-bottom'),
      minHeight: listStyle.getPropertyValue('min-height'),
    });
    const assertVisibleConversation = (label, top, bottom) => {
      const contentTop = Math.max(top, header.getBoundingClientRect().bottom);
      const contentBottom = Math.min(bottom, window.composerBaseBounds().top);
      const visible = [...list.querySelectorAll('.message')].some(row => {
        const bounds = getRect.call(row);
        return bounds.top < contentBottom && bounds.bottom > contentTop;
      });
      if (!visible || contentBottom <= contentTop) throw Error(`${label} exposed an empty conversation viewport`);
    };
    const assertMergedFrame = (label, height, offsetTop) => {
      const top = Math.max(0, Math.min(offsetTop, layoutHeight - height));
      const headerStyle = getComputedStyle(header);
      const headerBounds = header.getBoundingClientRect();
      const composerBounds = window.composerBaseBounds();
      if (Math.abs(headerBounds.top - top) > 1 || headerStyle.opacity !== '1'
        || header.getAnimations().some(animation => animation.playState === 'running')) {
        throw Error(`${label} moved, faded or animated the screen-anchored title`);
      }
      if (composer.dataset.viewportMotion !== 'positioning' || getComputedStyle(composer).opacity !== '1'
        || Math.abs(composerBounds.bottom - top - height) > 1) {
        throw Error(`${label} hid or misplaced intermediate composer geometry`);
      }
      assertVisibleConversation(label, top, top + height);
    };
    const position = async (label, height, offsetTop) => {
      Object.defineProperty(viewport, 'height', { configurable: true, value: height });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: offsetTop });
      // Safari's innerHeight and its fixed-position layout viewport can differ.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      viewport.dispatchEvent(new Event('resize'));
      // Focus/panning can interleave a native document scroll before rAF.
      window.dispatchEvent(new Event('scroll'));
      await frame();
      assertMergedFrame(label, height, offsetTop);
    };
    const assertTransitionIdle = (label, geometry) => {
      const current = documentGeometry();
      if (current.paddingBottom !== geometry.paddingBottom || current.minHeight !== geometry.minHeight || listWrites.length) {
        throw Error(`${label} committed message-list geometry before the keyboard endpoint: ${JSON.stringify({ geometry, current, listWrites })}`);
      }
      if (bottomReads || forcedScrolls || alignments) {
        throw Error(`${label} performed document work during keyboard motion: ${JSON.stringify({ bottomReads, forcedScrolls, alignments })}`);
      }
    };
    const waitForReveal = async label => {
      const deadline = performance.now() + 1200;
      while ((composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) && performance.now() < deadline) await frame();
      if (composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) throw Error(`${label} never revealed at its final keyboard endpoint`);
    };
    const assertEndpointCommit = (label, before) => {
      const after = documentGeometry();
      const properties = listWrites.map(write => write.property);
      if (after.paddingBottom === before.paddingBottom || after.minHeight === before.minHeight
        || properties.length !== 2 || properties[0] !== 'padding-bottom' || properties[1] !== 'min-height') {
        throw Error(`${label} did not atomically commit one padding/min-height pair: ${JSON.stringify({ before, after, listWrites })}`);
      }
      if (alignments !== 1 || forcedScrolls > 1 || bottomReads !== 1) {
        throw Error(`${label} did not perform exactly one endpoint alignment and control measurement: ${JSON.stringify({ alignments, forcedScrolls, bottomReads })}`);
      }
      const gap = window.composerBaseBounds().top - list.lastElementChild.getBoundingClientRect().bottom;
      if (!app.chatPinnedToBottom || Math.abs(gap - 64) > 2) throw Error(`${label} failed its final bottom alignment: gap=${gap}`);
      return { before, after, listWrites: [...listWrites], alignments, forcedScrolls, bottomReads, gap };
    };
    window.scrollTo = (...args) => { forcedScrolls++; scrollTo.apply(window, args); };
    window.scrollBy = (...args) => { forcedScrolls++; scrollBy.apply(window, args); };
    HTMLElement.prototype.getBoundingClientRect = function (...args) {
      if (this.id === 'chat-bottom-control') bottomReads++;
      return getRect.apply(this, args);
    };
    CSSStyleDeclaration.prototype.setProperty = function (property, value, priority) {
      if (this === listStyle && (property === 'padding-bottom' || property === 'min-height')) listWrites.push({ property, value });
      return setProperty.call(this, property, value, priority);
    };
    app.alignChatBottom = function (...args) { alignments++; return alignBottom.apply(this, args); };
    document.querySelector('#chat-bottom-control').getBoundingClientRect();
    if (bottomReads !== 1) throw Error('Bottom-control bounds instrumentation did not observe its sentinel read');
    bottomReads = 0;
    try {
      input.focus({ preventScroll: true });
      const closedGeometry = documentGeometry(); resetWork();
      await position('opening plateau frame', 780, 40);
      await delay(220); await frame();
      assertMergedFrame('opening plateau after 220ms', 780, 40);
      assertTransitionIdle('opening plateau', closedGeometry);
      await position('opening endpoint frame', 430, 260);
      assertTransitionIdle('opening endpoint before settle', closedGeometry);
      await waitForReveal('keyboard opening');
      if (document.documentElement.dataset.keyboardOpen !== 'true') throw Error('Final opening endpoint did not set keyboard state');
      const opening = assertEndpointCommit('keyboard opening', closedGeometry);

      input.blur();
      const openGeometry = documentGeometry(); resetWork();
      await position('closing plateau frame', 610, 180);
      await delay(220); await frame();
      assertMergedFrame('closing plateau after 220ms', 610, 180);
      assertTransitionIdle('closing plateau', openGeometry);
      await position('closing endpoint frame', layoutHeight, 280);
      assertTransitionIdle('closing endpoint before settle', openGeometry);
      await waitForReveal('keyboard closing');
      if (document.documentElement.dataset.keyboardOpen !== 'false') throw Error('Final closing endpoint retained keyboard state');
      if (Math.abs(header.getBoundingClientRect().top) > 1 || getComputedStyle(header).opacity !== '1') throw Error('Closed endpoint displaced or faded the title');
      const closing = assertEndpointCommit('keyboard closing', openGeometry);
      return { histories: 70, plateauMs: 220, opening, closing, visibleTitleEveryMergedFrame: true, nonEmptyConversationEveryMergedFrame: true };
    } finally {
      window.scrollTo = scrollTo; window.scrollBy = scrollBy;
      HTMLElement.prototype.getBoundingClientRect = getRect;
      CSSStyleDeclaration.prototype.setProperty = setProperty;
      app.alignChatBottom = alignBottom;
      if (innerHeightDescriptor) Object.defineProperty(window, 'innerHeight', innerHeightDescriptor);
      else delete window.innerHeight;
      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize')); await frame(); await frame();
    }
  });

  results.keyboardIntermediateEdges = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression;
    const viewport = window.visualViewport;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const waitForMotion = async (composer, moving, timeout = 2_800) => {
      const deadline = performance.now() + timeout;
      while (Boolean(app.chatViewportMotion?.moving) !== moving && performance.now() < deadline) await frame();
      if (Boolean(app.chatViewportMotion?.moving) !== moving) throw Error(`Viewport motion did not become ${moving ? 'active' : 'settled'}`);
      if (!moving) {
        while (Number(getComputedStyle(composer).opacity) !== 1 && performance.now() < deadline) await frame();
        if (Number(getComputedStyle(composer).opacity) !== 1) throw Error('Settled intermediate-edge composer did not finish revealing');
      }
    };
    let originalTrack;
    let originalAlign;
    let originalUpdate;
    try {
      app.lockNow();
      Object.defineProperty(viewport, 'height', { configurable: true, value: 680 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 40 });
      viewport.dispatchEvent(new Event('resize')); await frame();
      fresh();
      app.messages = new Map(Array.from({ length: 40 }, (_, index) => [index + 1, message(index + 1)]));
      app.renderMessages({ scroll: 'bottom' });
      const composer = document.querySelector('#composer');
      const list = document.querySelector('#message-list');
      if (composer.dataset.viewportMotion !== 'positioning' || Number(getComputedStyle(composer).opacity) !== 1
        || list.style.getPropertyValue('padding-bottom') || list.style.getPropertyValue('min-height')) {
        throw Error('Chat hid the composer or committed list geometry at an intermediate keyboard frame');
      }
      Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 180 });
      viewport.dispatchEvent(new Event('resize'));
      await waitForMotion(composer, false);

      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize'));
      await frame();
      await waitForMotion(composer, false);
      app.scrollChatToBottom(); await frame();

      // Stop the continuous owner so a controlled changed sample, rather than
      // an intervening rAF, is the exact sample that crosses the hard bound.
      originalTrack = app.trackChatViewport;
      app.trackChatViewport = () => {};
      app.cancelViewportWork();
      Object.defineProperty(viewport, 'height', { configurable: true, value: 680 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 40 });
      app.syncViewport();
      if (!app.chatViewportMotion?.moving) throw Error('Controlled intermediate baseline was not concealed');
      await new Promise(resolve => setTimeout(resolve, 1_700));
      let alignments = 0; let updates = 0;
      originalAlign = app.alignChatBottom;
      originalUpdate = app.chatBottomControl.update;
      app.alignChatBottom = function (...args) { alignments++; return originalAlign.apply(this, args); };
      app.chatBottomControl.update = function (...args) { updates++; return originalUpdate.apply(this, args); };
      Object.defineProperty(viewport, 'height', { configurable: true, value: 679 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 41 });
      app.syncViewport();
      if (app.chatViewportMotion?.moving || composer.dataset.viewportMotion || alignments !== 1 || updates !== 1
        || Math.abs(window.composerBaseBounds().bottom - 720) > 1) {
        throw Error(`Changed-frame hard fallback duplicated or used stale geometry: ${JSON.stringify({ moving: app.chatViewportMotion?.moving, state: composer.dataset.viewportMotion, alignments, updates, composerBottom: window.composerBaseBounds().bottom })}`);
      }
      return { initialIntermediate: 'concealed', changedFrameHardFallback: 'one endpoint batch', alignments, updates };
    } finally {
      if (originalAlign) app.alignChatBottom = originalAlign;
      if (originalUpdate && app.chatBottomControl) app.chatBottomControl.update = originalUpdate;
      if (originalTrack) app.trackChatViewport = originalTrack;
      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize')); await frame(); await frame();
    }
  });

  results.keyboardGestureAndMotion = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 70 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const settled = async () => {
      for (let index = 0; index < 180; index++) {
        await frame();
        if (!app.composerHeightMotion && !app.chatBottomControl?.scrolling && !composer.dataset.viewportMotion
          && Number(getComputedStyle(composer).opacity) === 1) return;
      }
      throw Error('Composer failed to finish viewport and input-height motion');
    };
    const viewport = window.visualViewport;
    const layoutHeight = document.documentElement.clientHeight;
    const composer = document.querySelector('#composer');
    const header = document.querySelector('.chat-header');
    const input = document.querySelector('#message-input');
    const list = document.querySelector('#message-list');
    const target = list.lastElementChild;
    const alignChatBottom = app.alignChatBottom;
    const touch = (type, positions) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: positions.map(clientY => ({ clientY })) });
      target.dispatchEvent(event); return event;
    };
    const position = async (height, top) => {
      Object.defineProperty(viewport, 'height', { configurable: true, value: height });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
      viewport.dispatchEvent(new Event('resize'));
      await frame();
      const headerStyle = getComputedStyle(header);
      if (Math.abs(header.getBoundingClientRect().top - top) > 1 || headerStyle.opacity !== '1'
        || header.getAnimations().some(animation => animation.playState === 'running')) throw Error('Keyboard frame moved or faded the screen-anchored title');
      if (composer.dataset.viewportMotion !== 'positioning' || getComputedStyle(composer).opacity !== '1') throw Error(`Intermediate keyboard geometry hid the composer: ${JSON.stringify({ state: composer.dataset.viewportMotion, opacity: getComputedStyle(composer).opacity })}`);
      if (Math.abs(window.composerBaseBounds().bottom - height - top) > 1) throw Error('Visible composer geometry lagged a viewport frame');
    };
    try {
      await settled();
      input.value = '保留这份草稿'; input.setSelectionRange(2, 4); input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
      if (composer.dataset.viewportMotion || composer.inert || input.disabled) throw Error('Input pointerdown concealed or disabled the field before iOS could focus it');
      // WebKit may publish its first keyboard-sized viewport before the
      // textarea focus event. Material movement away from the last closed
      // endpoint must infer the opening target, block passive document work
      // through a long intermediate plateau, and still allow an explicit
      // return-to-latest operation already in flight.
      await position(680, 40);
      if (!app.chatViewportMotion?.moving || !app.chatViewportMotion?.keyboardMoving) throw Error('Pre-focus viewport resize did not infer the opening target');
      const chatBottomScrollTop = app.chatBottomScrollTop;
      const captureChatAnchor = app.captureChatAnchor;
      const bottomUpdate = app.chatBottomControl.update;
      let passiveReads = 0; let explicitReads = 0; let updateCalls = 0;
      app.chatBottomScrollTop = function (...args) {
        if (document.querySelector('#chat-bottom-control').dataset.explicitProbe) explicitReads++;
        else passiveReads++;
        return chatBottomScrollTop.apply(this, args);
      };
      app.captureChatAnchor = function (...args) { passiveReads++; return captureChatAnchor.apply(this, args); };
      app.chatBottomControl.update = function (...args) { updateCalls++; return bottomUpdate.apply(this, args); };
      app.updateChatBottomControl(); app.alignChatBottom(); window.dispatchEvent(new Event('scroll')); await frame();
      if (passiveReads || updateCalls) throw Error(`Inferred keyboard motion performed passive document work: ${passiveReads}/${updateCalls}`);
      await new Promise(resolve => setTimeout(resolve, 220)); await frame();
      if (!composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) {
        throw Error('Pre-focus opening plateau hid the composer or settled before the keyboard endpoint');
      }
      const bottomButton = document.querySelector('#chat-bottom-control');
      bottomButton.dataset.explicitProbe = 'true'; bottomButton.click(); delete bottomButton.dataset.explicitProbe;
      if (!explicitReads) throw Error('Targetless viewport motion blocked the explicit return-to-latest control');
      app.chatBottomScrollTop = chatBottomScrollTop; app.captureChatAnchor = captureChatAnchor; app.chatBottomControl.update = bottomUpdate;
      input.focus({ preventScroll: true });
      if (document.activeElement !== input || !composer.dataset.viewportMotion || !app.chatViewportMotion?.keyboardMoving) throw Error('Focus after the first resize did not attach the explicit open target');
      for (const [height, top] of [[540, 100], [420, 180]]) await position(height, top);
      await settled();
      const gap = window.composerBaseBounds().top - target.getBoundingClientRect().bottom;
      const buttonGap = window.composerBaseBounds().top - document.querySelector('#chat-bottom-control').getBoundingClientRect().bottom;
      if (Math.abs(gap - 64) > 2 || Math.abs(buttonGap - 8) > 1) {
        throw Error(`Settled keyboard spacing changed: ${JSON.stringify({
          gap,
          buttonGap,
          composer: window.composerBaseBounds(),
          target: target.getBoundingClientRect().toJSON(),
          button: document.querySelector('#chat-bottom-control').getBoundingClientRect().toJSON(),
          opacity: getComputedStyle(composer).opacity,
          transform: getComputedStyle(composer).transform,
          viewportMotion: composer.dataset.viewportMotion ?? null,
          bottomScrolling: app.chatBottomControl?.scrolling,
          inputHeightMoving: Boolean(app.composerHeightMotion),
          scrollY: window.scrollY,
          innerHeight: window.innerHeight,
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
          bodyScrollHeight: document.body.scrollHeight,
          list: document.querySelector('#message-list').getBoundingClientRect().toJSON(),
          listPaddingBottom: getComputedStyle(document.querySelector('#message-list')).paddingBottom,
          listMinHeight: getComputedStyle(document.querySelector('#message-list')).minHeight,
          keyboardOpen: document.documentElement.dataset.keyboardOpen,
        })}`);
      }
      const scrollY = window.scrollY;
      const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch' });
      target.dispatchEvent(pointer);
      touch('touchstart', [400]);
      for (const y of [450, 340, 500]) {
        const event = touch('touchmove', [y]);
        await frame();
        if (!event.defaultPrevented || document.activeElement !== input || window.scrollY !== scrollY
          || Math.abs(header.getBoundingClientRect().top - 180) > 1) throw Error('Keyboard-open finger movement scrolled history, blurred the draft, or displaced the title');
      }
      for (let index = 0; index < 8; index++) await frame();
      if (!composer.dataset.viewportMotion || !pointer.defaultPrevented || getComputedStyle(list).touchAction !== 'none') throw Error('Held keyboard gesture did not retain exclusive scroll ownership');
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      if (document.activeElement !== input) throw Error('Pointer release blurred before the remaining touch ended');
      touch('touchend', []);
      if (document.activeElement === input || list.dataset.keyboardGesture) throw Error('Final release did not dismiss the keyboard');
      for (const [height, top] of [[540, 100], [680, 40], [layoutHeight, 0]]) await position(height, top);
      await settled();
      if (input.value !== '保留这份草稿' || app.uiPreferences.composerDraft !== input.value) throw Error('Keyboard gesture changed the draft');
      const anchor = app.captureChatAnchor();
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -24 })); window.scrollBy(0, -24); await frame();
      if (!composer.dataset.viewportMotion || getComputedStyle(header).opacity !== '1'
        || getComputedStyle(composer).opacity !== '1') throw Error('Manual list movement hid chat chrome');
      await settled();
      if (app.captureChatAnchor().pinnedToBottom || !anchor.clientMsgId) throw Error('Manual scrolling lost the reading intent');
      app.scrollChatToBottom(); await frame();
      let resumeAlignments = 0;
      app.alignChatBottom = function (...args) {
        resumeAlignments++;
        return alignChatBottom.apply(this, args);
      };
      app.setActiveSurface('away');
      if (composer.dataset.viewportMotion !== 'positioning') throw Error('Leaving chat did not cancel motion synchronously');
      input.dispatchEvent(new FocusEvent('focus'));
      input.dispatchEvent(new FocusEvent('blur'));
      if (app.chatViewportMotion?.keyboardMoving) throw Error('Inactive chat input re-armed keyboard motion');
      // The inactive same-DOM surface can outlive both settle thresholds.
      // Its elapsed time must not make the first returning intermediate frame
      // reveal or align against the composer's stale pre-viewer position.
      Object.defineProperty(viewport, 'height', { configurable: true, value: 680 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 40 });
      viewport.dispatchEvent(new Event('resize')); await frame();
      await new Promise(resolve => setTimeout(resolve, 1_700));
      app.setActiveSurface('chat'); await frame();
      if (composer.dataset.viewportMotion !== 'positioning' || Number(getComputedStyle(composer).opacity) !== 1
        || resumeAlignments !== 0 || Math.abs(window.composerBaseBounds().bottom - 720) > 1) {
        throw Error(`Same-DOM return used away time or stale composer geometry: ${JSON.stringify({ state: composer.dataset.viewportMotion, opacity: getComputedStyle(composer).opacity, resumeAlignments, composerBottom: window.composerBaseBounds().bottom })}`);
      }
      await settled();
      const resumeGap = window.composerBaseBounds().top - target.getBoundingClientRect().bottom;
      if (resumeAlignments !== 1 || Math.abs(resumeGap - 64) > 2) {
        throw Error(`Same-DOM return did not settle once at current geometry: ${JSON.stringify({ resumeAlignments, resumeGap })}`);
      }
      app.alignChatBottom = alignChatBottom;
      return { keyboardFrames: 6, blockedFingerDirections: 'both', blur: 'last touch release', draft: 'preserved', latestGap: gap, buttonGap, composer: 'continuously visible without reveal animation', sameDomReturn: true, awayIntermediateFirstFrame: 'visible', resumeAlignments, resumeGap };
    } finally {
      app.alignChatBottom = alignChatBottom;
      delete viewport.height; delete viewport.offsetTop;
      input.blur(); viewport.dispatchEvent(new Event('resize')); await frame();
    }
  });

  results.galleryKeyboardHeader = await page.evaluate(async () => {
    const { app, fresh } = window.regression; fresh();
    app.renderGallery();
    const viewport = window.visualViewport;
    const header = document.querySelector('.gallery-header');
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const samples = [];
    // Reproduce a transient native focus scroll even though this page normally
    // contains an inner gallery scroller and has no document scroll range.
    const scrollRange = document.createElement('div');
    scrollRange.style.height = '1600px'; document.body.append(scrollRange);
    const scrollStyles = [document.documentElement, document.body].flatMap(element => ['height', 'overflow'].map(property => ({ element, property, value: element.style.getPropertyValue(property) })));
    for (const { element, property } of scrollStyles) element.style.setProperty(property, property === 'height' ? 'auto' : 'visible');
    try {
      for (const [height, top] of [[700, 40], [520, 180], [420, 260], [620, 80], [844, 0]]) {
        Object.defineProperty(viewport, 'height', { configurable: true, value: height });
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
        viewport.dispatchEvent(new Event('resize'));
        window.scrollBy(0, 18); window.dispatchEvent(new Event('scroll'));
        await frame();
        const rect = header.getBoundingClientRect();
        if (window.scrollY < 1) throw Error('Gallery native-scroll fixture did not move the document');
        if (Math.abs(rect.top - top) > 1 || getComputedStyle(header).opacity !== '1') throw Error(`Gallery title left its screen anchor: ${JSON.stringify({ height, top, headerTop: rect.top, scrollY: window.scrollY })}`);
        samples.push(rect.top - top);
      }
      return { visibleTopOffsets: samples, position: getComputedStyle(header).position };
    } finally {
      scrollRange.remove(); window.scrollTo(0, 0);
      for (const { element, property, value } of scrollStyles) {
        if (value) element.style.setProperty(property, value); else element.style.removeProperty(property);
      }
      delete viewport.height; delete viewport.offsetTop; viewport.dispatchEvent(new Event('resize')); await frame();
    }
  });

  results.galleryContinuousHeader = await page.evaluate(async () => {
    const { app, fresh, root } = window.regression; fresh();
    app.renderGallery();
    const viewport = window.visualViewport;
    const header = document.querySelector('.gallery-header');
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame(); await frame();
    const originalQuery = Element.prototype.querySelector;
    const originalBounds = Element.prototype.getBoundingClientRect;
    let samplerQueries = 0; let unrelatedQueries = 0; let messageReads = 0;
    try {
      Element.prototype.querySelector = function (...args) {
        const stack = new Error().stack ?? '';
        if (/syncVisualViewport|sampleViewport|finishViewportSync/.test(stack)) samplerQueries++;
        else unrelatedQueries++;
        return originalQuery.apply(this, args);
      };
      Element.prototype.getBoundingClientRect = function (...args) {
        if (this.classList?.contains('message')) messageReads++;
        return originalBounds.apply(this, args);
      };
      const samples = [];
      // Do not dispatch resize/scroll: only the persistent cheap sampler can
      // see these five native toolbar/keyboard frames.
      for (const [height, top] of [[730, 30], [610, 100], [470, 200], [590, 120], [844, 0]]) {
        Object.defineProperty(viewport, 'height', { configurable: true, value: height });
        Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
        await frame();
        const visibleTop = header.getBoundingClientRect().top - top;
        if (Math.abs(visibleTop) > 1) throw Error(`Eventless gallery frame moved its title: ${JSON.stringify({ height, top, visibleTop })}`);
        samples.push(visibleTop);
      }
      // The assertions themselves make five bounds reads, but the sampler
      // performs no selector traversal and never measures chat rows.
      if (samplerQueries !== 0 || messageReads !== 0) throw Error(`Gallery sampling touched page contents: ${JSON.stringify({ samplerQueries, unrelatedQueries, messageReads })}`);
      Element.prototype.querySelector = originalQuery;
      Element.prototype.getBoundingClientRect = originalBounds;

      const viewer = document.createElement('section'); viewer.className = 'image-viewer'; root.append(viewer);
      app.viewerPreviousSurface = 'away'; app.setActiveSurface('away');
      Object.defineProperty(viewport, 'height', { configurable: true, value: 620 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 100 });
      const stoppedTop = header.getBoundingClientRect().top;
      await frame(); await frame();
      if (header.getBoundingClientRect().top !== stoppedTop) throw Error('Viewer retained the gallery viewport sampler');
      app.closeImageViewer(true);
      Object.defineProperty(viewport, 'height', { configurable: true, value: 560 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 160 });
      await frame();
      if (Math.abs(header.getBoundingClientRect().top - 160) > 1) throw Error('Gallery return did not resume eventless sampling');

      app.lockNow();
      let reads = 0; let height = 520;
      Object.defineProperty(viewport, 'height', { configurable: true, get() { reads++; return height; } });
      height = 480; reads = 0; await frame(); await frame();
      if (reads) throw Error(`Privacy lock retained ${reads} viewport samples`);
      return { eventlessFrames: samples, selectorQueries: samplerQueries, unrelatedQueries, messageBoundsReads: messageReads, viewerStopped: true, sameDomReturn: true, lockReads: reads };
    } finally {
      Element.prototype.querySelector = originalQuery;
      Element.prototype.getBoundingClientRect = originalBounds;
      delete viewport.height; delete viewport.offsetTop;
    }
  });

  results.toolbarExpansion = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 70 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame(); await frame();
    const viewport = window.visualViewport;
    const layoutHeight = document.documentElement.clientHeight;
    const input = document.querySelector('#message-input');
    const samples = [];
    try {
      // Safari can keep the old layout metrics while its shrinking URL bar
      // reveals more of the page. The visible height is allowed to exceed them.
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 0 });
      for (const height of [layoutHeight + 20, layoutHeight + 40, layoutHeight + 60, layoutHeight + 80]) {
        Object.defineProperty(viewport, 'height', { configurable: true, value: height });
        viewport.dispatchEvent(new Event('resize'));
        await frame();
        const bottom = window.composerBaseBounds().bottom;
        if (Math.abs(bottom - height) > 1) throw Error(`Stale layout height clipped toolbar expansion: ${JSON.stringify({ height, clientHeight: document.documentElement.clientHeight, bottom })}`);
        samples.push({ height, bottom });
      }
      input.focus({ preventScroll: true });
      for (const height of [700, 560, 420]) {
        Object.defineProperty(viewport, 'height', { configurable: true, value: height });
        viewport.dispatchEvent(new Event('resize'));
        await frame();
        const immediate = window.composerBaseBounds();
        if (Math.abs(immediate.bottom - height) > 1 || document.querySelector('#composer').dataset.viewportMotion !== 'positioning') {
          throw Error(`Keyboard after collapsed toolbar misplaced or exposed fixed composer: ${JSON.stringify({ height, bottom: immediate.bottom })}`);
        }
      }
      const composer = document.querySelector('#composer');
      const deadline = performance.now() + 1200;
      while ((composer.dataset.viewportMotion || Number(getComputedStyle(composer).opacity) !== 1) && performance.now() < deadline) await frame();
      const settledComposer = window.composerBaseBounds();
      const gap = settledComposer.top - document.querySelector('#message-list').lastElementChild.getBoundingClientRect().bottom;
      if (composer.dataset.viewportMotion || Math.abs(gap - 64) > 2) throw Error(`Keyboard after collapsed toolbar did not settle content: ${JSON.stringify({ gap })}`);
      return { staleLayoutFrames: samples, subsequentKeyboardFrames: 3 };
    } finally {
      delete viewport.height; delete viewport.offsetTop;
      input.blur(); viewport.dispatchEvent(new Event('resize')); await frame(); await frame();
    }
  });

  results.repeatedKeyboardFocus = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 70 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const settle = async () => { await frame(); await frame(); };
    await settle();
    const viewport = window.visualViewport;
    const layoutHeight = document.documentElement.clientHeight;
    const input = document.querySelector('#message-input');
    const list = document.querySelector('#message-list');
    const dismissalGaps = [];
    const resize = height => {
      Object.defineProperty(viewport, 'height', { configurable: true, value: height });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 0 });
      viewport.dispatchEvent(new Event('resize'));
    };
    const dismissFromMessage = async () => {
      list.lastElementChild.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      if (document.activeElement !== input) throw Error('Message pointerdown prematurely blurred the keyboard');
      list.lastElementChild.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }));
      if (document.activeElement === input || app.chatPinnedToBottom) throw Error('Message release failed to dismiss the keyboard and yield follow');
      resize(layoutHeight); await settle();
      dismissalGaps.push(app.chatBottomGap());
    };
    try {
      input.focus({ preventScroll: true }); resize(420); await settle();
      await dismissFromMessage();
      // Closing from a message leaves an upward gesture intent and may leave
      // a native scroll gap. A fresh composer tap must restore prior follow.
      input.focus({ preventScroll: true }); resize(420);
      const gap = window.composerBaseBounds().top - list.lastElementChild.getBoundingClientRect().bottom;
      if (!app.chatPinnedToBottom || Math.abs(gap - 64) > 2) throw Error(`Reopening the keyboard retained stale history intent: gap=${gap}`);
      await settle();
      await dismissFromMessage();
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -12, bubbles: true }));
      window.scrollBy(0, -12); await settle();
      const before = window.scrollY;
      const anchor = structuredClone(app.captureChatAnchor());
      if (app.chatBottomGap() <= 2) throw Error('Upward-history fixture did not move away from the actual bottom');
      input.focus({ preventScroll: true }); resize(420); await settle();
      const after = app.captureChatAnchor();
      if (app.chatPinnedToBottom || Math.abs(window.scrollY - before) > 1
        || after.clientMsgId !== anchor.clientMsgId || Math.abs(after.offset - anchor.offset) > 1) throw Error('Reopening the keyboard pulled a reader away from a 12px upward scroll');
      return { messageTapDismissalThenFocus: 'bottom follow restored', dismissalGaps, latestGap: gap, upwardReadingThenFocus: 'position preserved' };
    } finally {
      delete viewport.height; delete viewport.offsetTop;
      input.blur(); viewport.dispatchEvent(new Event('resize')); await settle();
    }
  });

  results.nativeFocusScroll = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 70 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame(); await frame();
    const viewport = window.visualViewport;
    const input = document.querySelector('#message-input');
    const composerElement = document.querySelector('#composer');
    const settleViewport = async () => {
      const deadline = performance.now() + 1200;
      await frame();
      while ((composerElement.dataset.viewportMotion || Number(getComputedStyle(composerElement).opacity) !== 1) && performance.now() < deadline) await frame();
      if (composerElement.dataset.viewportMotion || Number(getComputedStyle(composerElement).opacity) !== 1) throw Error('Native-focus keyboard endpoint did not settle');
    };
    try {
      input.focus({ preventScroll: true });
      // Reproduce a browser focus scroll reaching the app before keyboard
      // viewport metrics, without any user's history-reading gesture.
      window.scrollBy(0, -96);
      window.dispatchEvent(new Event('scroll'));
      await frame();
      if (!app.chatPinnedToBottom) throw Error('Native focus scroll cleared follow before the keyboard resize arrived');
      Object.defineProperty(viewport, 'height', { configurable: true, value: 420 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 100 });
      viewport.dispatchEvent(new Event('resize'));
      await settleViewport();
      const composer = window.composerBaseBounds();
      const gap = composer.top - document.querySelector('#message-list').lastElementChild.getBoundingClientRect().bottom;
      if (!app.chatPinnedToBottom || Math.abs(gap - 64) > 2) throw Error(`Native focus scroll lost the latest message: gap=${gap}`);
      // A delayed native adjustment can also arrive after the final resize.
      // With no further viewport changes, follow still needs to recover it.
      window.scrollBy(0, -96);
      window.dispatchEvent(new Event('scroll'));
      for (let i = 0; i < 4; i++) await frame();
      const settledGap = window.composerBaseBounds().top
        - document.querySelector('#message-list').lastElementChild.getBoundingClientRect().bottom;
      if (!app.chatPinnedToBottom || Math.abs(settledGap - 64) > 2) throw Error(`Native scroll after the final keyboard resize lost follow: gap=${settledGap}`);
      return { scrollBeforeResize: true, scrollAfterFinalResize: true, bottomFollowRetained: true, latestGap: gap, settledGap };
    } finally {
      delete viewport.height; delete viewport.offsetTop;
      input.blur(); viewport.dispatchEvent(new Event('resize')); await frame(); await frame();
    }
  });

  results.sendDeferredScroll = await page.evaluate(async () => {
    const { app, fresh, message, session } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 70 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    await frame(); await frame();
    const scrollTo = window.scrollTo;
    const enqueue = app.enqueuePayload;
    const input = document.querySelector('#message-input');
    let blocked = true; let attempts = 0; let ignored = 0;
    try {
      input.value = '发送后显示在输入栏之上'; input.dispatchEvent(new Event('input'));
      await frame(); await frame();
      window.scrollTo = (...args) => {
        attempts++;
        if (blocked) { ignored++; return; }
        scrollTo.apply(window, args);
      };
      app.enqueuePayload = async payload => {
        app.messages.set(71, { ...message(71, payload), senderId: session.vault.identity.publicBundle.deviceId, status: 'pending' });
        app.renderMessages({ scroll: 'bottom' });
      };
      // A native keyboard animation can ignore page scrolling until the next
      // frame even though the new message and the cleared draft already exist.
      requestAnimationFrame(() => { blocked = false; });
      await app.handleSendText(new Event('submit'));
      if (!ignored) throw Error('Deferred-scroll fixture never intercepted a scroll attempt');
      if (!app.chatPinnedToBottom) throw Error('An ignored send scroll discarded bottom-follow intent');
      for (let i = 0; i < 4; i++) await frame();
      const composer = window.composerBaseBounds();
      const latest = document.querySelector('[data-client-msg-id="message-71"]').getBoundingClientRect();
      const gap = composer.top - latest.bottom;
      if (Math.abs(gap - 64) > 2 || !app.chatPinnedToBottom) throw Error(`A deferred send scroll left the latest message under the composer: ${JSON.stringify({ gap, attempts, ignored, pinned: app.chatPinnedToBottom })}`);
      app.messages.set(71, { ...app.messages.get(71), status: 'stored' }); app.renderMessages();
      await frame();
      if (!app.captureChatAnchor().pinnedToBottom) throw Error('Send acknowledgement lost recovered bottom follow');
      window.scrollBy(0, -96); window.dispatchEvent(new Event('scroll'));
      for (let i = 0; i < 4; i++) await frame();
      const lateScrollGap = window.composerBaseBounds().top
        - document.querySelector('[data-client-msg-id="message-71"]').getBoundingClientRect().bottom;
      if (!app.chatPinnedToBottom || Math.abs(lateScrollGap - 64) > 2) throw Error(`Native scroll overrode an already completed send alignment: gap=${lateScrollGap}`);
      return { ignoredAttempts: ignored, totalAttempts: attempts, latestGap: gap, lateScrollGap, ackFollowRetained: true };
    } finally {
      window.scrollTo = scrollTo; app.enqueuePayload = enqueue;
    }
  });

  results.shortHistoryKeyboardFrames = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression;
    const viewport = window.visualViewport;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const layoutHeight = document.documentElement.clientHeight;
    const samples = [];
    try {
      for (const count of [1, 3]) {
        app.lockNow(); fresh();
        app.messages = new Map(Array.from({ length: count }, (_, i) => [i + 1, message(i + 1)]));
        app.renderMessages({ scroll: 'bottom' });
        await frame(); await frame();
        const input = document.querySelector('#message-input');
        const composerElement = document.querySelector('#composer');
        const header = document.querySelector('.chat-header');
        const list = document.querySelector('#message-list');
        const geometry = () => ({
          paddingBottom: list.style.getPropertyValue('padding-bottom'),
          minHeight: list.style.getPropertyValue('min-height'),
        });
        const checkEndpoint = (phase, height, top) => {
          const composer = window.composerBaseBounds();
          const gap = composer.top - list.lastElementChild.getBoundingClientRect().bottom;
          if (Math.abs(composer.bottom - height - top) > 1 || Math.abs(gap - 64) > 2
            || Number(getComputedStyle(composerElement).opacity) !== 1) {
            throw Error(`Short history did not settle at the ${phase} endpoint: ${JSON.stringify({ count, height, top, composerBottom: composer.bottom, gap })}`);
          }
          samples.push({ count, phase, height, top, gap });
        };
        const assertTransitionFrame = (phase, height, top, before) => {
          const expectedTop = Math.max(0, Math.min(top, layoutHeight - height));
          const composer = window.composerBaseBounds();
          const current = geometry();
          const visibleTop = Math.max(expectedTop, header.getBoundingClientRect().bottom);
          const visibleBottom = Math.min(expectedTop + height, composer.top);
          const visible = [...list.querySelectorAll('.message')].some(row => {
            const bounds = row.getBoundingClientRect();
            return bounds.top < visibleBottom && bounds.bottom > visibleTop;
          });
          if (Math.abs(header.getBoundingClientRect().top - expectedTop) > 1 || getComputedStyle(header).opacity !== '1'
            || header.getAnimations().some(animation => animation.playState === 'running')) throw Error(`${count}-message ${phase} moved, faded or animated the title`);
          if (composerElement.dataset.viewportMotion !== 'positioning' || getComputedStyle(composerElement).opacity !== '1'
            || Math.abs(composer.bottom - expectedTop - height) > 1) throw Error(`${count}-message ${phase} hid or displaced intermediate composer geometry`);
          if (!visible || visibleBottom <= visibleTop) throw Error(`${count}-message ${phase} exposed a blank viewport`);
          if (current.paddingBottom !== before.paddingBottom || current.minHeight !== before.minHeight) {
            throw Error(`${count}-message ${phase} committed list geometry before its endpoint`);
          }
        };
        const position = async (phase, height, top, before) => {
          Object.defineProperty(viewport, 'height', { configurable: true, value: height });
          Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
          viewport.dispatchEvent(new Event('resize')); await frame();
          assertTransitionFrame(phase, height, top, before);
        };
        const reveal = async phase => {
          const deadline = performance.now() + 1200;
          while ((composerElement.dataset.viewportMotion || Number(getComputedStyle(composerElement).opacity) !== 1) && performance.now() < deadline) await frame();
          if (composerElement.dataset.viewportMotion || Number(getComputedStyle(composerElement).opacity) !== 1) throw Error(`${count}-message ${phase} endpoint did not reveal`);
        };
        checkEndpoint('closed-initial', layoutHeight, 0);
        input.focus({ preventScroll: true });
        const closedGeometry = geometry();
        await position('opening plateau frame', 780, 40, closedGeometry);
        await delay(220); await frame();
        assertTransitionFrame('opening plateau after 220ms', 780, 40, closedGeometry);
        await position('opening endpoint frame', 420, 320, closedGeometry);
        await reveal('opening');
        checkEndpoint('open', 420, 320);
        input.blur();
        const openGeometry = geometry();
        await position('closing plateau frame', 610, 180, openGeometry);
        await delay(220); await frame();
        assertTransitionFrame('closing plateau after 220ms', 610, 180, openGeometry);
        await position('closing endpoint frame', layoutHeight, 280, openGeometry);
        await reveal('closing');
        checkEndpoint('closed-final', layoutHeight, 0);
        if (!app.chatPinnedToBottom) throw Error('Short-history keyboard sampling discarded bottom follow');
      }
      return { histories: [1, 3], plateauMs: 220, nonEmptyConversationEveryMergedFrame: true, samples };
    } finally {
      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize')); await frame(); await frame();
    }
  });
  if (visualQaDirectory) {
    await page.screenshot({ path: path.join(visualQaDirectory, 'chat-short-history-keyboard-closed-390.png') });
    await page.evaluate(async () => {
      document.querySelector('#message-input').focus({ preventScroll: true });
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 420 });
      Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 0 });
      await new Promise(resolve => setTimeout(resolve, 190));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    await page.screenshot({ path: path.join(visualQaDirectory, 'chat-short-history-keyboard-open-390.png') });
    await page.evaluate(async () => {
      document.querySelector('#message-input').blur();
      delete window.visualViewport.height; delete window.visualViewport.offsetTop;
      window.visualViewport.dispatchEvent(new Event('resize'));
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
  }

  results.singleTallMessage = await page.evaluate(async () => {
    const { app, fresh, message } = window.regression; fresh();
    const source = message(1, { v: 1, kind: 'text', text: '一条很长的聊天消息，需要向上阅读。\n'.repeat(80), sentAt: '2026-09-04T01:00:00.000Z' });
    app.messages.set(1, source); app.renderMessages({ scroll: 'bottom' });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settle();
    document.querySelector('#message-list').dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
    window.scrollBy(0, -20); await settle();
    const before = window.scrollY;
    app.messages.set(1, { ...source, status: 'stored' }); app.renderMessages(); await settle();
    if (Math.abs(window.scrollY - before) > 1 || app.chatPinnedToBottom) throw Error('A single tall message snapped to bottom on receipt');
    return { smallUpwardScrollOnAck: 'preserved' };
  });

  results.reactionPresentation = await page.evaluate(async () => {
    const { app, fresh, message, session } = window.regression; fresh();
    app.messages = new Map(Array.from({ length: 20 }, (_, i) => [i + 1, message(i + 1)]));
    app.renderMessages({ scroll: 'bottom' });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settle();
    const source = app.messages.get(19);
    const article = document.querySelector('[data-client-msg-id="message-19"]');
    app.openMessageActions(article, source); await settle();
    const menu = document.querySelector('.message-actions');
    if (document.activeElement !== menu || menu.querySelector('[data-reaction]:focus-visible')) throw Error('Opening the menu highlighted the first emoji');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    if (document.activeElement !== menu.querySelector('[data-reaction]')) throw Error('Keyboard navigation no longer reaches reactions');
    app.closeMessageActions();
    const backdrop = document.querySelector('.message-actions-backdrop');
    if (!backdrop?.classList.contains('is-closing') || !article.classList.contains('is-action-source')) throw Error('Closing abruptly removed the dimmed background or source');
    const reaction = { ...message(21), seq: Number.MAX_SAFE_INTEGER, senderId: session.vault.identity.publicBundle.deviceId, payload: { v: 1, kind: 'reaction', target: { clientMsgId: source.clientMsgId, serverSeq: source.seq, senderId: source.senderId }, emoji: '❤️', sentAt: source.payload.sentAt }, status: 'pending' };
    app.messages.set(21, reaction); app.renderMessages();
    const badge = article.querySelector('.message-reaction');
    const observer = new MutationObserver(() => {}); observer.observe(article, { childList: true, subtree: true });
    app.messages.set(21, { ...reaction, seq: Number.MAX_SAFE_INTEGER, status: 'stored' }); app.renderMessages();
    const detached = observer.takeRecords().some(record => record.removedNodes.length); observer.disconnect();
    if (detached || article.querySelector('.message-reaction') !== badge) throw Error('Reaction ACK remounted or rolled back its badge before sync');
    app.messages.set(21, { ...reaction, seq: 21, status: 'stored' }); app.renderMessages();
    if (article.querySelector('.message-reaction') !== badge) throw Error('Reaction sync remounted its optimistic badge');

    // Keep an earlier message as the scroll anchor, then add a reaction below
    // it. Rows after the reacted message must start at their old visual
    // position and ease to the new layout without being detached or jittering
    // again during ACK and durable sync.
    // Keep the source and its first follower inside the viewport across font
    // stacks. Linux Chromium's fallback glyph metrics make six intervening
    // rows tall enough to place message 11 just outside the animation's
    // intentional visible-row window.
    const anchored = document.querySelector('[data-client-msg-id="message-9"]');
    const animatedSource = app.messages.get(10);
    const animatedArticle = document.querySelector('[data-client-msg-id="message-10"]');
    const follower = document.querySelector('[data-client-msg-id="message-11"]');
    anchored.scrollIntoView({ block: 'start', behavior: 'instant' });
    window.dispatchEvent(new Event('scroll'));
    app.chatPinnedToBottom = false; app.chatScrollIntent = 'up';
    await settle();
    const followerContent = follower.querySelector('.message-bubble');
    const followerTop = followerContent.getBoundingClientRect().top;
    const flip = {
      ...message(22), seq: Number.MAX_SAFE_INTEGER, clientMsgId: 'reaction-flip',
      senderId: session.vault.identity.publicBundle.deviceId, status: 'pending',
      payload: { v: 1, kind: 'reaction', target: { clientMsgId: animatedSource.clientMsgId, serverSeq: animatedSource.seq, senderId: animatedSource.senderId }, emoji: '👍', sentAt: animatedSource.payload.sentAt },
    };
    app.pending.set(flip.clientMsgId, flip); app.renderMessages();
    const flipBadge = animatedArticle.querySelector('.message-reaction');
    const flipAnimation = followerContent.getAnimations().find(animation =>
      animation.effect?.getKeyframes().some(frame => typeof frame.translate === 'string'));
    if (!flipBadge || !flipAnimation || Number(flipAnimation.effect.getTiming().duration) !== 300) {
      throw Error('Reaction insertion did not create the 300ms follower FLIP animation');
    }
    const followerImmediateTop = followerContent.getBoundingClientRect().top;
    const heldAtOldPosition = Math.abs(followerImmediateTop - followerTop) < 3;
    app.pending.set(flip.clientMsgId, { ...flip, status: 'stored' }); app.renderMessages();
    if (animatedArticle.querySelector('.message-reaction') !== flipBadge || !followerContent.getAnimations().includes(flipAnimation)) {
      throw Error('Reaction ACK restarted the layout motion or remounted its badge');
    }
    app.pending.delete(flip.clientMsgId);
    app.messageEventHistory.set(22, { ...flip, seq: 22, status: 'stored' }); app.renderMessages();
    if (animatedArticle.querySelector('.message-reaction') !== flipBadge || !followerContent.getAnimations().includes(flipAnimation)) {
      throw Error('Reaction durable sync restarted the layout motion or remounted its badge');
    }
    await flipAnimation.finished;
    const finalTop = followerContent.getBoundingClientRect().top;
    app.messageEventHistory.set(23, {
      ...flip, seq: 23, clientMsgId: 'reaction-flip-remove', status: 'stored',
      payload: { ...flip.payload, emoji: null },
    });
    app.renderMessages();
    const removalAnimation = followerContent.getAnimations().find(animation =>
      animation.effect?.getKeyframes().some(frame => typeof frame.translate === 'string'));
    if (animatedArticle.querySelector('.message-reaction') || !removalAnimation
      || Number(removalAnimation.effect.getTiming().duration) !== 300) {
      throw Error('Removing the last reaction did not smoothly return following rows');
    }
    await new Promise(resolve => setTimeout(resolve, 180));
    if (backdrop.isConnected || article.classList.contains('is-action-source')) throw Error('Reaction close left an overlay behind');
    return {
      initialEmojiFocus: false, keyboardNavigation: true, smoothBackdropClose: true,
      badgeRetainedAcrossAckAndSync: true, followerHeldAtOldPosition: heldAtOldPosition,
      followerImmediateDelta: followerImmediateTop - followerTop,
      followerTravel: finalTop - followerTop, insertionDuration: 300, removalDuration: 300,
    };
  });
  assert.equal(results.reactionPresentation.followerHeldAtOldPosition, true,
    `Reaction reflow jumped before its FLIP animation began: ${JSON.stringify(results.reactionPresentation)}`);
  // The badge's exact line-box contribution varies with the runner's CJK and
  // emoji fallback fonts. Require a clear multi-pixel downward reflow while
  // the assertions above continue to verify the 300ms FLIP and zero jump.
  assert(results.reactionPresentation.followerTravel > 3, `Reaction fixture did not move the following bubble: ${JSON.stringify(results.reactionPresentation)}`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  results.reactionReducedMotion = await page.evaluate(async () => {
    const { app, fresh, message, session } = window.regression; fresh();
    const source = message(1); const follower = message(2);
    app.messages = new Map([[1, source], [2, follower]]); app.renderMessages({ scroll: 'bottom' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    app.pending.set('reaction-reduced', {
      ...message(3), seq: Number.MAX_SAFE_INTEGER, clientMsgId: 'reaction-reduced', status: 'pending',
      senderId: session.vault.identity.publicBundle.deviceId,
      payload: { v: 1, kind: 'reaction', target: { clientMsgId: source.clientMsgId, serverSeq: source.seq, senderId: source.senderId }, emoji: '❤️', sentAt: source.payload.sentAt },
    });
    app.renderMessages();
    const row = document.querySelector('[data-client-msg-id="message-2"]');
    const animations = [...row.children].flatMap(child => child.getAnimations()).length;
    if (!document.querySelector('[data-client-msg-id="message-1"] .message-reaction') || animations !== 0) {
      throw Error('Reduced motion did not commit reaction layout without animation');
    }
    return { animations, badgeVisible: true };
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (visualQaDirectory) {
    await page.evaluate(() => {
      const { app, fresh, message, session } = window.regression; fresh();
      app.uiPreferences.recoveryReminderDismissed = true; app.renderChat();
      app.connectionState = 'connected'; app.rolePresence = { creator: true, joiner: true }; app.updatePeerStatus();
      const texts = ['今天路上的风景很好看。', '照片收到了，等会儿一起看。', '好呀，我刚到家。', '我好开心', '我也是，早点休息哦'];
      const own = session.vault.identity.publicBundle.deviceId;
      app.messages = new Map(texts.map((text, i) => [i + 1, { ...message(i + 1, { v: 1, kind: 'text', text, sentAt: '2026-09-04T07:17:00.000Z' }), senderId: i % 2 ? own : 'regression-peer' }]));
      app.messages.set(6, { ...message(6, { v: 1, kind: 'text', text: '我也是，今天真的很开心。', sentAt: '2026-09-04T07:18:00.000Z', replyTo: { clientMsgId: 'message-4', serverSeq: 4, senderId: own, kind: 'text', preview: '我好开心' } }), senderId: own });
      app.renderMessages({ scroll: 'bottom' });
    });
    for (const scheme of ['light', 'dark']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(220);
      await page.screenshot({ path: path.join(visualQaDirectory, `chat-glass-${scheme}-390.png`) });
    }
  }
  const touchPage = await browser.newPage({ hasTouch: true, viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  try {
    await touchPage.goto(`http://localhost:${server.httpServer.address().port}/__frontend_regression`);
    await touchPage.evaluate(initializeRegression);
    results.touchHeaderAnchor = await touchPage.evaluate(async () => {
      const { app, message } = window.regression;
      // Chromium cannot acquire WebKit capabilities through a mobile UA.
      // Exercise the same native-coordinate branch in both engine runs.
      app.visualClientCoordinates = true;
      app.refreshNativeChatChrome();
      app.messages = new Map(Array.from({ length: 120 }, (_, i) => [i + 1, message(i + 1)]));
      app.renderMessages({ scroll: 'bottom' });
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await settle();
      const header = document.querySelector('.chat-header');
      const positions = [];
      for (const fraction of [1, 0.98, 0.85, 0.5, 0, 1]) {
        window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * fraction);
        await settle();
        const top = header.getBoundingClientRect().top;
        if (getComputedStyle(header).position !== 'fixed' || Math.abs(top) > 1) {
          throw Error(`Touch Safari history scroll displaced title: ${JSON.stringify({ fraction, top, scrollY })}`);
        }
        positions.push(top);
      }
      app.connectionState = 'connected'; app.rolePresence = { creator: true, joiner: true }; app.updatePeerStatus();
      return positions;
    });
    for (const colorScheme of ['light', 'dark']) {
      await touchPage.emulateMedia({ colorScheme });
      await touchPage.evaluate(async () => {
        const controls = [...document.querySelectorAll('.chat-header .icon-button')];
        const picker = document.querySelector('.composer #open-chat-tools');
        for (const control of controls) if (control instanceof HTMLButtonElement) control.disabled = false;
        picker.classList.remove('is-disabled');
        await new Promise(resolve => setTimeout(resolve, 200));
        const expected = getComputedStyle(picker).color;
        if (controls.some(control => getComputedStyle(control).color !== expected)) throw Error('Header and composer icon colors differ');
        const dot = document.querySelector('#peer-presence .presence-dot');
        if (getComputedStyle(dot).animationName !== 'chat-presence-breathe') throw Error('Online indicator is missing its breathing animation');
        window.regression.app.rolePresence.joiner = false; window.regression.app.updatePeerStatus();
        if (getComputedStyle(dot).animationName !== 'none') throw Error('Offline indicator kept breathing');
        window.regression.app.rolePresence.joiner = true; window.regression.app.updatePeerStatus();
      });
      if (visualQaDirectory) await touchPage.screenshot({ path: path.join(visualQaDirectory, `chat-header-touch-${colorScheme}.png`) });
    }
    await touchPage.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await touchPage.locator('#peer-presence .presence-dot').evaluate(dot => getComputedStyle(dot).animationName), 'none');
  } finally { await touchPage.close(); }
  // A wide mobile-emulated page does not exercise desktop scrolling. Use the
  // engine's real desktop user agent and pointer model in a separate context.
  const desktopPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  desktopPage.on('pageerror', error => errors.push(error.message));
  try {
    await desktopPage.goto(`http://localhost:${server.httpServer.address().port}/__frontend_regression`);
    await desktopPage.evaluate(initializeRegression);
    await desktopPage.evaluate(() => {
      const { app, message } = window.regression;
      if (!app.desktopBrowser || /iPhone|iPad|Android/.test(navigator.userAgent)) throw Error('Desktop regression still uses a mobile browser identity');
      app.messages = new Map(Array.from({ length: 120 }, (_, i) => [i + 1, message(i + 1)]));
      app.renderMessages({ scroll: 'bottom' });
    });
    const samples = [];
    for (const [width, height] of [[1024, 768], [1280, 900], [1440, 960], [1920, 1080]]) {
      await desktopPage.setViewportSize({ width, height });
      const positions = await desktopPage.evaluate(async () => {
        const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await settle();
        const samples = [];
        for (const fraction of [0, 0.5, 1]) {
          const target = (document.documentElement.scrollHeight - innerHeight) * fraction;
          window.scrollTo(0, target);
          await settle();
          const header = document.querySelector('.chat-header');
          const composer = document.querySelector('#composer');
          const headerBounds = header.getBoundingClientRect();
          const composerBounds = window.composerBaseBounds();
          const input = document.querySelector('#message-input').getBoundingClientRect();
          if (getComputedStyle(header).position !== 'fixed' || getComputedStyle(composer).position !== 'fixed') throw Error('Desktop controls no longer use fixed positioning');
          if (Math.abs(headerBounds.top) > 1 || Math.abs(composerBounds.bottom - innerHeight) > 1) throw Error('Document scrolling moved a desktop bar away from the window edge');
          if (headerBounds.width > 881 || composerBounds.width > 881 || Math.abs(headerBounds.left - composerBounds.left) > 1 || Math.abs(headerBounds.right - composerBounds.right) > 1) throw Error('Desktop bars escaped their shared 880px conversation width');
          if (input.width < 560 || document.documentElement.scrollWidth > innerWidth) throw Error('Desktop composer shrank or overflowed as the browser grew wider');
          if (Math.abs(window.scrollY - target) > 2) throw Error(`Desktop scroll position was pulled away from its target: ${JSON.stringify({ fraction, target, scrollY })}`);
          samples.push({ fraction, scrollY, firstMessageTop: document.querySelector('.message').getBoundingClientRect().top, headerTop: headerBounds.top, composerBottom: composerBounds.bottom, inputWidth: input.width, barWidth: composerBounds.width });
        }
        if (samples[2].scrollY <= samples[0].scrollY || samples[2].firstMessageTop >= samples[0].firstMessageTop) throw Error('Desktop fixture never scrolled its message content');
        return samples;
      });
      await desktopPage.mouse.move(width / 2, height / 2);
      for (const deltaY of [-620, 240]) {
        const before = await desktopPage.evaluate(() => scrollY);
        const framesPromise = desktopPage.evaluate(() => new Promise(resolve => {
          const frames = [];
          const sample = () => {
            frames.push({ scrollY, top: document.querySelector('.chat-header').getBoundingClientRect().top, bottom: window.composerBaseBounds().bottom });
            if (frames.length === 16) resolve(frames);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }));
        await desktopPage.mouse.wheel(0, deltaY);
        const frames = await framesPromise;
        if (Math.abs(frames.at(-1).scrollY - before) < 100) throw Error('Desktop wheel did not move the actual document');
        if (frames.some(frame => Math.abs(frame.top) > 1 || Math.abs(frame.bottom - height) > 1)) throw Error('Desktop bars moved during an actual wheel frame');
      }
      await desktopPage.locator('.message.incoming').last().hover();
      if (await desktopPage.locator('.message-quick-reply').count()) throw Error('Hovering a desktop message restored the removed quick-reply control');
      samples.push({ width, height, positions, wheelFrames: 32, hoverQuickReply: false });
    }
    await desktopPage.locator('.message.incoming').last().click({ button: 'right' });
    await desktopPage.locator('[data-message-action="reply"]').click();
    await desktopPage.locator('#reply-draft').waitFor({ state: 'visible' });
    assert.equal(await desktopPage.evaluate(() => window.regression.app.replyTarget?.clientMsgId), 'message-120');
    results.desktopDocumentScroll = { desktopIdentity: true, samples, contextMenuReply: true };
  } finally { await desktopPage.close(); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
