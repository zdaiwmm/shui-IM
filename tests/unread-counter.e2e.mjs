import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-unread-browser-'));
const api = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: {
  host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${api.port}` },
} });
server.middlewares.use('/__unread_regression', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="app"></main></body></html>');
});
const bundle = () => ({ deviceId: randomUUID(), encryptionKey: { kty: 'EC' }, signingKey: { kty: 'EC' } });
const own = bundle(), peer = bundle();
const accessToken = randomBytes(32).toString('base64url');
const room = api.store.createRoom(own, accessToken, randomBytes(32).toString('base64url'));
const state = api.store.joinRoom(room.roomId, peer, 'fixture-proof', randomBytes(32).toString('base64url'));
const insert = (senderId = peer.deviceId, countUnread = true) => api.store.insertMessage(room.roomId, {
  clientMsgId: randomUUID(), senderId, ciphertext: 'opaque-fixture-not-decrypted',
}, countUnread);
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().includes('/api/')) requests.push({ method: request.method(), url: request.url(), authorization: request.headers().authorization });
  });
  const url = `http://localhost:${server.httpServer.address().port}/__unread_regression`;
  await page.goto(url);
  const initializeApp = async () => page.evaluate(async () => {
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    await import('/src/chat-interactions.css');
    await import('/src/cover.css');
    const { QuietRoomApp } = await import('/src/app.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.mountChatImageObserver = () => {};
    app.mountGalleryThumbnails = () => {};
    window.unreadFixture = { app };
    await app.start();
  });
  await initializeApp();
  await page.evaluate(async ({ room, state, own, accessToken }) => {
    const { createVault } = await import('/src/lib/vault.ts');
    const { app } = window.unreadFixture;
    const session = await createVault({
      v: 1, roomId: room.roomId, accessToken, role: 'creator', protocol: 'legacy-v1', lastSeq: 0,
      createdAt: room.createdAt, members: state.members, pairingSecret: '', creatorFingerprint: '',
      identity: { publicBundle: own, signingPrivateKey: { secret: 'fixture-private-key' } },
    }, 'unread-fixture-passphrase', 'password');
    window.unreadFixture.session = session;
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch++;
    app.runtimeAbort = new AbortController();
    if (!await app.unreadCounter.ensureConfigured(session.vault, app.runtimeAbort.signal)) throw Error('Observer registration failed');
    app.renderChat();
    app.lockNow();
    await app.preferenceSaveChain;
    if (app.session !== null || JSON.stringify(app.unreadCounter).includes(accessToken)) throw Error('Lock retained a full device credential');
  }, { room, state, own, accessToken });
  const first = insert();
  insert(peer.deviceId, false); // Gallery.
  insert(peer.deviceId, false); // Reaction.
  insert(own.deviceId); // This participant's other activity.
  await page.evaluate(() => window.unreadFixture.app.unreadCounter.refresh());
  await page.waitForFunction(() => document.querySelector('#app .cover-unread')?.textContent === '1');
  const storedObserver = await page.evaluate(() => JSON.parse(localStorage.getItem('quiet-room-unread-v1')));
  assert.deepEqual(Object.keys(storedObserver).sort(), ['count', 'deviceId', 'roomId', 'token']);
  assert.notEqual(storedObserver.token, accessToken);
  assert.equal((await fetch(`http://127.0.0.1:${api.port}/api/rooms/${room.roomId}`, {
    headers: { Authorization: `Bearer ${storedObserver.token}` },
  })).status, 401);

  // Restore a decrypted fixture row into the genuine chat view; the viewport
  // observation and unread POST remain the application's real implementation.
  await page.evaluate(async ({ first, peer }) => {
    const { app, session } = window.unreadFixture;
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch++;
    app.runtimeAbort = new AbortController();
    session.vault.lastSeq = first.seq;
    if (!await app.unreadCounter.ensureConfigured(session.vault, app.runtimeAbort.signal)) throw Error('Observer reconfiguration failed');
    app.messages = new Map([[first.seq, {
      seq: first.seq, clientMsgId: first.envelope.clientMsgId, senderId: peer.deviceId,
      payload: { v: 1, kind: 'text', text: '已进入可见聊天的消息', sentAt: first.acceptedAt },
      acceptedAt: first.acceptedAt, status: 'delivered',
    }]]);
    app.uiPreferences = {};
    app.restoreChatAnchorOnNextRender = false;
    app.renderChat();
    app.renderMessages({ scroll: 'bottom' });
    app.markVisibleMessagesRead();
  }, { first, peer });
  await page.waitForFunction(() => window.unreadFixture.app.unreadCounter.count === 0);
  await page.evaluate(async () => {
    window.unreadFixture.app.lockNow();
    await window.unreadFixture.app.preferenceSaveChain;
  });
  insert();
  requests.length = 0;
  await page.reload();
  await initializeApp();
  await page.waitForFunction(() => document.querySelector('#app .cover-unread')?.textContent === '1');
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.method === 'GET' && request.url.includes('/unread/') && request.authorization === `Bearer ${storedObserver.token}`));
  assert.equal(await page.evaluate(() => window.unreadFixture.app.session), null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ countWithGalleryReactionAndOwnActivity: 1, visibleChatMarkRead: 0, reloadedCoverCount: 1, reloadUsesCountTokenOnly: true }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await api.close();
  await rm(dataDir, { recursive: true, force: true });
}
