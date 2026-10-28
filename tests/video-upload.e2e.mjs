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
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__upload`);
  await page.evaluate(async () => {
    await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault, loadOutbox } = await import('/src/lib/vault.ts');
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#668eac'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#c9b281'; ctx.fillRect(25, 25, 100, 90);
    const stream = canvas.captureStream(10);
    const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw Error('This browser cannot generate the video regression fixture');
    const recorder = new MediaRecorder(stream, { mimeType });
    const parts = [];
    const done = new Promise(resolve => { recorder.ondataavailable = e => parts.push(e.data); recorder.onstop = resolve; });
    recorder.start();
    // Reuse video-flow's bounded continuous-frame fixture, rather than relying
    // on a single static frame or the recorder's unspecified default codec.
    for (let frame = 0; frame < 30; frame++) {
      ctx.fillStyle = '#668eac'; ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = '#c9b281'; ctx.fillRect(25 + frame, 25, 100, 90);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    recorder.stop(); await done;
    stream.getTracks().forEach(track => track.stop());
    // Padding gives three real encrypted chunks while retaining a decodable first frame.
    const file = new File([...parts, new Uint8Array(4 * 1024 * 1024)], '拍摄视频.webm', { type: 'video/webm', lastModified: 1 });
    const fixtureUrl = URL.createObjectURL(file);
    try {
      const poster = await (await import('/src/lib/video-poster.ts')).createVideoPoster(fixtureUrl);
      if (poster.width !== 320 || poster.height !== 180) throw Error('Video fixture has no expected decodable frame');
    } finally { URL.revokeObjectURL(fixtureUrl); }
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active', capabilities: ['file-message-v1'] };
    const peer = { ...own, deviceId: crypto.randomUUID(), role: 'joiner' };
    const session = await createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'upload-fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own, peer], identity: { publicBundle: own } }, 'upload-fixture-password', 'password');
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController();
    app.uiPreferencesHydrated = true; app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
    app.updateSafetyCode = async () => {}; app.unreadCounter.markRead = async () => {};
    app.connectionState = 'disconnected';
    app.retryOperation = operation => operation(); // One failed request per explicit test retry.
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    const chunks = new Map();
    const gate = { release: null, requests: 0, fail: false, hold: true, completed: false, failDownload: false, holdDownload: false, downloadRelease: null };
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
      if (match) {
        if (gate.failDownload) throw Error('Synthetic video download failure');
        if (gate.holdDownload) await new Promise(resolve => { gate.downloadRelease = resolve; });
        return new Response(chunks.get(Number(match[2])));
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
  const uploadBox = await draft.locator('.message-bubble').boundingBox();
  await page.evaluate(() => {
    const f=window.uploadFixture; f.row = document.querySelector('.video-upload');
    f.shell=f.row.querySelector('.message-bubble');f.status=f.row.querySelector('.media-send-status');
    f.app.renderMessages();
  });
  assert.equal(await page.evaluate(() => document.querySelector('.video-upload') === window.uploadFixture.row), true);
  await page.evaluate(() => { const gate = window.uploadFixture.gate; gate.release(); gate.release = null; });
  await page.waitForFunction(() => window.uploadFixture.gate.requests === 2 && window.uploadFixture.gate.release);
  await draft.locator('.media-upload-status > .media-capsule-content').filter({hasText:/33%[\s\S]*上传中/}).waitFor();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.video-upload .media-send-status')).opacity==='1');
  assert.match(await draft.innerText(), /33%[\s\S]*上传中/);
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
  const message = page.locator(`.message[data-client-msg-id="${id}"]`);
  await message.locator('.image-preview[data-image-state="loaded"]').waitFor();
  const loadedBox = await message.locator('.message-bubble').boundingBox();
  assert.deepEqual(await message.evaluate(node=>({row:node===window.uploadFixture.row,
    shell:node.querySelector('.message-bubble')===window.uploadFixture.shell,
    status:node.querySelector('.media-send-status')===window.uploadFixture.status})),{row:true,shell:true,status:true});
  assert.equal(await message.locator('.message-meta > .media-capsule-content > time').isVisible(),false,'Uploaded video has no time before server confirmation');
  assert.ok(Math.abs(uploadBox.width - loadedBox.width) < 1 && Math.abs(uploadBox.height - loadedBox.height) < 1, `Video upload and final bubble share geometry: ${JSON.stringify(uploadBox)} -> ${JSON.stringify(loadedBox)}`);
  await page.waitForFunction(id => !document.querySelector(`[data-client-msg-id="${id}"] .media-upload-handoff`), id);
  await message.dispatchEvent('contextmenu');
  const lifted = page.locator('.message-action-preview .image-preview');
  await lifted.waitFor();
  const liftedBox = await lifted.boundingBox();
  assert.ok(Math.abs(loadedBox.width - liftedBox.width) < 1 && Math.abs(loadedBox.height - liftedBox.height) < 1, 'Long press keeps the full video height');
  assert.equal(await lifted.evaluate(node => { const s = getComputedStyle(node); return new Set([s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius]).size; }), 1);
  await page.evaluate(() => window.uploadFixture.app.closeMessageActions(false, false));
  await page.evaluate(id=>{const f=window.uploadFixture;f.app.pending.get(id).status='stored';f.app.renderMessages();},id);
  assert.equal(await message.locator('.message-meta > .media-capsule-content > time').isVisible(),true,'Video time appears only when the server has saved the message');
  // Retry restores feedback after the failure removed the original ring.
  await page.evaluate(async id => {
    const f = window.uploadFixture, manifest = f.app.pending.get(id).payload.file;
    const cached = f.app.imageCache.get(manifest.blobId);
    for (const key of ['url','posterUrl','concealedUrl']) if (cached[key]) URL.revokeObjectURL(cached[key]);
    // A cold receiver has neither the sender's URL nor its encrypted poster.
    await (await import('/src/lib/vault.ts')).deleteCachedMediaBlob(f.session, manifest.blobId);
    f.app.imageCache.delete(manifest.blobId); f.app.renderedMessages.delete(id);
    f.gate.failDownload = true; f.app.renderMessages();
    void f.app.hydrateImagePreview(document.querySelector(`[data-client-msg-id="${id}"] .image-preview`), manifest);
  }, id);
  const retryPreview = message.locator('.image-preview');
  await page.waitForFunction(id => document.querySelector(`[data-client-msg-id="${id}"] .image-preview`)?.dataset.imageState === 'error', id);
  await page.evaluate(() => { const g = window.uploadFixture.gate; g.failDownload = false; g.holdDownload = true; });
  await retryPreview.scrollIntoViewIfNeeded();
  await retryPreview.click();
  await page.waitForFunction(() => window.uploadFixture.gate.downloadRelease);
  await retryPreview.locator('.media-load-capsule > .media-capsule-content > .media-load-progress').waitFor();
  await retryPreview.locator('.is-error').waitFor({state:'detached'});
  assert.equal(await retryPreview.locator('.media-load-capsule > .media-capsule-content > .media-load-progress').count(), 1);
  assert.equal(await retryPreview.locator('.is-error').count(), 0);
  await page.evaluate(() => { const g = window.uploadFixture.gate; g.holdDownload = false; g.downloadRelease(); });
  await page.waitForFunction(id => document.querySelector(`[data-client-msg-id="${id}"] .image-preview`)?.dataset.imageState === 'loaded', id);
  assert.equal(await retryPreview.getAttribute('aria-busy'), 'false');
  assert.equal(await retryPreview.getAttribute('data-revealed'), 'false');
  assert.equal(await retryPreview.locator('.media-ready-hint').count(), 0);
  // A second upload must disappear immediately on lock, with no late resurrection.
  await page.evaluate(() => { const f = window.uploadFixture; f.chunks.clear(); f.gate.completed = false; f.gate.hold = true; f.gate.release = null; f.start(); });
  await page.waitForFunction(() => window.uploadFixture.gate.release);
  await page.evaluate(() => { const f = window.uploadFixture; f.app.lockNow(); f.gate.release(); });
  await page.evaluate(() => window.uploadFixture.run);
  assert.equal(await page.locator('.video-upload').count(), 0);
  assert.equal(await page.evaluate(() => window.uploadFixture.app.mediaUploads.size), 0);
  assert.deepEqual(errors, []);
  console.log('Video upload:', { ...result, poster: true, progress: true, lockCleanup: true });
} finally { await browser?.close(); await server.close(); }
