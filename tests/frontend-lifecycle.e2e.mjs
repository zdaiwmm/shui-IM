import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
server.middlewares.use('/__frontend_regression', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});
let browser;
const results = {};
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__frontend_regression`);
  await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/chat-interactions.css');
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
      app.messages = new Map(); app.pending = new Map(); app.uiPreferences = {}; app.restoreChatAnchorOnNextRender = false;
      app.renderChat();
    };
    window.regression = { app, root, session, vault, message, fresh };
    fresh();
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
      if (!document.querySelector('.cover-trigger') || document.querySelector('.message-copy-sheet')) throw Error(`Clipboard ${outcome} crossed lock boundary`);
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
      if (current?.dataset.sourceId !== 'message-2' || current.classList.contains('message-copy-sheet')) throw Error(`Old clipboard ${outcome} replaced the newer menu`);
      app.closeMessageActions(false, false);
    }
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText });
    return { rejectedAfterMenuSwitch: 'ignored', resolvedAfterMenuSwitch: 'ignored' };
  });

  // Opening can span a frame. A selection made before the first animation
  // frame must remain the user's selection when the dialog finishes mounting.
  results.selectiveCopyReadiness = await page.evaluate(async () => {
    const { app, message, fresh } = window.regression; fresh();
    const requestFrame = window.requestAnimationFrame;
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    const frames = [];
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    app.openMessageTextSelection(message(1, { v: 1, kind: 'text', text: 'browser-e2e-live', sentAt: '2026-09-04T01:00:00.000Z' }));
    const textarea = document.querySelector('.message-copy-sheet textarea');
    textarea.focus(); textarea.setSelectionRange(8, 11);
    window.requestAnimationFrame = requestFrame;
    for (const callback of frames) callback(performance.now());
    let copied;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { copied = text; } });
    document.querySelector('[data-copy-selection]').click();
    await Promise.resolve();
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: writeText });
    if (copied !== 'e2e') throw Error(`Dialog initialization replaced the chosen range: copied=${JSON.stringify(copied)} range=${textarea.selectionStart}:${textarea.selectionEnd}`);
    app.closeMessageActions(false, false);
    return { selectionBeforeInitialFramePreserved: true, copiedText: copied };
  });

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
    window.fetch = () => new Promise(resolve => { release = () => resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })); });
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
    assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.device-link-sheet'))), true);
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
    if (app.privacyCovered) throw Error('Export exception did not allow its own blur');
    app.finishFileExport(true);
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: hasFocus });
    if (!app.privacyCovered || !document.querySelector('.cover-trigger')) throw Error('Suppressed export blur was not covered on completion');
    return { deferredBlurCovered: true };
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
    list.scrollTop = list.scrollHeight / 2;
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
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
