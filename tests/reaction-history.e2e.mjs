import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__reaction_history', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Encrypted reaction history regression</title>');
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.httpServer.address().port}/__reaction_history`);
  const result = await page.evaluate(async () => {
    const importBrowser = new Function('path', 'return import(path)');
    const { loadHistoryPageAfter, loadReactionHistory } = await importBrowser('/src/lib/vault.ts');
    const { reduceMessageReactions } = await importBrowser('/src/lib/reactions.ts');
    const { toBase64Url } = await importBrowser('/src/lib/base64.ts');
    const roomId = crypto.randomUUID();
    const senderId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const sentAt = '2026-09-04T10:00:00.000Z';
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const session = { vault: { roomId }, key };
    const target = { seq: 1, senderId, clientMsgId: targetId, status: 'stored', acceptedAt: sentAt, payload: { v: 1, kind: 'text', text: 'old target', sentAt } };
    // Initialize the real production database schema before inserting fixtures.
    await loadHistoryPageAfter(session);
    const encoder = new TextEncoder();
    const records = await Promise.all(Array.from({ length: 450 }, async (_, index) => {
      const seq = index + 1;
      const payload = seq === 5 || seq === 405
        ? { v: 1, kind: 'reaction', sentAt, target: { clientMsgId: targetId, serverSeq: 1, senderId }, emoji: seq === 5 ? '❤️' : '👍' }
        : { v: 1, kind: 'text', text: `message ${seq}`, sentAt };
      const message = seq === 1 ? target : { seq, senderId, clientMsgId: crypto.randomUUID(), status: 'stored', acceptedAt: sentAt, payload };
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(`quiet-room-history-v1:${roomId}:${seq}`), tagLength: 128 },
        key,
        encoder.encode(JSON.stringify(message)),
      );
      return {
        id: `${roomId}:${seq}`, roomId, seq, iv: toBase64Url(iv),
        // A whole corrupt middle page must not hide the newer valid reaction.
        ciphertext: seq > 200 && seq <= 400 ? 'corrupt' : toBase64Url(ciphertext),
      };
    }));
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('quiet-room', 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('history', 'readwrite');
      for (const record of records) transaction.objectStore('history').put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    const corruptPage = await loadHistoryPageAfter(session, { afterSeq: 200 });
    const reactions = await loadReactionHistory(session);
    const badges = reduceMessageReactions([target, ...reactions], new Map([[senderId, 'creator']]));

    const controller = new AbortController();
    const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let decryptions = 0;
    let abortName;
    Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
      decryptions += 1;
      if (decryptions === 205) controller.abort();
      return originalDecrypt(...args);
    } });
    try { await loadReactionHistory(session, { signal: controller.signal }); }
    catch (error) { abortName = error.name; }
    finally { Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: originalDecrypt }); }
    return {
      corruptPageCount: corruptPage.length,
      reactionSequences: reactions.map((message) => message.seq),
      latestEmoji: badges.get(targetId)?.[0]?.emoji,
      abortName,
      decryptions,
    };
  });
  assert.deepEqual(result, {
    corruptPageCount: 0,
    reactionSequences: [5, 405],
    latestEmoji: '👍',
    abortName: 'AbortError',
    decryptions: 205,
  });
  console.log('PASS encrypted reaction history: pagination, corrupt-page recovery, and mid-scan cancellation');
  const restored = await page.evaluate(async () => {
    const importBrowser = new Function('path', 'return import(path)');
    await importBrowser('/src/styles.css');
    await importBrowser('/src/chat-layout.css');
    await importBrowser('/src/chat-interactions.css');
    await importBrowser('/src/cover.css');
    const { createVault, saveHistoryMessage, withVaultMutation } = await importBrowser('/src/lib/vault.ts');
    const { QuietRoomApp } = await importBrowser('/src/app.ts');
    const ownId = crypto.randomUUID();
    const peerId = crypto.randomUUID();
    const targetId = crypto.randomUUID();
    const sentAt = new Date().toISOString();
    const members = [{ deviceId: ownId, role: 'creator', status: 'active' }, { deviceId: peerId, role: 'joiner', status: 'active' }];
    const session = await createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'test', role: 'creator', protocol: 'legacy-v1', lastSeq: 401, members, identity: { publicBundle: members[0] } }, 'reaction-history-regression-password', 'password');
    const target = { seq: 1, senderId: peerId, clientMsgId: targetId, status: 'delivered', acceptedAt: sentAt, payload: { v: 1, kind: 'text', text: '最早的聊天消息', sentAt } };
    await withVaultMutation(session, async mutation => {
      await saveHistoryMessage(session, target, mutation);
      for (let seq = 2; seq <= 401; seq++) await saveHistoryMessage(session, {
        seq, clientMsgId: crypto.randomUUID(), senderId: ownId, status: 'stored', acceptedAt: sentAt,
        payload: { v: 1, kind: 'reaction', sentAt, target: { clientMsgId: targetId, serverSeq: 1, senderId: peerId }, emoji: seq === 401 ? '👍' : '❤️' },
      }, mutation);
    });
    const root = document.createElement('div'); root.id = 'app'; document.body.append(root);
    const app = new QuietRoomApp(root);
    app.session = session; app.privacyCovered = false;
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.connectSocket = async () => {};
    app.unreadCounter.configure = async () => {};
    await app.openSession();
    const result = {
      visibleTexts: [...root.querySelectorAll('.message-text')].map(element => element.textContent),
      badges: [...root.querySelectorAll('.message-reaction')].map(element => element.textContent),
      visibleRows: root.querySelectorAll('.message').length,
    };
    app.lockNow(); root.remove();
    return result;
  });
  assert.deepEqual(restored, { visibleTexts: ['最早的聊天消息'], badges: ['👍'], visibleRows: 1 });
  console.log('PASS session restore: 400 trailing reaction events still restore the earlier chat message and latest badge');
} finally {
  await browser?.close();
  await server.close();
}
