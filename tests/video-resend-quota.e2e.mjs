import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'qr-resend-quota-'));
const roomLimit = 2 * 1024 ** 2;
let service, vite, browser;
const evidence = { roomLimit, requests: [] };
async function until(page, predicate) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await delay(100);
  }
  throw Error('Timed out waiting for authenticated durable send');
}
try {
  await mkdir(path.join(directory, 'static'));
  await writeFile(path.join(directory, 'static/sw.js'), "const RELEASE_ID = '2026.11.17.4';\n");
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(directory, 'data'),
    staticDir: path.join(directory, 'static'), maxRoomStorageBytes: roomLimit,
    maxTotalStorageBytes: 32 * 1024 ** 2, quiet: true });
  vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error',
    cacheDir: path.join(directory, 'vite'), plugins: [{ name: 'observe-app', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/main.ts')) {
        assert.equal(code.split('void app.start();').length, 2);
        return code.replace('void app.start();', 'window.auditApp=app;void app.start();');
      }
    } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': `http://127.0.0.1:${service.port}`, '/ws': { target: `ws://127.0.0.1:${service.port}`, ws: true },
    } } });
  await vite.listen();
  const engine = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  evidence.engine = engine;
  browser = await (engine === 'webkit' ? webkit : chromium).launch(engine === 'webkit' || process.env.CI ? {} : { channel: 'chrome' });
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function pageFor() {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    await context.addInitScript(() => {
      localStorage.setItem('quiet-room:auto-lock-seconds', '0');
      localStorage.setItem('quiet-room:lock-on-hidden', '0');
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.auditClipboard = text; }, readText: async () => window.auditClipboard ?? '',
      } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on('response', response => {
      const request = response.request();
      if (!new URL(response.url()).pathname.includes('/blobs')) return;
      evidence.requests.push({ method: request.method(), path: new URL(response.url()).pathname,
        status: response.status(), faultId: response.headers()['x-fault-id'] ?? null });
    });
    return page;
  }
  const ready = page => page.waitForFunction(() => auditApp?.connectionState === 'connected'
    && auditApp.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input')?.disabled === false,
  undefined, { timeout: 45_000 });
  const sender = await pageFor(), peer = await pageFor();
  await sender.goto(origin);
  await sender.locator('#create-room').click();
  await sender.locator('#copy-invite').click();
  await sender.waitForFunction(() => window.auditClipboard?.includes('#j='));
  await peer.goto(await sender.evaluate(() => auditClipboard));
  await ready(peer); await ready(sender);

  evidence.fixture = await sender.evaluate(async () => {
    const vault = await import('/src/lib/vault.ts');
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
    const drawing = canvas.getContext('2d');
    const stream = canvas.captureStream(5);
    if (!MediaRecorder.isTypeSupported('video/mp4')) throw Error('Browser cannot produce genuine MP4 fixture');
    const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' }), parts = [];
    recorder.ondataavailable = event => parts.push(event.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    for (const color of ['red', 'green', 'blue']) {
      drawing.fillStyle = color; drawing.fillRect(0, 0, 96, 64);
      await new Promise(resolve => setTimeout(resolve, 220));
    }
    recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
    const file = new File(parts, 'local-resend.mp4', { type: 'video/mp4', lastModified: 1234 });
    const url = URL.createObjectURL(file);
    const poster = await (await import('/src/lib/video-poster.ts')).createVideoPoster(url);
    URL.revokeObjectURL(url);
    if (poster.width !== 96 || poster.height !== 64) throw Error('Fixture MP4 must genuinely decode');
    const id = crypto.randomUUID();
    const item = await vault.storeLinkVideo(auditApp.session, { id, key: 'synthetic-local-mp4', name: file.name,
      size: file.size, created: file.lastModified, duration: 1 }, file, auditApp.runtimeAbort.signal);
    window.resendProbe = { vault, id, original: file, firstSend: id, roomId: auditApp.session.vault.roomId,
      deviceId: auditApp.session.vault.identity.publicBundle.deviceId };
    auditApp.openVideoDownloads(item);
    return { size: file.size, width: poster.width, height: poster.height, roomId: resendProbe.roomId, deviceId: resendProbe.deviceId };
  });
  const sheet = sender.locator('.link-video-sheet');
  await sheet.getByRole('button', { name: '更多操作', exact: true }).click();
  await sheet.getByRole('button', { name: '发送至聊天', exact: true }).click();
  await until(sender, async () => {
    const { vault, id } = resendProbe, session = auditApp.session;
    const item = (await vault.listLinkVideos(session, auditApp.runtimeAbort.signal)).find(row => row.id === id);
    return item?.confirmedSendId === id && !auditApp.outbox.size && !auditApp.serverQueue.size;
  });
  evidence.first = await sender.evaluate(async () => {
    const { vault, id } = resendProbe, session = auditApp.session;
    const message = [...auditApp.messages.values()].find(row => row.clientMsgId === id);
    if (!message || message.payload.kind !== 'file') throw Error('First send must be authenticated own history');
    resendProbe.message = message; resendProbe.manifest = message.payload.file;
    return { messageId: id, blobId: message.payload.file.blobId, seq: message.seq,
      outbox: (await vault.loadOutbox(session)).length, plans: (await vault.loadUploadPlans(session)).length,
      shared: (await vault.listLinkVideos(session, auditApp.runtimeAbort.signal)).find(row => row.id === id).shared };
  });
  assert.equal(evidence.first.plans, 0);
  const originalStatus = service.store.blobStatus(evidence.fixture.roomId, evidence.first.blobId);
  assert.equal(originalStatus.completed, true);
  const fillerId = crypto.randomUUID();
  const remaining = Math.floor(originalStatus.expectedBytes / 2);
  service.store.createBlob(evidence.fixture.roomId, fillerId, 1,
    roomLimit - originalStatus.expectedBytes - remaining, evidence.fixture.deviceId);
  evidence.budget = { originalCiphertextBytes: originalStatus.expectedBytes, freeBytes: remaining,
    fillerReservationBytes: roomLimit - originalStatus.expectedBytes - remaining };
  await sheet.getByRole('button', { name: '返回聊天', exact: true }).click();
  await sender.evaluate(async () => {
    const item = (await resendProbe.vault.listLinkVideos(auditApp.session, auditApp.runtimeAbort.signal)).find(row => row.id === resendProbe.id);
    auditApp.openVideoDownloads(item);
  });
  const requestsBeforeResend = evidence.requests.length;
  await sheet.getByRole('button', { name: '更多操作', exact: true }).click();
  await sheet.getByRole('button', { name: '发送至聊天', exact: true }).click();
  await until(sender, async () => {
    const { vault, id } = resendProbe, session = auditApp.session;
    const item = (await vault.listLinkVideos(session, auditApp.runtimeAbort.signal)).find(row => row.id === id);
    return item?.confirmedSendId === item?.sendId && item?.sendId !== id
      || document.querySelector('.link-video-sheet')?.innerText.includes('发送失败，可从本机重试');
  });
  const resent = await sender.evaluate(async () => {
    const { vault, id } = resendProbe, session = auditApp.session;
    const item = (await vault.listLinkVideos(session, auditApp.runtimeAbort.signal)).find(row => row.id === id);
    const message = [...auditApp.messages.values()].find(row => row.clientMsgId === item.sendId);
    return { id: item.sendId, confirmed: item.confirmedSendId, manifest: message?.payload.file,
      plans: (await vault.loadUploadPlans(session)).length };
  });
  assert.notEqual(resent.id, evidence.first.messageId);
  assert.equal(resent.confirmed, resent.id, 'Explicit resend must confirm at a full room without a new reservation');
  assert.deepEqual(resent.manifest, await sender.evaluate(() => resendProbe.manifest));
  assert.equal(resent.plans, 0);
  assert.equal(evidence.requests.slice(requestsBeforeResend).filter(row => row.method === 'POST').length, 0);
  await peer.waitForFunction(id => [...auditApp.messages.values()].some(row => row.clientMsgId === id), resent.id);
  console.log('Real quota resend passed', { first: evidence.first.messageId, resend: resent.id, blob: resent.manifest.blobId });
} finally {
  await browser?.close(); await vite?.close(); await service?.close();
  await rm(directory, { recursive: true, force: true });
}
