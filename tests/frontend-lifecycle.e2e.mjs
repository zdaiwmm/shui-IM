import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/__frontend_regression', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__frontend_regression`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    await import('/src/voice-messages.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const vault = await import('/src/lib/vault.ts');
    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    const member = { deviceId: 'regression-own', role: 'creator', status: 'active' };
    const session = await vault.createVault({ v: 1, roomId: 'frontend-regression', accessToken: 'test', role: 'creator', protocol: 'legacy-v1', lastSeq: 620, members: [member, { deviceId: 'regression-peer', role: 'joiner', status: 'active' }], identity: { publicBundle: member } }, 'frontend-regression-passphrase', 'password');
    const message = (seq, payload = { v: 1, kind: 'text', text: `历史消息 ${seq}`, sentAt: '2026-09-04T01:00:00.000Z' }) => ({ seq, clientMsgId: `message-${seq}`, senderId: 'regression-peer', payload, acceptedAt: '2026-09-04T01:00:00.000Z', status: 'delivered' });
    const fresh = () => {
      app.session = session; app.privacyCovered = false; app.runtimeEpoch += 1; app.runtimeAbort = new AbortController();
      app.updateSafetyCode = async () => {}; app.updateBackgroundNotificationControl = async () => {};
      app.mountChatImageObserver = () => {}; app.mountGalleryThumbnails = () => {};
      app.messages = new Map(); app.pending = new Map(); app.reactionHistory = new Map(); app.uiPreferences = {}; app.restoreChatAnchorOnNextRender = false;
      app.renderChat();
    };
    window.regression = { app, root, session, vault, message, fresh };
    fresh();
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
    if (last.bottom > document.querySelector('#composer').getBoundingClientRect().top) throw Error('Latest message is covered by composer');
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
    const messages = () => new Map(manifests.map((image, index) => [index + 1, message(index + 1, { v: 1, kind: 'image', image, sentAt: '2026-09-04T01:00:00.000Z' })]));
    const warm = () => {
      for (const manifest of manifests) {
        app.cacheLocalImage(manifest, blob);
        const cached = app.imageCache.get(manifest.blobId);
        cached.width = 300; cached.height = 400;
      }
    };
    const settleLayout = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sameAnchor = (actual, expected) => actual?.clientMsgId === expected.clientMsgId && Math.abs(actual.offset - expected.offset) <= 2 && !actual.pinnedToBottom;
    warm(); app.messages = messages(); app.renderChat(); await settleLayout();
    let list = document.querySelector('#message-list');
    const target = list.querySelector('[data-client-msg-id="message-8"]');
    window.scrollBy(0, target.getBoundingClientRect().top + 196);
    await settleLayout();
    const saved = structuredClone(app.captureChatAnchor());
    if (saved.clientMsgId !== 'message-8' || Math.abs(saved.offset + 196) > 2) throw Error(`Tall-image anchor fixture did not reach the expected offset: ${JSON.stringify({ saved, scrollY, height: document.documentElement.scrollHeight })}`);
    const reopenCold = () => {
      app.lockNow();
      if (app.imageCache.size) throw Error('Lock retained decrypted image cache');
      fresh(); app.messages = messages(); app.uiPreferences = { chatAnchor: structuredClone(saved) };
      app.restoreChatAnchorOnNextRender = true; app.renderChat();
      return document.querySelector('#message-list');
    };
    list = reopenCold(); await settleLayout();
    if (!sameAnchor(app.uiPreferences.chatAnchor, saved) || !sameAnchor(app.chatRestoreAnchor, saved)) throw Error('Cold placeholder replaced the intended restored anchor');
    warm();
    for (const button of list.querySelectorAll('.image-preview')) {
      const manifest = manifests.find(item => item.blobId === button.dataset.blobId);
      await app.renderImageIntoButton(button, manifest, app.imageCache.get(manifest.blobId));
    }
    await settleLayout();
    const restored = structuredClone(app.captureChatAnchor());
    if (!sameAnchor(restored, saved) || app.chatRestoreAnchor) throw Error(`Decoded images lost the restored anchor: ${JSON.stringify({ saved, restored })}`);

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
    app.lockNow();
    return { saved, restored, userScrollPreserved: true, lockClearsCache: true };
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
    if (app.messages.size || app.pending.size || app.reactionHistory.size) throw Error('Background lock retained decrypted message state');
    return { blurCoverage: 'same event stack', transientFocus: 'restored', backgroundReturn: 'authentication required', selection: 'cleared' };
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
    for (const box of [picker, actions]) {
      if (box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight || !box.width || !box.height) throw Error(`Long message actions are clipped at 320px: ${JSON.stringify({ picker, actions })}`);
    }
    if (Math.min(picker.right, actions.right) > Math.max(picker.left, actions.left) && Math.min(picker.bottom, actions.bottom) > Math.max(picker.top, actions.top)) throw Error('Long message action list overlaps its reaction bar');
    return { viewportWidth: innerWidth, picker, actions, overlap: false };
  });
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
    app.reactionHistory = new Map(['regression-own', 'regression-peer'].map((senderId, index) => {
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
  let pages = 0;
  while (await page.locator('[data-gallery-load-more]').isVisible()) {
    await page.locator('[data-gallery-load-more]').click();
    await page.waitForFunction(() => !document.querySelector('[data-gallery-load-more]')?.disabled);
    if (++pages > 5) throw Error('Gallery scan did not advance');
  }
  results.gallery = { images: await page.locator('.gallery-tile').count(), olderImage: await page.locator('.gallery-tile[data-blob-id="photo-10"]').count(), pages };
  assert.equal(results.gallery.images, 62);
  assert.equal(results.gallery.olderImage, 1);

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
    await app.showDeviceInvite({ v: 1, kind: 'device-link', roomId: session.vault.roomId, linkId: 'regression-link', secret: 'test-secret', role: 'creator', authorizerId: 'regression-own', authorizerFingerprint: 'test', creatorFingerprint: 'test', expiresAt: '2026-09-04T01:10:00.000Z' }, session, app.runtimeEpoch, origin);
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

  results.documentScroll = await page.evaluate(async () => {
    const { app, fresh, message, session } = window.regression; fresh();
    app.uiPreferences.recoveryReminderDismissed = true; app.renderChat();
    app.messages = new Map(Array.from({ length: 50 }, (_, i) => [i + 1, {
      ...message(i + 1, { v: 1, kind: 'text', text: i % 2 ? '消息会从玻璃控件后面自然透过。' : '看到了，等会儿见。', sentAt: '2026-09-04T01:00:00.000Z' }),
      senderId: i % 2 ? session.vault.identity.publicBundle.deviceId : 'regression-peer', status: i === 49 ? 'stored' : 'delivered',
    }]));
    app.renderMessages({ scroll: 'bottom' });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
      viewport.dispatchEvent(new Event('resize')); await settle();
      const composer = document.querySelector('#composer').getBoundingClientRect();
      const latest = list.lastElementChild.getBoundingClientRect();
      if (Math.abs(composer.bottom - 444) > 1 || latest.bottom > composer.top - 12) throw Error('Keyboard viewport covered the latest message or displaced the composer');
      delete viewport.height; delete viewport.offsetTop;
      viewport.dispatchEvent(new Event('resize')); await settle();
      if (app.chatBottomGap() > 2) throw Error('Closing the keyboard lost the latest message');
    }
    return { scroller: 'document', headerFixed: true, scrollPreserved: true, dialogScrollLock: true, keyboardViewport: 'composer and latest message remain visible' };
  });
  if (visualQaDirectory) {
    for (const scheme of ['light', 'dark']) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(() => window.scrollBy(0, -100));
      await page.screenshot({ path: path.join(visualQaDirectory, `chat-glass-${scheme}-390.png`) });
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
