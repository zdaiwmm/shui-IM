import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__upload', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>'); });
let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__upload`);
  await page.evaluate(async () => {
    for (const style of ['styles', 'chat-layout', 'chat-interactions', 'cover']) await import(`/src/${style}.css`);
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault, loadOutbox } = await import('/src/lib/vault.ts');
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#668eac'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#c9b281'; ctx.fillRect(25, 25, 100, 90);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const parts = [];
    const done = new Promise(resolve => { recorder.ondataavailable = e => parts.push(e.data); recorder.onstop = resolve; });
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 300)); recorder.stop(); await done;
    stream.getTracks().forEach(track => track.stop());
    // Padding gives three real encrypted chunks while retaining a decodable first frame.
    const file = new File([...parts, new Uint8Array(4 * 1024 * 1024)], '拍摄视频.webm', { type: 'video/webm', lastModified: 1 });
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities: ['file-message-v1'] };
    const peer = { ...own, deviceId: crypto.randomUUID(), role: 'joiner' };
    const session = await createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'upload-fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own, peer], identity: { publicBundle: own } }, 'upload-fixture-password', 'password');
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController();
    app.uiPreferencesHydrated = true; app.uiPreferences = { recoveryReminderDismissed: true };
    app.updateSafetyCode = async () => {}; app.unreadCounter.markRead = async () => {};
    app.connectionState = 'disconnected';
    app.retryOperation = operation => operation(); // One failed request per explicit test retry.
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const chunks = new Map();
    const gate = { release: null, requests: 0, fail: false, hold: true, completed: false };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (!url.pathname.includes('/blobs')) return realFetch(input, init);
      const match = url.pathname.match(/\/blobs\/([^/]+)\/chunks\/(\d+)$/);
      if (match && init.method === 'PUT') {
        gate.requests++;
        if (gate.hold) await new Promise(resolve => { gate.release = resolve; });
        init.signal?.throwIfAborted();
        if (gate.fail) throw Error('Synthetic upload failure');
        chunks.set(Number(match[2]), new Uint8Array(init.body));
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith('/complete')) { gate.completed = true; return Response.json({ ok: true }); }
      return Response.json({ uploadedIndexes: [...chunks.keys()], completed: gate.completed });
    };
    const sentAt = '2026-09-10T00:00:00.000Z';
    for (let seq = 1; seq <= 25; seq++) app.messages.set(seq, { seq, clientMsgId: `older-${seq}`, senderId: own.deviceId,
      status: 'stored', acceptedAt: sentAt, payload: { v: 1, kind: 'text', text: `较早的合成消息 ${seq}`, sentAt } });
    session.vault.lastSeq = 25;
    app.renderChat();
    const fixture = { app, session, file, gate, chunks, loadOutbox, run: null, start() { this.run = app.processImageBatch([file], 'chat'); } };
    window.uploadFixture = fixture; fixture.start();
  });
  const draft = page.locator('.video-upload');
  await draft.waitFor();
  await page.waitForFunction(() => window.uploadFixture.gate.release);
  assert.equal(await page.evaluate(async () => (await window.uploadFixture.loadOutbox(window.uploadFixture.session)).length), 0);
  await page.waitForFunction(() => document.querySelector('.video-upload')?.dataset.poster === 'ready');
  const id = await draft.getAttribute('data-client-msg-id');
  await page.evaluate(() => { window.uploadFixture.row = document.querySelector('.video-upload'); window.uploadFixture.app.renderMessages(); });
  assert.equal(await page.evaluate(() => document.querySelector('.video-upload') === window.uploadFixture.row), true);
  await page.evaluate(() => { const gate = window.uploadFixture.gate; gate.release(); gate.release = null; });
  await page.waitForFunction(() => window.uploadFixture.gate.requests === 2 && window.uploadFixture.gate.release);
  assert.match(await draft.innerText(), /正在上传 33%/);
  await page.waitForFunction(() => {
    const rect = document.querySelector('.video-upload').getBoundingClientRect();
    const composer = document.querySelector('#composer').getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= composer.top;
  });
  if (process.argv[2]) { await mkdir(process.argv[2], { recursive: true }); await page.screenshot({ path: `${process.argv[2]}/video-upload.png` }); }
  await page.evaluate(() => { const gate = window.uploadFixture.gate; gate.fail = true; gate.release(); });
  await page.waitForFunction(() => document.querySelector('.video-upload')?.dataset.uploadState === 'failed');
  assert.equal(await draft.getAttribute('data-client-msg-id'), id);
  await page.evaluate(() => { const gate = window.uploadFixture.gate; gate.fail = false; gate.hold = false; });
  await draft.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.video-upload').length === 0);
  const result = await page.evaluate(async id => {
    const f = window.uploadFixture;
    const outbox = await f.loadOutbox(f.session);
    if (outbox.length !== 1 || outbox[0].clientMsgId !== id) throw Error('Retry changed the ID or duplicated the durable message');
    const { decryptFileAttachment } = await import('/src/lib/file-crypto.ts');
    const restored = await decryptFileAttachment(outbox[0].payload.file, async (_id, index) => f.chunks.get(index).buffer);
    const hash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].join(',');
    if (await hash(restored) !== await hash(f.file)) throw Error('Upload changed original bytes');
    return { idStable: true, originalBytes: f.file.size, uploads: f.gate.requests };
  }, id);
  // A second upload must disappear immediately on lock, with no late resurrection.
  await page.evaluate(() => { const f = window.uploadFixture; f.chunks.clear(); f.gate.completed = false; f.gate.hold = true; f.gate.release = null; f.start(); });
  await page.waitForFunction(() => window.uploadFixture.gate.release);
  await page.evaluate(() => { const f = window.uploadFixture; f.app.lockNow(); f.gate.release(); });
  await page.evaluate(() => window.uploadFixture.run);
  assert.equal(await page.locator('.video-upload').count(), 0);
  assert.equal(await page.evaluate(() => window.uploadFixture.app.videoUploads.size), 0);
  assert.deepEqual(errors, []);
  console.log('Video upload:', { ...result, poster: true, progress: true, lockCleanup: true });
} finally { await browser?.close(); await server.close(); }
