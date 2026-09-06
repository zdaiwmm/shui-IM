import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Exercise the production long-press menus and encrypted local projections.
// Network delivery is intentionally absent: the optimistic delete event must
// be durable before any socket is available.
const server = await createServer({
  configFile: false,
  appType: 'custom',
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use('/__message_deletion', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__message_deletion`);

  const fixture = await page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/gallery.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const vaultModule = await import('/src/lib/vault.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { toBase64Url } = await import('/src/lib/base64.ts');

    const capabilities = [
      'image-album-v1',
      'file-message-v1',
      'reply-v2',
      'voice-message-v1',
      'message-reactions-v1',
      'message-delete-v1',
    ];
    const [identity, linkedIdentity, peerIdentity] = await Promise.all([
      generateIdentity(),
      generateIdentity(),
      generateIdentity(),
    ]);
    const own = { ...identity.publicBundle, role: 'creator', status: 'active', capabilities: [...capabilities] };
    const linked = { ...linkedIdentity.publicBundle, role: 'creator', status: 'active', capabilities: [...capabilities] };
    const peer = { ...peerIdentity.publicBundle, role: 'joiner', status: 'active', capabilities: [...capabilities] };
    const roomId = crypto.randomUUID();
    const session = await vaultModule.createVault({
      v: 1,
      roomId,
      accessToken: 'message-deletion-e2e-token',
      role: 'creator',
      protocol: 'legacy-v1',
      lastSeq: 7,
      members: [own, peer],
      identity,
    }, 'message-deletion-e2e-password', 'password');
    const sentAt = '2026-09-05T08:00:00.000Z';
    const ids = {
      ownLocalImage: crypto.randomUUID(),
      peerReplyLocal: crypto.randomUUID(),
      peerMessage: crypto.randomUUID(),
      ownGlobal: crypto.randomUUID(),
      peerReplyGlobal: crypto.randomUUID(),
      ownMenuRace: crypto.randomUUID(),
      ownSwipeRace: crypto.randomUUID(),
      pendingImage: crypto.randomUUID(),
      failedFile: crypto.randomUUID(),
    };
    const image = {
      v: 1,
      blobId: crypto.randomUUID(),
      key: toBase64Url(new Uint8Array(32).fill(7)),
      ivPrefix: toBase64Url(new Uint8Array(8).fill(11)),
      chunkSize: 2 * 1024 * 1024,
      chunkCount: 1,
      originalSize: 1,
      originalName: '仍保留在保险箱.png',
      mimeType: 'image/png',
      lastModified: 1,
      sha256: 'ab'.repeat(32),
    };
    const pendingImage = {
      ...image,
      blobId: crypto.randomUUID(),
      originalName: '等待发送的图片.png',
    };
    const failedFile = {
      ...image,
      blobId: crypto.randomUUID(),
      originalName: '发送失败的文件.pdf',
      mimeType: 'application/pdf',
    };
    const messages = [
      {
        seq: 1,
        clientMsgId: ids.ownLocalImage,
        senderId: own.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: { v: 1, kind: 'image', image, sentAt },
      },
      {
        seq: 2,
        clientMsgId: ids.peerReplyLocal,
        senderId: peer.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: {
          v: 2,
          kind: 'text',
          text: '这是对本机删除目标的回复',
          sentAt,
          replyTo: {
            clientMsgId: ids.ownLocalImage,
            serverSeq: 1,
            senderId: own.deviceId,
            kind: 'image',
            preview: '图片',
          },
        },
      },
      {
        seq: 3,
        clientMsgId: ids.peerMessage,
        senderId: peer.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: { v: 1, kind: 'text', text: '对方消息只能在本机删除', sentAt },
      },
      {
        seq: 4,
        clientMsgId: ids.ownGlobal,
        senderId: own.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: { v: 1, kind: 'text', text: '准备为所有人删除', sentAt },
      },
      {
        seq: 5,
        clientMsgId: ids.peerReplyGlobal,
        senderId: peer.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: {
          v: 2,
          kind: 'text',
          text: '这是对全员删除目标的回复',
          sentAt,
          replyTo: {
            clientMsgId: ids.ownGlobal,
            serverSeq: 4,
            senderId: own.deviceId,
            kind: 'text',
            preview: '文字消息',
          },
        },
      },
      {
        seq: 6,
        clientMsgId: ids.ownMenuRace,
        senderId: own.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: { v: 1, kind: 'text', text: '菜单打开期间被远端设备删除', sentAt },
      },
      {
        seq: 7,
        clientMsgId: ids.ownSwipeRace,
        senderId: own.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: { v: 1, kind: 'text', text: '回复滑动期间被远端设备删除', sentAt },
      },
    ];
    const pendingMessages = [
      {
        seq: Number.MAX_SAFE_INTEGER,
        clientMsgId: ids.pendingImage,
        senderId: own.deviceId,
        status: 'pending',
        acceptedAt: '2026-09-05T08:00:01.000Z',
        payload: { v: 1, kind: 'image', image: pendingImage, sentAt },
      },
      {
        // Status, rather than a coincidental numeric sequence, decides whether
        // a failed row may offer cross-device deletion.
        seq: 11,
        clientMsgId: ids.failedFile,
        senderId: own.deviceId,
        status: 'failed',
        acceptedAt: '2026-09-05T08:00:02.000Z',
        payload: { v: 1, kind: 'file', file: failedFile, sentAt },
      },
    ];
    await vaultModule.withVaultMutation(session, async mutation => {
      for (const message of messages) await vaultModule.saveHistoryMessage(session, message, mutation);
    });

    const root = document.querySelector('#app');
    const app = new QuietRoomApp(root);
    app.updateBackgroundNotificationControl = async () => {};
    app.mountChatImageObserver = () => {};
    app.mountGalleryThumbnails = () => {};
    app.unreadCounter.markRead = async () => {};
    app.connectSocket = async () => {};
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch += 1;
    app.runtimeAbort = new AbortController();
    app.restoreChatAnchorOnNextRender = false;
    app.historyHasMore = false;
    app.historyHasNewer = false;
    app.messages = new Map(messages.map(message => [message.seq, message]));
    app.messageEventHistory = new Map();
    app.pending = new Map(pendingMessages.map(message => [message.clientMsgId, message]));
    app.outbox = new Map(pendingMessages.map(message => [message.clientMsgId, {
      clientMsgId: message.clientMsgId,
      payload: message.payload,
      createdAt: message.acceptedAt,
    }]));
    app.uiPreferences = {};
    app.uiPreferencesHydrated = true;
    app.connectionState = 'disconnected';
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    app.renderChat();
    const injectRemoteDelete = (targetClientMsgId, eventSeq) => {
      const target = messages.find(message => message.clientMsgId === targetClientMsgId);
      if (!target) throw new Error(`Unknown remote-delete target ${targetClientMsgId}`);
      if (!session.vault.members.some(member => member.deviceId === linked.deviceId)) session.vault.members.push(linked);
      const event = {
        seq: eventSeq,
        clientMsgId: crypto.randomUUID(),
        senderId: linked.deviceId,
        status: 'delivered',
        acceptedAt: sentAt,
        payload: {
          v: 1,
          kind: 'message-delete',
          sentAt,
          target: {
            clientMsgId: target.clientMsgId,
            serverSeq: target.seq,
            senderId: target.senderId,
          },
        },
      };
      app.messages.set(event.seq, event);
      app.renderMessages({ scroll: 'preserve' });
      return event;
    };
    window.messageDeletion = { app, ids, image, linked, peer, messages, pendingMessages, root, session, vaultModule, injectRemoteDelete };
    return { ids, ownDeviceId: own.deviceId, linkedDeviceId: linked.deviceId, roomId };
  });

  let pointerId = 20;
  const messageSelector = clientMsgId => `.message[data-client-msg-id="${clientMsgId}"]`;
  const longPress = async clientMsgId => {
    const row = page.locator(messageSelector(clientMsgId));
    await row.waitFor({ state: 'visible' });
    await row.scrollIntoViewIfNeeded();
    const box = await row.boundingBox();
    assert(box, `Message ${clientMsgId} has no touch target`);
    const event = {
      pointerId: pointerId++,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: box.x + Math.min(30, box.width / 2),
      clientY: box.y + Math.min(30, box.height / 2),
    };
    await row.dispatchEvent('pointerdown', event);
    await page.locator(`.message-actions.is-visible[data-source-id="${clientMsgId}"]`).waitFor({ timeout: 2500 });
    await row.dispatchEvent('pointerup', event);
  };
  const closeActions = async () => {
    await page.evaluate(() => window.messageDeletion.app.closeMessageActions(false, false));
    await page.locator('.message-actions').waitFor({ state: 'detached' });
  };
  const dangerSamples = [];
  const sampleDanger = async (locator, label) => {
    const sample = await locator.evaluate(button => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--danger)';
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      const span = button.querySelector('span');
      const path = button.querySelector('svg path');
      const pathStyle = path ? getComputedStyle(path) : null;
      const stroke = pathStyle?.stroke ?? null;
      const fill = pathStyle?.fill ?? null;
      return {
        expected,
        button: getComputedStyle(button).color,
        text: span ? getComputedStyle(span).color : null,
        stroke,
        fill,
        iconPaint: stroke && stroke !== 'none' ? stroke : fill,
      };
    });
    dangerSamples.push({ label, ...sample });
  };

  // An own message exposes the red destructive entry and both scopes.
  await longPress(fixture.ids.ownLocalImage);
  const ownDelete = page.locator('.message-actions [data-message-action="delete"]');
  assert.equal(await ownDelete.getAttribute('data-danger'), 'true');
  assert.equal((await ownDelete.locator('span').textContent()).trim(), '删除');
  assert.equal(await ownDelete.locator('svg').count(), 1, 'Own delete entry lost its trash icon');
  await sampleDanger(ownDelete, 'own main delete');
  await ownDelete.click();
  const ownChoices = await page.locator('.message-action-list > button').evaluateAll(buttons => buttons.map(button => ({
    action: button.dataset.messageAction,
    danger: button.dataset.danger,
    label: button.querySelector('span')?.textContent?.trim(),
    icons: button.querySelectorAll('svg').length,
  })));
  assert.deepEqual(ownChoices, [
    { action: 'delete-everyone', danger: 'true', label: '为所有人删除', icons: 1 },
    { action: 'delete-local', danger: 'true', label: '仅为我删除', icons: 1 },
  ]);
  await sampleDanger(page.locator('[data-message-action="delete-everyone"]'), 'own delete for everyone');
  await sampleDanger(page.locator('[data-message-action="delete-local"]'), 'own delete locally');
  await closeActions();

  // A peer message can only be hidden from this device.
  await longPress(fixture.ids.peerMessage);
  const peerDelete = page.locator('.message-actions [data-message-action="delete"]');
  await sampleDanger(peerDelete, 'peer main delete');
  await peerDelete.click();
  const peerChoices = await page.locator('.message-action-list > button').evaluateAll(buttons => buttons.map(button => ({
    action: button.dataset.messageAction,
    label: button.querySelector('span')?.textContent?.trim(),
    danger: button.dataset.danger,
  })));
  assert.deepEqual(peerChoices, [{ action: 'delete-local', label: '仅为我删除', danger: 'true' }]);
  await sampleDanger(page.locator('[data-message-action="delete-local"]'), 'peer delete locally');
  await closeActions();

  // Local deletion must not survive only in memory. If encrypted preference
  // persistence fails, restore the row and its prior preference projection.
  await page.evaluate(() => {
    const state = window.messageDeletion;
    state.originalChatDeleteSave = state.app.saveUiPreferencesNow;
    state.app.saveUiPreferencesNow = async () => { throw new Error('synthetic chat-delete preference failure'); };
  });
  await longPress(fixture.ids.peerMessage);
  await page.locator('[data-message-action="delete"]').click();
  await page.locator('[data-message-action="delete-local"]').click();
  await page.waitForFunction(targetId => document.querySelector('#notice')?.textContent?.startsWith('本机删除未能保存，消息已恢复')
    && Boolean(document.querySelector(`.message[data-client-msg-id="${CSS.escape(targetId)}"]`)), fixture.ids.peerMessage);
  assert.equal(await page.evaluate(targetId => (window.messageDeletion.app.uiPreferences.hiddenChatMessageIds ?? []).includes(targetId), fixture.ids.peerMessage), false,
    'Failed local deletion left an unsaved hidden-message projection');
  await page.evaluate(() => {
    const state = window.messageDeletion;
    state.app.saveUiPreferencesNow = state.originalChatDeleteSave;
  });

  // Begin a reply, then locally delete that exact target. The active draft is
  // invalidated at once and the target disappears only from this projection.
  await longPress(fixture.ids.ownLocalImage);
  await page.locator('.message-actions [data-message-action="reply"]').click();
  await page.locator('.message-actions').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#reply-draft').evaluate(element => !element.hidden), true, 'Reply draft did not open');
  assert.equal(await page.evaluate(() => window.messageDeletion.app.replyTarget?.clientMsgId), fixture.ids.ownLocalImage);

  await longPress(fixture.ids.ownLocalImage);
  await page.locator('.message-actions [data-message-action="delete"]').click();
  await page.locator('.message-actions [data-message-action="delete-local"]').click();
  await page.locator(messageSelector(fixture.ids.ownLocalImage)).waitFor({ state: 'detached' });
  assert.equal(await page.locator('#reply-draft').evaluate(element => element.hidden), true, 'Local delete left a reply draft targeting hidden content');
  assert.equal(await page.evaluate(() => window.messageDeletion.app.replyTarget), null);

  const localPersistence = await page.evaluate(async () => {
    const { app, ids, linked, session, vaultModule } = window.messageDeletion;
    app.flushUiPreferencesSave();
    await app.preferenceSaveChain;
    const saved = await vaultModule.loadUiPreferences(session);
    const linkedSession = {
      ...session,
      vault: {
        ...session.vault,
        identity: { ...session.vault.identity, publicBundle: linked },
      },
    };
    const linkedPreferences = await vaultModule.loadUiPreferences(linkedSession);
    const historyMessage = await vaultModule.loadHistoryMessage(session, 1);
    const rawPreferences = await new Promise((resolve, reject) => {
      const open = indexedDB.open('quiet-room');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('preferences', 'readonly');
        const request = transaction.objectStore('preferences').getAll();
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => { database.close(); resolve(request.result); };
      };
    });
    return {
      saved,
      linkedPreferences,
      history: historyMessage && {
        clientMsgId: historyMessage.clientMsgId,
        kind: historyMessage.payload.kind,
        originalName: historyMessage.payload.kind === 'image' ? historyMessage.payload.image.originalName : null,
      },
      stillInChatMap: app.messages.get(1)?.clientMsgId === ids.ownLocalImage,
      rawPreferences,
    };
  });
  assert.deepEqual(localPersistence.saved.hiddenChatMessageIds, [fixture.ids.ownLocalImage]);
  assert.equal(localPersistence.linkedPreferences.hiddenChatMessageIds, undefined, 'A linked device inherited this device\'s local deletion');
  assert.deepEqual(localPersistence.history, {
    clientMsgId: fixture.ids.ownLocalImage,
    kind: 'image',
    originalName: '仍保留在保险箱.png',
  });
  assert.equal(localPersistence.stillInChatMap, true, 'Local delete removed the underlying chat record');
  assert.equal(localPersistence.rawPreferences.length, 1, 'Unexpected preference scope or plaintext shadow record');
  assert.equal(localPersistence.rawPreferences[0].id, `${fixture.roomId}:ui:${fixture.ownDeviceId}`);
  assert.equal(typeof localPersistence.rawPreferences[0].iv, 'string');
  assert.equal(typeof localPersistence.rawPreferences[0].ciphertext, 'string');
  assert.equal(JSON.stringify(localPersistence.rawPreferences).includes(fixture.ids.ownLocalImage), false, 'Local deletion target leaked outside encrypted preferences');
  assert.equal(JSON.stringify(localPersistence.rawPreferences).includes('hiddenChatMessageIds'), false, 'Preference field name leaked outside ciphertext');

  await page.evaluate(() => window.messageDeletion.app.renderGallery());
  const safeAsset = page.locator(`[data-gallery-asset-key="${fixture.ids.ownLocalImage}:0"]`);
  await safeAsset.waitFor({ state: 'attached', timeout: 2500 });
  assert.equal(await safeAsset.getAttribute('data-blob-id'), await page.evaluate(() => window.messageDeletion.image.blobId), 'Safe no longer points to the original encrypted asset');

  // Pin/delete are not allowed to look successful when encrypted preference
  // persistence fails. The action sheet stays retryable and local state rolls
  // back instead of being silently restored on the next launch.
  await page.evaluate(() => {
    const state = window.messageDeletion;
    state.originalSaveUiPreferencesNow = state.app.saveUiPreferencesNow;
    state.app.saveUiPreferencesNow = async () => { throw new Error('synthetic preference write failure'); };
  });
  await safeAsset.dispatchEvent('contextmenu');
  await page.locator('.gallery-actions-sheet.is-visible').waitFor();
  await page.locator('[data-gallery-action="pin"]').click();
  await page.waitForFunction(() => document.querySelector('#notice')?.textContent?.startsWith('保险箱操作未能保存，未做更改'));
  assert.equal(await page.locator('.gallery-actions-sheet.is-visible').getAttribute('aria-busy'), null,
    'Failed Safe persistence left its action sheet busy');
  assert.equal(await page.locator('[data-gallery-action="pin"]').isEnabled(), true,
    'Failed Safe persistence left its retry action disabled');
  assert.equal(await page.evaluate(() => window.messageDeletion.app.uiPreferences.galleryCuration), undefined,
    'Failed Safe persistence left an optimistic curation record behind');
  await page.evaluate(() => {
    const state = window.messageDeletion;
    state.app.saveUiPreferencesNow = state.originalSaveUiPreferencesNow;
    state.app.renderGallery();
  });
  await page.locator('.gallery-actions-sheet').waitFor({ state: 'detached' });

  // A global delete event can be loaded independently from a much older media
  // page. Keep the target out of the chat cache and beyond the first 200-record
  // Safe scan so the gallery must join the event with the page as it arrives.
  const pagedDeletion = await page.evaluate(async () => {
    const { app, image, session, vaultModule } = window.messageDeletion;
    const sentAt = '2026-09-05T08:30:00.000Z';
    const targetId = crypto.randomUUID();
    const target = {
      seq: 8,
      clientMsgId: targetId,
      senderId: session.vault.identity.publicBundle.deviceId,
      status: 'delivered',
      acceptedAt: sentAt,
      payload: {
        v: 1,
        kind: 'image',
        image: { ...image, blobId: crypto.randomUUID(), originalName: '较早的全员删除图片.png' },
        sentAt,
      },
    };
    const records = [target];
    for (let seq = 9; seq <= 208; seq += 1) records.push({
      seq,
      clientMsgId: crypto.randomUUID(),
      senderId: session.vault.identity.publicBundle.deviceId,
      status: 'delivered',
      acceptedAt: sentAt,
      payload: { v: 1, kind: 'text', text: `分页填充 ${seq}`, sentAt },
    });
    const event = {
      seq: 209,
      clientMsgId: crypto.randomUUID(),
      senderId: session.vault.identity.publicBundle.deviceId,
      status: 'delivered',
      acceptedAt: sentAt,
      payload: {
        v: 1,
        kind: 'message-delete',
        target: { clientMsgId: targetId, serverSeq: 8, senderId: target.senderId },
        sentAt,
      },
    };
    records.push(event);
    await vaultModule.withVaultMutation(session, async mutation => {
      for (const record of records) await vaultModule.saveHistoryMessage(session, record, mutation);
    });
    app.messageEventHistory.set(event.seq, event);
    app.messages = new Map([...app.messages].filter(([seq]) => seq < 8));
    app.renderGallery();
    return { targetId };
  });
  await page.waitForFunction(() => document.querySelector('.gallery-scan-status')?.textContent?.startsWith('已加载本机保存的全部'));
  assert.equal(await page.locator(`[data-gallery-asset-key="${pagedDeletion.targetId}:0"]`).count(), 0,
    'A globally deleted image returned when its older Safe page loaded after the delete event');
  assert.equal(await page.evaluate(async () => (await window.messageDeletion.vaultModule.loadHistoryMessage(
    window.messageDeletion.session, 8,
  ))?.clientMsgId), pagedDeletion.targetId, 'Global deletion mutated the immutable encrypted history record');

  await page.evaluate(() => window.messageDeletion.app.renderChat());
  await page.locator(messageSelector(fixture.ids.peerReplyLocal)).waitFor({ state: 'visible' });
  assert.equal(await page.locator(`${messageSelector(fixture.ids.peerReplyLocal)} .message-reply-quote span`).textContent(), '消息已删除');
  await page.locator(`${messageSelector(fixture.ids.peerReplyLocal)} .message-reply-quote`).click();
  await page.waitForFunction(() => document.querySelector('#notice')?.textContent === '原消息已删除');
  assert.equal(await page.locator(messageSelector(fixture.ids.ownLocalImage)).count(), 0, 'Clicking a deleted reply quote restored its target');
  assert.equal(await page.evaluate(() => window.messageDeletion.app.replyTarget), null, 'Clicking a deleted reply quote created a reply target');

  const deviceProjection = await page.evaluate(() => {
    const { app, ids } = window.messageDeletion;
    const ownPreferences = structuredClone(app.uiPreferences);
    app.uiPreferences = {};
    app.renderMessages({ scroll: 'preserve' });
    const linkedDeviceSeesTarget = Boolean(document.querySelector(`.message[data-client-msg-id="${ids.ownLocalImage}"]`));
    app.uiPreferences = ownPreferences;
    app.renderMessages({ scroll: 'preserve' });
    const deletingDeviceHidesTarget = !document.querySelector(`.message[data-client-msg-id="${ids.ownLocalImage}"]`);
    return { linkedDeviceSeesTarget, deletingDeviceHidesTarget };
  });
  assert.deepEqual(deviceProjection, { linkedDeviceSeesTarget: true, deletingDeviceHidesTarget: true });

  // Pending and failed attachments remain durable outbox work even when this
  // device hides their chat rows. They cannot be deleted for everyone before
  // the server assigns a sequence, but they must still expose the red local
  // deletion path.
  await page.evaluate(() => {
    const state = window.messageDeletion;
    state.pendingDeleteSnapshots = {
      imageOutbox: state.app.outbox.get(state.ids.pendingImage),
      fileOutbox: state.app.outbox.get(state.ids.failedFile),
      failedMessage: state.app.pending.get(state.ids.failedFile),
      storedVault: JSON.stringify(state.session.stored),
    };
  });

  await longPress(fixture.ids.pendingImage);
  const pendingDelete = page.locator('.message-actions [data-message-action="delete"]');
  assert.equal(await page.locator('.message-reaction-picker').count(), 0, 'Pending image unexpectedly exposed reactions');
  assert.equal(await page.locator('[data-message-action="reply"]').count(), 0, 'Pending image unexpectedly exposed reply');
  assert.equal(await pendingDelete.getAttribute('data-danger'), 'true');
  await sampleDanger(pendingDelete, 'pending image main delete');
  await pendingDelete.click();
  const pendingChoices = await page.locator('.message-action-list > button').evaluateAll(buttons => buttons.map(button => ({
    action: button.dataset.messageAction,
    label: button.querySelector('span')?.textContent?.trim(),
    danger: button.dataset.danger,
  })));
  assert.deepEqual(pendingChoices, [{ action: 'delete-local', label: '仅为我删除', danger: 'true' }]);
  await sampleDanger(page.locator('[data-message-action="delete-local"]'), 'pending image delete locally');
  await page.locator('[data-message-action="delete-local"]').click();
  await page.locator(messageSelector(fixture.ids.pendingImage)).waitFor({ state: 'detached' });

  await longPress(fixture.ids.failedFile);
  const failedDelete = page.locator('.message-actions [data-message-action="delete"]');
  assert.equal(await page.locator('.message-reaction-picker').count(), 0, 'Failed file unexpectedly exposed reactions');
  assert.equal(await page.locator('[data-message-action="reply"]').count(), 0, 'Failed file unexpectedly exposed reply');
  assert.equal(await failedDelete.getAttribute('data-danger'), 'true');
  await sampleDanger(failedDelete, 'failed file main delete');
  await failedDelete.click();
  const failedChoices = await page.locator('.message-action-list > button').evaluateAll(buttons => buttons.map(button => ({
    action: button.dataset.messageAction,
    label: button.querySelector('span')?.textContent?.trim(),
    danger: button.dataset.danger,
  })));
  assert.deepEqual(failedChoices, [{ action: 'delete-local', label: '仅为我删除', danger: 'true' }]);
  await page.locator('[data-message-action="delete-local"]').click();
  await page.locator(messageSelector(fixture.ids.failedFile)).waitFor({ state: 'detached' });

  const pendingLocalDeletion = await page.evaluate(async () => {
    const { app, ids, pendingDeleteSnapshots, session, vaultModule } = window.messageDeletion;
    app.flushUiPreferencesSave();
    await app.preferenceSaveChain;
    const saved = await vaultModule.loadUiPreferences(session);
    const imageMessage = app.pending.get(ids.pendingImage);
    if (!imageMessage) throw new Error('Pending image was removed instead of hidden');

    // A socket ACK changes only delivery metadata and retains the MAX sentinel
    // until sync. The local projection must not flash the row back into view.
    imageMessage.status = 'stored';
    app.renderMessages({ scroll: 'preserve' });
    const hiddenAfterAck = !document.querySelector(`.message[data-client-msg-id="${ids.pendingImage}"]`);

    // Model the subsequent sync assigning a real sequence. The durable local
    // preference follows the client message ID across that transition.
    app.pending.delete(ids.pendingImage);
    imageMessage.seq = 10;
    app.messages.set(10, imageMessage);
    app.renderMessages({ scroll: 'preserve' });
    return {
      savedHiddenIds: saved.hiddenChatMessageIds,
      hiddenAfterAck,
      hiddenAfterSync: !document.querySelector(`.message[data-client-msg-id="${ids.pendingImage}"]`),
      confirmedRecordRetained: app.messages.get(10) === imageMessage,
      failedRecordRetained: app.pending.get(ids.failedFile) === pendingDeleteSnapshots.failedMessage,
      imageOutboxRetained: app.outbox.get(ids.pendingImage) === pendingDeleteSnapshots.imageOutbox,
      fileOutboxRetained: app.outbox.get(ids.failedFile) === pendingDeleteSnapshots.fileOutbox,
      encryptedVaultUnchanged: JSON.stringify(session.stored) === pendingDeleteSnapshots.storedVault,
    };
  });
  assert.deepEqual(pendingLocalDeletion, {
    savedHiddenIds: [fixture.ids.ownLocalImage, fixture.ids.pendingImage, fixture.ids.failedFile],
    hiddenAfterAck: true,
    hiddenAfterSync: true,
    confirmedRecordRetained: true,
    failedRecordRetained: true,
    imageOutboxRetained: true,
    fileOutboxRetained: true,
    encryptedVaultUnchanged: true,
  });

  // A confirmed tombstone can arrive after a long-press menu captured its
  // source message. The live menu must disappear synchronously, and even the
  // detached buttons' already-bound handlers must fail closed.
  await longPress(fixture.ids.ownMenuRace);
  await page.evaluate(() => {
    const state = window.messageDeletion;
    const actions = state.root.querySelector('.message-actions');
    state.clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { state.clipboardWrites.push(text); } },
    });
    state.staleMenuButtons = {
      copy: actions.querySelector('[data-message-action="copy"]'),
      reaction: actions.querySelector('.message-reaction-picker button'),
      reply: actions.querySelector('[data-message-action="reply"]'),
    };
    if (Object.values(state.staleMenuButtons).some(button => !button)) throw new Error('Stale-menu fixture missed an action');
    state.injectRemoteDelete(state.ids.ownMenuRace, 8);
  });
  await page.locator('.message-actions').waitFor({ state: 'detached' });
  await page.locator(messageSelector(fixture.ids.ownMenuRace)).waitFor({ state: 'detached' });
  const staleMenuResult = await page.evaluate(async () => {
    const state = window.messageDeletion;
    const { app, ids, messages, root, staleMenuButtons } = state;
    staleMenuButtons.copy.click();
    staleMenuButtons.reaction.click();
    staleMenuButtons.reply.click();
    await Promise.resolve();
    await app.sendChain;

    const staleTarget = messages.find(message => message.clientMsgId === ids.ownMenuRace);
    app.replyTarget = staleTarget;
    app.renderReplyDraft();
    const draftVisibleBeforeSubmit = !root.querySelector('#reply-draft').hidden;
    const input = root.querySelector('#message-input');
    input.value = '不能携带已删除的引用发送';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('#composer').requestSubmit();
    await Promise.resolve();
    await app.sendChain;
    const result = {
      clipboardWrites: [...state.clipboardWrites],
      draftVisibleBeforeSubmit,
      draftHiddenAfterSubmit: root.querySelector('#reply-draft').hidden,
      replyTargetAfterSubmit: app.replyTarget,
      retainedDraft: input.value,
      pendingReactions: [...app.pending.values()].filter(message => message.payload.kind === 'reaction').length,
      pendingTexts: [...app.pending.values()].filter(message => message.payload.kind === 'text').length,
      notice: root.querySelector('#notice').textContent,
    };
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return result;
  });
  assert.deepEqual(staleMenuResult, {
    clipboardWrites: [],
    draftVisibleBeforeSubmit: true,
    draftHiddenAfterSubmit: true,
    replyTargetAfterSubmit: null,
    retainedDraft: '不能携带已删除的引用发送',
    pendingReactions: 0,
    pendingTexts: 0,
    notice: '原消息已删除，回复已取消',
  });

  // The same race can happen after the swipe has crossed its activation
  // threshold but before pointerup. The production gesture now tracks release
  // on window so it survives a detached row; dispatch there to prove the
  // captured settle callback cannot revive the deleted message.
  const staleSwipeResult = await page.evaluate(async () => {
    const state = window.messageDeletion;
    const { app, ids, root } = state;
    const article = root.querySelector(`.message[data-client-msg-id="${CSS.escape(ids.ownSwipeRace)}"]`);
    if (!article) throw new Error('Swipe-race target was not rendered');
    const rect = article.getBoundingClientRect();
    const pointerId = 801;
    const startX = rect.right - 20;
    const y = rect.top + Math.min(28, rect.height / 2);
    article.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: 1, clientX: startX, clientY: y,
    }));
    article.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: 1, clientX: startX - 100, clientY: y,
    }));
    const armedBeforeDelete = article.classList.contains('is-reply-armed');
    state.injectRemoteDelete(ids.ownSwipeRace, 9);
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary: true,
      button: 0, buttons: 0, clientX: startX - 100, clientY: y,
    }));
    await Promise.resolve();
    return {
      armedBeforeDelete,
      sourceStillConnected: article.isConnected,
      sourceRendered: Boolean(root.querySelector(`.message[data-client-msg-id="${CSS.escape(ids.ownSwipeRace)}"]`)),
      replyTarget: app.replyTarget,
      replyDraftHidden: root.querySelector('#reply-draft').hidden,
      pendingReactions: [...app.pending.values()].filter(message => message.payload.kind === 'reaction').length,
      notice: root.querySelector('#notice').textContent,
    };
  });
  assert.deepEqual(staleSwipeResult, {
    armedBeforeDelete: true,
    sourceStillConnected: false,
    sourceRendered: false,
    replyTarget: null,
    replyDraftHidden: true,
    pendingReactions: 0,
    notice: '原消息已删除',
  });
  await page.evaluate(() => {
    const { app, linked } = window.messageDeletion;
    // The linked same-role member exists only to authenticate the two injected
    // remote events above. Restore a valid two-member legacy room before the
    // real encryption path exercised by the queued retry below.
    app.session.vault.members = app.session.vault.members.filter(member => member.deviceId !== linked.deviceId);
    for (const seq of [6, 7, 8, 9]) app.messages.delete(seq);
    app.renderMessages({ scroll: 'preserve' });
  });

  // An own confirmed message may be deleted for everyone. Keep it as the
  // active reply target first so the optimistic reducer must invalidate both
  // the row and its composer state without a server acknowledgement.
  await longPress(fixture.ids.ownGlobal);
  await page.locator('.message-actions [data-message-action="reply"]').click();
  await page.locator('.message-actions').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.messageDeletion.app.replyTarget?.clientMsgId), fixture.ids.ownGlobal);
  await longPress(fixture.ids.ownGlobal);
  await page.locator('.message-actions [data-message-action="delete"]').click();
  await page.locator('.message-actions [data-message-action="delete-everyone"]').click();
  await page.waitForFunction(targetId => {
    const { app } = window.messageDeletion;
    return !document.querySelector(`.message[data-client-msg-id="${targetId}"]`)
      && [...app.pending.values()].some(message => message.payload.kind === 'message-delete'
        && message.payload.target.clientMsgId === targetId);
  }, fixture.ids.ownGlobal);
  await page.waitForFunction(() => document.querySelector('#notice')?.textContent
    === '删除请求已加密保存在本机；连接恢复并同步后才会在其他设备生效');
  assert.equal(await page.evaluate(() => window.messageDeletion.app.connectionState), 'disconnected');
  assert.equal(await page.locator('#reply-draft').evaluate(element => element.hidden), true, 'Optimistic global delete left its reply draft open');
  assert.equal(await page.evaluate(() => window.messageDeletion.app.replyTarget), null);

  const globalPersistence = await page.evaluate(async () => {
    const { app, ids, session, vaultModule } = window.messageDeletion;
    await app.sendChain;
    const pendingDelete = [...app.pending.values()].find(message => message.payload.kind === 'message-delete'
      && message.payload.target.clientMsgId === ids.ownGlobal);
    const tombstone = app.messageDeletions().get(ids.ownGlobal);
    const outbox = await vaultModule.loadOutbox(session);
    const historyMessage = await vaultModule.loadHistoryMessage(session, 4);
    const rawOutbox = await new Promise((resolve, reject) => {
      const open = indexedDB.open('quiet-room');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const transaction = database.transaction('outbox', 'readonly');
        const request = transaction.objectStore('outbox').getAll();
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => { database.close(); resolve(request.result); };
      };
    });
    return {
      pendingDelete,
      tombstone,
      outbox,
      historyMessage: historyMessage && { clientMsgId: historyMessage.clientMsgId, kind: historyMessage.payload.kind },
      rawOutbox,
      targetStillInMessageMap: app.messages.get(4)?.clientMsgId === ids.ownGlobal,
    };
  });
  assert(globalPersistence.pendingDelete, 'No optimistic message-delete event was created');
  assert.equal(globalPersistence.pendingDelete.status, 'pending');
  assert.equal(globalPersistence.pendingDelete.seq, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(globalPersistence.pendingDelete.payload.target, {
    clientMsgId: fixture.ids.ownGlobal,
    serverSeq: 4,
    senderId: globalPersistence.pendingDelete.senderId,
  });
  assert.equal(globalPersistence.tombstone.pending, true, 'Target was not hidden by the optimistic reducer');
  assert.deepEqual(globalPersistence.tombstone.target, globalPersistence.pendingDelete.payload.target);
  const queuedDelete = globalPersistence.outbox.find(item => item.clientMsgId === globalPersistence.pendingDelete.clientMsgId);
  assert(queuedDelete, 'Encrypted outbox did not retain the all-participant deletion');
  assert.equal(queuedDelete.payload.kind, 'message-delete');
  assert.deepEqual(queuedDelete.payload.target, globalPersistence.pendingDelete.payload.target);
  assert.deepEqual(globalPersistence.historyMessage, { clientMsgId: fixture.ids.ownGlobal, kind: 'text' });
  assert.equal(globalPersistence.targetStillInMessageMap, true, 'Optimistic deletion destroyed the underlying history projection');
  assert.equal(globalPersistence.rawOutbox.length, 1);
  assert.equal(JSON.stringify(globalPersistence.rawOutbox).includes('message-delete'), false, 'Delete payload leaked outside encrypted outbox ciphertext');
  assert.equal(JSON.stringify(globalPersistence.rawOutbox).includes(fixture.ids.ownGlobal), false, 'Delete target leaked outside encrypted outbox ciphertext');

  // The socket ACK arrives before the subsequent sync assigns a real server
  // sequence. Its stored+MAX sentinel must remain an optimistic tombstone, and
  // mounted reply UI must stay in place without reverting for one render.
  const ackProjection = await page.evaluate(() => {
    const { app, ids, root } = window.messageDeletion;
    const pendingDelete = [...app.pending.values()].find(message => message.payload.kind === 'message-delete'
      && message.payload.target.clientMsgId === ids.ownGlobal);
    if (!pendingDelete) throw new Error('ACK fixture lost its pending deletion');
    const quoteSelector = `.message[data-client-msg-id="${CSS.escape(ids.peerReplyGlobal)}"] .message-reply-quote`;
    const quoteBefore = root.querySelector(quoteSelector);
    pendingDelete.status = 'stored';
    app.renderMessages({ scroll: 'preserve' });
    const quoteAfter = root.querySelector(quoteSelector);
    const tombstone = app.messageDeletions().get(ids.ownGlobal);
    return {
      status: pendingDelete.status,
      seq: pendingDelete.seq,
      targetVisible: Boolean(root.querySelector(`.message[data-client-msg-id="${CSS.escape(ids.ownGlobal)}"]`)),
      tombstonePending: tombstone?.pending,
      quoteText: quoteAfter?.querySelector('span')?.textContent,
      quoteAriaLabel: quoteAfter?.getAttribute('aria-label'),
      quoteNodeReused: quoteBefore === quoteAfter,
      originalQuoteStillConnected: quoteBefore?.isConnected,
    };
  });
  assert.deepEqual(ackProjection, {
    status: 'stored',
    seq: Number.MAX_SAFE_INTEGER,
    targetVisible: false,
    tombstonePending: true,
    quoteText: '消息已删除',
    quoteAriaLabel: '被回复的消息已删除',
    quoteNodeReused: true,
    originalQuoteStillConnected: true,
  });

  // Capability support can change after an outbox item already exists. A
  // retry must stop before encryption/socket delivery while preserving the
  // encrypted outbox and optimistic projection, then resume once every active
  // device reports support again.
  const capabilityRetry = await page.evaluate(async () => {
    const { app, ids, peer, root } = window.messageDeletion;
    const pendingDelete = [...app.pending.values()].find(message => message.payload.kind === 'message-delete'
      && message.payload.target.clientMsgId === ids.ownGlobal);
    const outboxItem = pendingDelete && app.outbox.get(pendingDelete.clientMsgId);
    const peerMember = app.session.vault.members.find(member => member.deviceId === peer.deviceId);
    if (!pendingDelete || !outboxItem || !peerMember) throw new Error('Capability-retry fixture is incomplete');
    const originalCapabilities = [...(peerMember.capabilities ?? [])];
    const sent = [];
    app.connectionState = 'connected';
    app.socket = {
      sendEnvelope: (envelope, countUnread) => sent.push({ clientMsgId: envelope.clientMsgId, countUnread }),
    };
    peerMember.capabilities = originalCapabilities.filter(capability => capability !== 'message-delete-v1');
    await app.attemptSend(outboxItem.clientMsgId);
    const blocked = {
      sends: sent.length,
      sameOutboxItem: app.outbox.get(outboxItem.clientMsgId) === outboxItem,
      samePendingItem: app.pending.get(outboxItem.clientMsgId) === pendingDelete,
      pendingStatus: pendingDelete.status,
      retryScheduled: app.retryTimers.has(outboxItem.clientMsgId),
      deferred: app.deferredCapabilityItems.has(outboxItem.clientMsgId),
      targetVisible: Boolean(root.querySelector(`.message[data-client-msg-id="${CSS.escape(ids.ownGlobal)}"]`)),
      tombstonePending: app.messageDeletions().get(ids.ownGlobal)?.pending,
      notice: root.querySelector('#notice').textContent,
    };
    app.clearRetry(outboxItem.clientMsgId);
    peerMember.capabilities = originalCapabilities;
    await app.attemptSend(outboxItem.clientMsgId);
    const recovered = {
      sends: sent.length,
      sentClientMsgId: sent[0]?.clientMsgId,
      countUnread: sent[0]?.countUnread,
      outboxRetainedUntilSync: app.outbox.get(outboxItem.clientMsgId) === outboxItem,
      pendingRetainedUntilSync: app.pending.get(outboxItem.clientMsgId) === pendingDelete,
      pendingStatus: pendingDelete.status,
      retryScheduled: app.retryTimers.has(outboxItem.clientMsgId),
      deferred: app.deferredCapabilityItems.has(outboxItem.clientMsgId),
      targetVisible: Boolean(root.querySelector(`.message[data-client-msg-id="${CSS.escape(ids.ownGlobal)}"]`)),
      tombstonePending: app.messageDeletions().get(ids.ownGlobal)?.pending,
    };
    app.clearRetry(outboxItem.clientMsgId);
    app.connectionState = 'disconnected';
    app.socket = null;
    return { blocked, recovered, expectedClientMsgId: outboxItem.clientMsgId };
  });
  assert.deepEqual(capabilityRetry.blocked, {
    sends: 0,
    sameOutboxItem: true,
    samePendingItem: true,
    pendingStatus: 'stored',
    retryScheduled: true,
    deferred: true,
    targetVisible: false,
    tombstonePending: true,
    notice: '删除操作已加密保存在本机待发；请先让所有已授权设备打开最新版，再为所有人删除消息',
  });
  assert.deepEqual(capabilityRetry.recovered, {
    sends: 1,
    sentClientMsgId: capabilityRetry.expectedClientMsgId,
    countUnread: false,
    outboxRetainedUntilSync: true,
    pendingRetainedUntilSync: true,
    pendingStatus: 'stored',
    retryScheduled: true,
    deferred: false,
    targetVisible: false,
    tombstonePending: true,
  });

  // Projection-only deletion must invalidate an already mounted reply quote,
  // even though the immutable reply payload itself stays cached.
  const cachedGlobalQuote = page.locator(`${messageSelector(fixture.ids.peerReplyGlobal)} .message-reply-quote`);
  assert.equal(await cachedGlobalQuote.locator('span').textContent(), '消息已删除', 'Cached reply preview retained deleted content');
  assert.equal(await cachedGlobalQuote.getAttribute('aria-label'), '被回复的消息已删除', 'Cached reply accessibility label retained deleted content');
  await cachedGlobalQuote.click();
  await page.waitForFunction(() => document.querySelector('#notice')?.textContent === '原消息已删除');
  assert.equal(await page.locator(messageSelector(fixture.ids.ownGlobal)).count(), 0);
  assert.equal(await page.locator('.message.is-highlighted').count(), 0, 'Deleted reply target was still jump-highlighted');
  assert.equal(await page.evaluate(() => window.messageDeletion.app.replyTarget), null);

  // Restore a deliberately old reading anchor whose target is present in the
  // first visible history page while its delete event sits beyond that page.
  // Record every production render: the target must be filtered before the
  // first paint, not removed by a later event-history pass.
  const anchoredRestore = await page.evaluate(async () => {
    const { QuietRoomApp } = await import('/src/app.ts');
    const vaultModule = await import('/src/lib/vault.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const capabilities = [
      'image-album-v1',
      'file-message-v1',
      'reply-v2',
      'voice-message-v1',
      'message-reactions-v1',
      'message-delete-v1',
    ];
    const [identity, linkedIdentity, peerIdentity] = await Promise.all([
      generateIdentity(),
      generateIdentity(),
      generateIdentity(),
    ]);
    const own = { ...identity.publicBundle, role: 'creator', status: 'active', capabilities: [...capabilities] };
    const linked = { ...linkedIdentity.publicBundle, role: 'creator', status: 'active', capabilities: [...capabilities] };
    const peer = { ...peerIdentity.publicBundle, role: 'joiner', status: 'active', capabilities: [...capabilities] };
    const targetId = crypto.randomUUID();
    const roomId = crypto.randomUUID();
    const sentAt = '2026-09-05T09:00:00.000Z';
    const session = await vaultModule.createVault({
      v: 1,
      roomId,
      accessToken: 'anchored-deletion-e2e-token',
      role: 'creator',
      protocol: 'legacy-v1',
      lastSeq: 103,
      members: [own, linked, peer],
      identity,
    }, 'anchored-deletion-e2e-password', 'password');
    const target = {
      seq: 1,
      clientMsgId: targetId,
      senderId: own.deviceId,
      status: 'delivered',
      acceptedAt: sentAt,
      payload: { v: 1, kind: 'text', text: '首屏绝不能闪现的较早消息', sentAt },
    };
    const records = [target];
    for (let seq = 2; seq <= 102; seq++) records.push({
      seq,
      clientMsgId: crypto.randomUUID(),
      senderId: seq % 2 ? own.deviceId : peer.deviceId,
      status: 'delivered',
      acceptedAt: sentAt,
      payload: { v: 1, kind: 'text', text: `锚点后的消息 ${seq}`, sentAt },
    });
    records.push({
      seq: 103,
      clientMsgId: crypto.randomUUID(),
      senderId: linked.deviceId,
      status: 'delivered',
      acceptedAt: sentAt,
      payload: {
        v: 1,
        kind: 'message-delete',
        sentAt,
        target: { clientMsgId: targetId, serverSeq: 1, senderId: own.deviceId },
      },
    });
    await vaultModule.withVaultMutation(session, async mutation => {
      for (const record of records) await vaultModule.saveHistoryMessage(session, record, mutation);
    });
    await vaultModule.saveUiPreferences(session, {
      chatAnchor: { clientMsgId: targetId, seq: 1, offset: 0, pinnedToBottom: false },
    });

    const root = document.createElement('div');
    root.id = 'anchor-app';
    document.body.append(root);
    const app = new QuietRoomApp(root);
    app.session = session;
    app.privacyCovered = false;
    app.updateBackgroundNotificationControl = async () => {};
    app.mountChatImageObserver = () => {};
    app.connectSocket = async () => {};
    app.unreadCounter.ensureConfigured = async () => false;
    app.unreadCounter.markRead = async () => {};
    const snapshots = [];
    const productionRenderMessages = app.renderMessages.bind(app);
    app.renderMessages = (...args) => {
      productionRenderMessages(...args);
      snapshots.push({
        targetVisible: Boolean(root.querySelector(`.message[data-client-msg-id="${CSS.escape(targetId)}"]`)),
        visibleRows: root.querySelectorAll('.message').length,
      });
    };
    await app.openSession();
    const restoredTarget = await vaultModule.loadHistoryMessage(session, 1);
    const result = {
      snapshots,
      targetVisibleAfterOpen: Boolean(root.querySelector(`.message[data-client-msg-id="${CSS.escape(targetId)}"]`)),
      eventLoadedBeforeReturn: [...app.messageEventHistory.values()].some(message => message.payload.kind === 'message-delete'
        && message.payload.target.clientMsgId === targetId),
      tombstoneLoadedBeforeReturn: app.messageDeletions().has(targetId),
      underlyingTargetRetained: restoredTarget?.clientMsgId === targetId,
    };
    app.lockNow();
    root.remove();
    return result;
  });
  assert(anchoredRestore.snapshots.length > 0, 'Anchored session never rendered its chat page');
  assert.equal(anchoredRestore.snapshots[0].targetVisible, false, 'Deleted anchor flashed in the first chat render');
  assert.equal(anchoredRestore.snapshots.every(snapshot => !snapshot.targetVisible), true, 'Deleted anchor appeared during a later render');
  assert.equal(anchoredRestore.snapshots[0].visibleRows > 0, true, 'First-render assertion observed an empty loading shell instead of chat rows');
  assert.deepEqual({
    targetVisibleAfterOpen: anchoredRestore.targetVisibleAfterOpen,
    eventLoadedBeforeReturn: anchoredRestore.eventLoadedBeforeReturn,
    tombstoneLoadedBeforeReturn: anchoredRestore.tombstoneLoadedBeforeReturn,
    underlyingTargetRetained: anchoredRestore.underlyingTargetRetained,
  }, {
    targetVisibleAfterOpen: false,
    eventLoadedBeforeReturn: true,
    tombstoneLoadedBeforeReturn: true,
    underlyingTargetRetained: true,
  });

  assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join('; ')}`);
  console.log('PASS chat deletion behavior: scopes, stale-action races, encrypted local projection, capability retry, ACK projection, anchored restore, and reply invalidation');

  const dangerMismatches = dangerSamples.filter(sample => sample.button !== sample.expected
    || sample.text !== sample.expected || sample.iconPaint !== sample.expected);
  assert.deepEqual(dangerMismatches, [], `Delete label/icon did not use --danger: ${JSON.stringify(dangerMismatches)}`);
  console.log('PASS chat deletion visual treatment: every destructive label and trash icon uses the danger color');
} finally {
  await browser?.close();
  await server.close();
}
