import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'cipher-worker-policy-'));
const policyServer = await startServer({ port: 0, dataDir, staticDir: path.resolve('public'), quiet: true });
let workerPolicy;
try {
  workerPolicy = (await fetch(`http://127.0.0.1:${policyServer.port}/sw.js`)).headers.get('content-security-policy');
} finally {
  await policyServer.close();
  await rm(dataDir, { recursive: true, force: true });
}

// The pre-transfer controller installs and claims pages, but ignores the new
// transport protocol. Keep the fixture independent of shallow Git history.
const legacyWorker = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));`;
const currentWorker = (await readFile('public/sw.js', 'utf8')).replaceAll('__QUIET_ROOM_RELEASE_ID__', 'upgrade-current');
let upgraded = false;
const uploaded = [];
const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
server.middlewares.use((request, response, next) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/__cipher-worker.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', workerPolicy);
    response.end(upgraded ? currentWorker : legacyWorker);
    return;
  }
  if (url.pathname === '/__cipher_upgrade' || url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Isolated worker upgrade fixture</title>');
    return;
  }
  if (!url.pathname.startsWith('/api/rooms/')) { next(); return; }
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'PUT') {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { uploaded.push(Buffer.concat(chunks)); response.end('{}'); });
    return;
  }
  if (request.method === 'GET') {
    response.end(JSON.stringify({ uploadedIndexes: [], chunkCount: 1, expectedBytes: 17 }));
  } else {
    response.end(JSON.stringify({ token: 'A'.repeat(43), expiresAt: Date.now() + 3600_000 }));
  }
});

let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await engine.launch();
    for (const cancelled of [false, true]) {
      upgraded = false; uploaded.length = 0;
      const page = await browser.newPage({ serviceWorkers: 'allow' });
      await page.goto(`${origin}/__cipher_upgrade`);
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/__cipher-worker.js', { scope: '/', updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        const transfers = await import('/src/lib/cipher-transfer.ts');
        const signal = new AbortController();
        const task = await transfers.prepareCipherTransfer({
          roomId: crypto.randomUUID(), deviceId: crypto.randomUUID(), accessToken: 'isolated-fixture', direction: 'upload', signal: signal.signal,
          manifest: { blobId: crypto.randomUUID(), originalSize: 1, chunkSize: 2097152, chunkCount: 1 },
        });
        await transfers.stageCipherPart(task, 0, new Uint8Array(17).fill(7).buffer);
        const oldController = navigator.serviceWorker.controller;
        const post = oldController.postMessage.bind(oldController);
        const messages = [];
        oldController.postMessage = (...args) => { messages.push(args[0]); post(...args); };
        window.upgradeFixture = { oldController, messages, signal, task, transfers };
        window.upgradeFixture.result = transfers.runCipherTransfer(task, signal.signal)
          .then(() => ({ outcome: 'done' }), error => ({ outcome: 'error', name: error.name, message: error.message }));
      });
      await page.waitForFunction(() => window.upgradeFixture.messages.length > 0);
      if (cancelled) await page.evaluate(async () => {
        const fixture = window.upgradeFixture;
        fixture.signal.abort(new DOMException('Explicitly cancelled during upgrade', 'AbortError'));
        await fixture.transfers.cancelCipherTransfer(fixture.task.id);
      });
      upgraded = true;
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
      await page.waitForFunction(() => navigator.serviceWorker.controller !== window.upgradeFixture.oldController);
      const result = await page.evaluate(() => window.upgradeFixture.result);
      console.log(name, cancelled ? 'cancelled upgrade' : 'active upgrade', JSON.stringify(result));
      if (cancelled) {
        assert.equal(result.name, 'AbortError');
        const state = await page.evaluate(async () => {
          const fixture = window.upgradeFixture;
          return (await fixture.transfers.readCipherTransfer(fixture.task.id)).state;
        });
        assert.equal(state, 'cancelled', 'A late controller must not resurrect the cancelled task');
        assert.equal(uploaded.length, 0, 'Cancellation during readiness must not dispatch ciphertext');
      } else {
        assert.equal(result.outcome, 'done', 'A task started under the old worker must continue after the new worker takes control');
        assert.equal(uploaded.length, 1, 'The original encrypted chunk is uploaded once');
        assert.deepEqual(uploaded[0], Buffer.alloc(17, 7));
        if (name === 'chromium') {
          let videoRequests = 0, rejectedRequests = 0;
          await page.context().route('https://video.twimg.com/worker-fixture.mp4', route => {
            videoRequests++;
            return route.fulfill({ body: 'isolated-video-source', headers: { 'Access-Control-Allow-Origin': '*' } });
          });
          await page.context().route('https://untrusted.invalid/**', route => {
            rejectedRequests++;
            return route.fulfill({ body: 'unexpected', headers: { 'Access-Control-Allow-Origin': '*' } });
          });
          const worker = page.context().serviceWorkers()[0];
          const policyResult = await worker.evaluate(async () => {
            const source = await (await fetch('https://video.twimg.com/worker-fixture.mp4', { credentials: 'omit' })).text();
            let rejected = false;
            try { await fetch('https://untrusted.invalid/video.mp4', { credentials: 'omit' }); }
            catch { rejected = true; }
            return { source, rejected };
          });
          assert.deepEqual(policyResult, { source: 'isolated-video-source', rejected: true });
          assert.equal(videoRequests, 1, 'The real worker policy admits the existing video source');
          assert.equal(rejectedRequests, 0, 'The worker policy still blocks other external origins');
        }
      }
      await page.close();
    }
    await browser.close(); browser = undefined;
  }
} finally {
  await browser?.close();
  await server.close();
}
