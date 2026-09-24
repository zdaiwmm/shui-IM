import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { staticPng, animatedPng } from './fixtures/photo-fixtures.mjs';
const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false } });
server.middlewares.use('/__cache', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="app"></div>'); });
await server.listen();
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium && !process.env.CI ? { channel: 'chrome' } : {});
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${server.httpServer.address().port}/__cache`);
      const fixture = await page.evaluate(async fixtures => {
        const v = await import('/src/lib/vault.ts'); const { QuietRoomApp } = await import('/src/app.ts');
        const { encryptImageFile } = await import('/src/lib/file-crypto.ts');
        const { createMediaPreview } = await import('/src/lib/media-preview.ts');
        const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active' };
        const session = await v.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'cache-fixture-password', 'password');
        const bytes = new Uint8Array(fixtures.png); const chunks = [];
        const manifest = await encryptImageFile(new File([bytes], 'sample.png', { type: 'image/png' }), {
          reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }), upload: async (_id, index, data) => { chunks[index] = Array.from(new Uint8Array(data)); }, complete: async () => {}, savePlan: async () => {},
        });
        const app = new QuietRoomApp(document.querySelector('#app')); app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
        let requests = 0;
        const originalFetch = fetch;
        window.fetch = (input, options) => String(input).includes('/chunks/') ? (requests++, Promise.resolve(new Response(new Uint8Array(chunks[0])))) : originalFetch(input, options);
        const opened = await app.loadImage(manifest, true);
        const preview = await v.loadMediaPreview(session, manifest);
        const raw = await v.loadCachedMediaChunk(session, manifest.blobId, 0, chunks[0].length);
        const animated = await createMediaPreview(new Blob([new Uint8Array(fixtures.animated)], { type: 'image/png' }));
        return { manifest, chunks, requests, hasPreview: !!preview, hasRaw: !!raw, originalBytes: Array.from(new Uint8Array(await opened.blob.arrayBuffer())), animatedPreserved: animated === null };
      }, { png: Array.from(staticPng), animated: Array.from(animatedPng) });
      assert.equal(fixture.requests, 1); assert.equal(fixture.hasPreview, true); assert.equal(fixture.hasRaw, false);
      assert.deepEqual(fixture.originalBytes, Array.from(staticPng)); assert.equal(fixture.animatedPreserved, true);
      // Reload discards every plaintext/key reference; unlock through the real vault path.
      await page.reload();
      const result = await page.evaluate(async fixture => {
        const v = await import('/src/lib/vault.ts'); const { QuietRoomApp } = await import('/src/app.ts');
        const session = await v.unlockVault('cache-fixture-password');
        const app = new QuietRoomApp(document.querySelector('#app')); app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
        let requests = 0; const originalFetch = fetch;
        window.fetch = (input, options) => String(input).includes('/chunks/') ? (requests++, Promise.resolve(new Response(new Uint8Array(fixture.chunks[0])))) : originalFetch(input, options);
        const cached = await app.loadImage(fixture.manifest, true); const displayRequests = requests;
        const previewOnly = cached.previewOnly;
        const original = await app.loadImage(fixture.manifest, false, true);
        const originalBytes = Array.from(new Uint8Array(await original.blob.arrayBuffer()));
        // Manifest AAD prevents a cached preview being shown for different original bytes.
        const wrong = await v.loadMediaPreview(session, { ...fixture.manifest, sha256: '0'.repeat(64) });
        const controller = new AbortController(); controller.abort();
        let aborted = false;
        try { await v.saveMediaPreview(session, fixture.manifest, new Blob(['x'], { type: 'image/png' }), controller.signal); } catch { aborted = true; }
        const afterAbort = await v.loadMediaPreview(session, fixture.manifest);
        // Under storage pressure, disposable data is skipped while the encrypted vault remains writable.
        Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ({ quota: 1024, usage: 1024 }) });
        await v.saveCachedMediaChunk(session, fixture.manifest.blobId, 0, new Uint8Array(fixture.chunks[0]).buffer);
        const quotaCached = await v.loadCachedMediaChunk(session, fixture.manifest.blobId, 0, fixture.chunks[0].length);
        await v.withVaultMutation(session, mutation => v.saveVault(session, mutation));
        return { displayRequests, originalRequests: requests, previewOnly, originalBytes, wrong: wrong === null, aborted, afterAbort: afterAbort === null, quotaCached: quotaCached === null };
      }, fixture);
      assert.deepEqual(result, { displayRequests: 0, originalRequests: 1, previewOnly: true, originalBytes: Array.from(staticPng), wrong: true, aborted: true, afterAbort: true, quotaCached: true });
      if (engine === chromium) {
        // Set the limit before any database write: Chromium may retain quota
        // reservations when the limit is lowered on an already active database.
        const pressureContext = await browser.newContext(); const pressurePage = await pressureContext.newPage();
        await pressurePage.goto(page.url());
        const cdp = await pressureContext.newCDPSession(pressurePage);
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(pressurePage.url()).origin, quotaSize: 2 * 1024 * 1024 });
        const pressure = await pressurePage.evaluate(async () => {
          const v = await import('/src/lib/vault.ts');
          const own = { deviceId: crypto.randomUUID(), role: 'creator', status: 'active' };
          const session = await v.createVault({ v: 1, roomId: crypto.randomUUID(), accessToken: 'fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'cache-fixture-password', 'password');
          Object.defineProperty(navigator.storage, 'estimate', { value: async () => ({ quota: 1024 ** 4, usage: 0 }) });
          const bytes = new Uint8Array(4 * 1024 * 1024);
          for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
          const seedId = crypto.randomUUID(), id = crypto.randomUUID();
          await v.saveCachedMediaChunk(session, seedId, 0, bytes.slice(0, 512 * 1024).buffer);
          const seedBefore = await v.loadCachedMediaChunk(session, seedId, 0, 512 * 1024);
          await v.saveCachedMediaChunk(session, id, 0, bytes.buffer);
          const rejected = await v.loadCachedMediaChunk(session, id, 0, bytes.length);
          const seedAfter = await v.loadCachedMediaChunk(session, seedId, 0, 512 * 1024);
          await v.withVaultMutation(session, mutation => v.saveVault(session, mutation));
          await v.saveCachedMediaChunk(session, id, 0, new Uint8Array(32).buffer);
          const cache = await v.loadCachedMediaChunk(session, id, 0, 32);
          return { seeded: Boolean(seedBefore), rejected: rejected === null, cleared: seedAfter === null, stopped: cache === null };
        });
        assert.deepEqual(pressure, { seeded: true, rejected: true, cleared: true, stopped: true }, 'real quota rejection frees cache and blocks refilling during the session');
        await pressureContext.close();
      }
      const migrationContext = await browser.newContext(); const migrationPage = await migrationContext.newPage();
      await migrationPage.goto(page.url());
      const migration = await migrationPage.evaluate(async () => {
        const roomId = crypto.randomUUID(), blobId = crypto.randomUUID(), blobKey = `${roomId}:${blobId}`;
        await new Promise((resolve, reject) => {
          const open = indexedDB.open('quiet-room', 10);
          open.onupgradeneeded = () => { const store = open.result.createObjectStore('mediaChunks', { keyPath: 'id' }); store.createIndex('roomId', 'roomId'); store.createIndex('blobKey', 'blobKey'); };
          open.onerror = () => reject(open.error);
          open.onsuccess = () => { const db = open.result, tx = db.transaction('mediaChunks', 'readwrite');
            for (let i = 0; i < 2; i++) tx.objectStore('mediaChunks').put({ id: `${blobKey}:${i}`, roomId, blobId, blobKey, index: i, cachedAt: i + 1, bytes: new Uint8Array(64).buffer });
            tx.oncomplete = () => { db.close(); resolve(); };
          };
        });
        const v = await import('/src/lib/vault.ts'); await v.readStoredVault();
        return new Promise((resolve, reject) => { const open = indexedDB.open('quiet-room'); open.onerror = () => reject(open.error);
          open.onsuccess = () => { const db = open.result; const get = db.transaction('mediaCacheEntries').objectStore('mediaCacheEntries').get(blobKey);
            get.onsuccess = () => { resolve({ bytes: get.result.bytes, usedAt: get.result.usedAt, version: db.version }); db.close(); }; };
        });
      });
      assert.deepEqual(migration, { bytes: 128, usedAt: 2, version: 11 }); await migrationContext.close();
      console.log(`PASS ${engine.name()}: encrypted preview survives reload, original export is exact, animation stays intact, AAD/abort/quota fail safely`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
