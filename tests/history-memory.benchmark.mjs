// On-demand benchmark, outside the correctness gate. All records are synthetic.
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import path from 'node:path';

const baseline = '5bb99efe862794f1abfd9a86b9ff4acbb3371091';
const before = execFileSync('git', ['show', `${baseline}:src/lib/vault.ts`], { encoding: 'utf8' });
const virtual = path.resolve('src/lib/__baseline-vault.ts');
const server = await createServer({ root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error',
  plugins: [{ name: 'synthetic-history-baseline', enforce: 'pre',
    resolveId: id => id.endsWith('/__baseline-vault.ts') ? virtual : null,
    load: id => id === virtual ? before : null }],
  server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__history_benchmark', (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Synthetic history benchmark</title>'); });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' }), args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage();
  await page.goto(`http://localhost:${server.httpServer.address().port}/__history_benchmark`);
  await page.evaluate(async () => {
    const importer = new Function('path', 'return import(path)');
    const current = await importer('/src/lib/vault.ts'), previous = await importer('/src/lib/__baseline-vault.ts');
    const { toBase64Url } = await importer('/src/lib/base64.ts');
    const N = 50_000, roomId = crypto.randomUUID(), senderId = crypto.randomUUID();
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const session = { key, vault: { roomId, lastSeq: N, historyUnavailableBeforeSeq: 0 } };
    await current.loadHistoryPageAfter(session);
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('quiet-room'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const encoder = new TextEncoder(), sentAt = '2026-09-30T00:00:00Z';
    for (let start = 1; start <= N; start += 200) {
      const records = await Promise.all(Array.from({ length: Math.min(200, N - start + 1) }, async (_, i) => {
        const seq = start + i, iv = crypto.getRandomValues(new Uint8Array(12));
        const payload = seq % 100 === 0 ? { v: 1, kind: 'reaction', sentAt, target: { clientMsgId: '00000000-0000-4000-8000-000000000001', serverSeq: 1, senderId }, emoji: '❤️' }
          : { v: 1, kind: 'text', sentAt, text: 'x'.repeat(256) };
        const message = { seq, clientMsgId: crypto.randomUUID(), senderId, acceptedAt: sentAt, status: 'stored', payload };
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`quiet-room-history-v1:${roomId}:${seq}`) }, key, encoder.encode(JSON.stringify(message)));
        return { id: `${roomId}:${seq}`, roomId, seq, iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) };
      }));
      await new Promise((resolve, reject) => { const tx = db.transaction('history', 'readwrite'); for (const record of records) tx.objectStore('history').put(record); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    }
    db.close();
    window.benchmark = async implementation => {
      const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      const heapBefore = performance.memory.usedJSHeapSize;
      let peakHeap = heapBefore, decryptions = 0;
      Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: async (...args) => {
        const result = await decrypt(...args); decryptions++;
        if (decryptions % 100 === 0) peakHeap = Math.max(peakHeap, performance.memory.usedJSHeapSize);
        return result;
      } });
      const start = performance.now();
      try {
        const events = await (implementation === 'before' ? previous : current).loadMessageEventHistory(session);
        return { implementation, elapsedMs: performance.now() - start, decryptions, events: events.length, heapBefore,
          sampledPeakHeapBytes: peakHeap, sampledHeapGrowthBytes: peakHeap - heapBefore };
      } finally { Object.defineProperty(crypto.subtle, 'decrypt', { configurable: true, value: decrypt }); }
    };
  });
  const cdp = await page.context().newCDPSession(page);
  const runs = [];
  for (const implementation of ['before', 'after', 'after', 'before']) {
    await cdp.send('HeapProfiler.collectGarbage');
    runs.push(await page.evaluate(implementation => window.benchmark(implementation), implementation));
  }
  process.stdout.write(`${JSON.stringify({ baseline, rows: 50_000, textBytes: 256, projectionEvents: 500,
    browser: await browser.version(), runs, limitations: 'Same synthetic Chrome page, warm module/cache, two runs per implementation; sampled JS heap excludes native buffers, process RSS and physical iPhone. No latency guarantee.' }, null, 2)}\n`);
} finally { await browser?.close(); await server.close(); }
