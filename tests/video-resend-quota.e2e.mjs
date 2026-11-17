import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const release = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8'));
  await writeFile(path.join(directory, 'static/sw.js'), `const RELEASE_ID = '${release.id}';\n`);
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
  await sender.evaluate(async () => {
    const oldReplyId = crypto.randomUUID(), currentReplyId = crypto.randomUUID();
    resendProbe.oldReplyId = oldReplyId; resendProbe.currentReplyId = currentReplyId;
    await auditApp.enqueuePayload({ v: 1, kind: 'text', text: 'old reply', sentAt: new Date().toISOString() }, oldReplyId);
    await auditApp.enqueuePayload({ v: 1, kind: 'text', text: 'current reply', sentAt: new Date().toISOString() }, currentReplyId);
  });
  await until(sender, () => [...auditApp.messages.values()].some(row => row.clientMsgId === resendProbe.currentReplyId));
  await sender.evaluate(() => { auditApp.replyTarget = [...auditApp.messages.values()].find(row => row.clientMsgId === resendProbe.oldReplyId); });
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
    if (!message.payload.videoPreview) throw Error('Initial send must exercise shared video preview');
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
  await sender.evaluate(() => {
    auditApp.replyTarget = [...auditApp.messages.values()].find(row => row.clientMsgId === resendProbe.currentReplyId);
    resendProbe.supports = auditApp.activeDevicesSupport.bind(auditApp);
    auditApp.activeDevicesSupport = capability => capability !== 'video-preview-v1' && resendProbe.supports(capability);
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
    return { id: item.sendId, confirmed: item.confirmedSendId, manifest: message?.payload.file, payload: message?.payload,
      plans: (await vault.loadUploadPlans(session)).length };
  });
  assert.notEqual(resent.id, evidence.first.messageId);
  assert.equal(resent.confirmed, resent.id, 'Explicit resend must confirm at a full room without a new reservation');
  assert.deepEqual(resent.manifest, await sender.evaluate(() => resendProbe.manifest));
  assert.equal(resent.payload.replyTo.clientMsgId, await sender.evaluate(() => resendProbe.currentReplyId));
  assert.notEqual(resent.payload.sentAt, await sender.evaluate(() => resendProbe.message.payload.sentAt));
  assert.equal(resent.payload.videoPreview, undefined, 'Resend respects current preview capability');
  assert.equal(resent.plans, 0);
  assert.equal(evidence.requests.slice(requestsBeforeResend).filter(row => row.method === 'POST').length, 0);
  await peer.waitForFunction(id => [...auditApp.messages.values()].some(row => row.clientMsgId === id), resent.id);
  const failed = await sender.evaluate(async () => {
    resendProbe.makeQuotaFailure = async () => {
      const { vault, id } = resendProbe, api = await import('/src/lib/api.ts');
      const { encryptFileAttachment } = await import('/src/lib/file-crypto.ts');
      const { compactMp4 } = await import('/src/lib/link-video.ts');
      const session = auditApp.session, signal = auditApp.runtimeAbort.signal;
      const pendingId = await vault.linkVideoSendId(session, id);
      const file = await compactMp4(await vault.readLinkVideo(session, id, signal), signal);
      let plan;
      try {
        await encryptFileAttachment(file, {
          reserve: (blob, count, bytes) => api.reserveBlob(session.vault.roomId, session.vault.accessToken, blob, count, bytes, signal),
          status: blob => api.getBlobStatus(session.vault.roomId, session.vault.accessToken, blob, signal),
          upload: async () => { throw Error('Quota must reject before chunks'); }, complete: async () => {},
          savePlan: async value => { plan = { ...value, clientMsgId: pendingId }; await vault.saveUploadPlan(session, plan); }, signal,
        });
        throw Error('Quota failure fixture must fail');
      } catch (error) { if (error.status !== 507) throw error; }
      return { id: pendingId, blob: plan.blobId, plans: (await vault.loadUploadPlans(session)).length,
        outbox: (await vault.loadOutbox(session)).length };
    };
    return resendProbe.makeQuotaFailure();
  });
  assert.notEqual(failed.id, resent.id);
  assert.equal(failed.plans, 1); assert.equal(failed.outbox, 0);
  assert.throws(() => service.store.blobStatus(evidence.fixture.roomId, failed.blob), /INVALID_BLOB/);
  const requestsBeforeRestart = evidence.requests.length;
  await sender.evaluate(async () => {
    const session = await resendProbe.vault.resumeVaultSession(auditApp.session);
    auditApp.session = session;
    await auditApp.openSession();
  });
  await until(sender, async () => {
    const item = (await resendProbe.vault.listLinkVideos(auditApp.session, auditApp.runtimeAbort.signal)).find(row => row.id === resendProbe.id);
    return item.confirmedSendId === item.sendId && !item.pendingSend;
  });
  const recovered = await sender.evaluate(async () => {
    const { vault, id } = resendProbe, session = auditApp.session;
    const item = (await vault.listLinkVideos(session, auditApp.runtimeAbort.signal)).find(row => row.id === id);
    const message = [...auditApp.messages.values()].find(row => row.clientMsgId === item.sendId);
    return { id: item.sendId, payload: message.payload, plans: (await vault.loadUploadPlans(session)).length };
  });
  assert.equal(recovered.id, failed.id, 'Restart keeps the already-authorized failed message ID');
  assert.deepEqual(recovered.payload.file, resent.manifest);
  assert.equal(recovered.payload.replyTo, undefined, 'No old reply leaks into a restart send');
  assert.equal(recovered.plans, 0, 'Abandoned current-ID plan retires after enqueue');
  assert.equal(evidence.requests.slice(requestsBeforeRestart).filter(row => row.method === 'POST').length, 0);
  await peer.waitForFunction(id => [...auditApp.messages.values()].some(row => row.clientMsgId === id), failed.id);
  const bytes = await peer.evaluate(async id => {
    const message = [...auditApp.messages.values()].find(row => row.clientMsgId === id);
    const { decryptFileAttachment } = await import('/src/lib/file-crypto.ts'), api = await import('/src/lib/api.ts');
    const session = auditApp.session;
    return (await decryptFileAttachment(message.payload.file, (blob, index) => api.fetchBlobChunk(session.vault.roomId, session.vault.accessToken, blob, index))).size;
  }, failed.id);
  assert.equal(bytes, evidence.fixture.size);
  const cases = await sender.evaluate(async () => {
    const { vault, id, manifest } = resendProbe, session = auditApp.session;
    const signal = auditApp.runtimeAbort.signal;
    const file = await (await import('/src/lib/link-video.ts')).compactMp4(await vault.readLinkVideo(session, id, signal), signal);
    const realFetch = window.fetch.bind(window), supports = auditApp.activeDevicesSupport.bind(auditApp);
    const results = [];
    for (const mode of ['changed', 'missing-source', 'missing-blob', 'incomplete', 'wrong-count', 'wrong-bytes', 'unauthorized', 'network', 'file-gate', 'dimensions', 'abort']) {
      let localId = id;
      if (mode === 'missing-source') {
        localId = crypto.randomUUID();
        await vault.storeLinkVideo(session, { id: localId, key: 'no-history-source', name: file.name,
          size: file.size, created: file.lastModified, duration: 1, shared: true }, file, signal);
      }
      const current = await vault.linkVideoSendId(session, localId), controller = new AbortController();
      let reservations = 0;
      window.fetch = async (input, init = {}) => {
        const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (pathname.endsWith('/blobs') && init.method === 'POST') reservations++;
        if (pathname.endsWith('/blobs/' + manifest.blobId) && !init.method) {
          if (mode === 'missing-blob') return Response.json({ error: 'INVALID_BLOB' }, { status: 404 });
          if (mode === 'incomplete') return Response.json({ uploadedIndexes: [], completed: false,
            chunkCount: manifest.chunkCount, expectedBytes: manifest.originalSize + 16 * manifest.chunkCount });
          if (mode === 'wrong-count' || mode === 'wrong-bytes') return Response.json({ uploadedIndexes: [0], completed: true,
            chunkCount: manifest.chunkCount + Number(mode === 'wrong-count'),
            expectedBytes: manifest.originalSize + 16 * manifest.chunkCount + Number(mode === 'wrong-bytes') });
          if (mode === 'unauthorized') return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
          if (mode === 'network') throw new TypeError('Synthetic connection loss');
          if (mode === 'abort') { controller.abort(); init.signal.throwIfAborted(); }
        }
        return realFetch(input, init);
      };
      auditApp.activeDevicesSupport = capability => !(mode === 'file-gate' && capability === 'file-message-v1')
        && !(mode === 'dimensions' && capability === 'media-dimensions-v1') && supports(capability);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mode === 'changed') bytes[bytes.length - 1] ^= 1;
      const selected = new File([bytes], file.name, { type: file.type, lastModified: file.lastModified + 1 });
      const accepted = await auditApp.processImageBatch([selected], 'chat', controller.signal, false, undefined, false, undefined, localId, undefined, current);
      const plans = await vault.loadUploadPlans(session);
      results.push({ mode, accepted, reservations, plans: plans.filter(plan => plan.clientMsgId === current).length,
        queued: (await vault.loadOutbox(session)).some(row => row.clientMsgId === current) });
      window.fetch = realFetch; auditApp.activeDevicesSupport = supports;
      await auditApp.cancelStagedVideoUpload(current);
      auditApp.mediaUploads.get(current)?.view.destroy(); auditApp.mediaUploads.delete(current);
    }
    const current = await vault.linkVideoSendId(session, id), other = crypto.randomUUID();
    const plan = { v: 2, blobId: manifest.blobId, key: manifest.key, ivPrefix: manifest.ivPrefix,
      chunkCount: manifest.chunkCount, encryptedSize: manifest.originalSize + 16 * manifest.chunkCount,
      originalSize: manifest.originalSize, originalName: manifest.originalName, mimeType: manifest.mimeType,
      lastModified: file.lastModified, plaintextSha256: manifest.sha256, clientMsgId: other };
    await vault.saveUploadPlan(session, plan); auditApp.uploadPlans.push(plan);
    const accepted = await auditApp.processImageBatch([new File([file], file.name, { type: file.type,
      lastModified: file.lastModified + 100 })], 'chat', signal, false, undefined, false, undefined, id, undefined, current);
    if (!accepted || !(await vault.loadUploadPlans(session)).some(row => row.clientMsgId === other)) throw Error('Reuse deleted another attempt plan or required an identical timestamp');
    await vault.deleteUploadPlan(session, plan.blobId); auditApp.uploadPlans = [];
    const loaded = new Map(auditApp.messages);
    auditApp.messages.clear();
    const paged = await auditApp.reusableLinkVideoManifest(file, current, id, signal);
    auditApp.messages = loaded;
    if (JSON.stringify(paged?.manifest) !== JSON.stringify(manifest)) throw Error('Encrypted paged source history was not reused');
    for (const committed of [false, true]) {
      const currentPlan = { ...plan, clientMsgId: current, ...(committed ? { transferIntent: {
        clientMsgId: current, transferId: crypto.randomUUID(), payload: { v: 1, kind: 'file', file: manifest, sentAt: new Date().toISOString() }, linkVideoId: id,
      } } : {}) };
      await vault.saveUploadPlan(session, currentPlan); auditApp.uploadPlans = [currentPlan];
      if (await auditApp.reusableLinkVideoManifest(file, current, id, signal)) throw Error('A committed current plan was replaced');
      if (JSON.stringify((await vault.loadUploadPlans(session))[0]) !== JSON.stringify(currentPlan)) throw Error('Committed intent was changed');
      await vault.deleteUploadPlan(session, currentPlan.blobId); auditApp.uploadPlans = [];
    }
    return results;
  });
  for (const result of cases) {
    assert.equal(result.accepted, false, result.mode);
    assert.equal(result.queued, false, result.mode);
    const fallback = ['changed', 'missing-source', 'missing-blob', 'incomplete', 'wrong-count', 'wrong-bytes', 'dimensions'].includes(result.mode);
    assert.equal(result.reservations > 0, fallback, result.mode + ': only an absent usable source falls back');
    assert.equal(result.plans, fallback ? 1 : 0, result.mode);
  }
  const commitRetry = await sender.evaluate(async () => {
    const failed = await resendProbe.makeQuotaFailure(), { vault, id } = resendProbe;
    const session = auditApp.session, signal = auditApp.runtimeAbort.signal;
    auditApp.uploadPlans = await vault.loadUploadPlans(session);
    const file = await (await import('/src/lib/link-video.ts')).compactMp4(await vault.readLinkVideo(session, id, signal), signal);
    const enqueue = auditApp.enqueuePayload.bind(auditApp);
    auditApp.enqueuePayload = async () => { throw Error('Synthetic durable enqueue failure'); };
    const accepted = await auditApp.processImageBatch([file], 'chat', signal, false, undefined, false, undefined, id, undefined, failed.id);
    auditApp.enqueuePayload = enqueue;
    const prepared = auditApp.mediaUploads.get(failed.id).prepared;
    if (accepted || prepared.manifests[0].blobId !== resendProbe.manifest.blobId
      || !(await vault.loadUploadPlans(session)).some(row => row.blobId === failed.blob)) throw Error('Failed enqueue retired the plan early');
    const find = auditApp.reusableLinkVideoManifest;
    auditApp.reusableLinkVideoManifest = async () => { throw Error('Prepared retry changed manifest'); };
    const retried = await auditApp.processImageBatch([file], 'chat', signal, false, failed.id);
    auditApp.reusableLinkVideoManifest = find;
    if (!retried || (await vault.loadUploadPlans(session)).length) throw Error('Prepared retry did not retire the abandoned plan after enqueue');
    return { id: failed.id, payload: prepared.payload };
  });
  await until(sender, () => !auditApp.outbox.size && !auditApp.serverQueue.size);
  const confirmedRetry = await sender.evaluate(id => [...auditApp.messages.values()].find(row => row.clientMsgId === id).payload, commitRetry.id);
  assert.deepEqual(confirmedRetry, commitRetry.payload, 'Prepared retry preserves the exact pending payload');
  console.log('Resend safeguards passed', cases.map(row => row.mode));
  console.log('Real quota resend passed', { first: evidence.first.messageId, resend: resent.id, blob: resent.manifest.blobId });
} finally {
  await browser?.close(); await vite?.close(); await service?.close();
  await rm(directory, { recursive: true, force: true });
}
