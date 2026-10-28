import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const message = '密室数量已达上限，如需更多请联系客服';
const dataDir = await mkdtemp(path.join(tmpdir(), 'room-creation-limit-'));
let backend, vite;
try {
  backend = await startServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true });
  vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error', plugins: [{
    name: 'creation-limit-observer',
    transform(code, id) { if (id.endsWith('/src/main.ts')) return code.replace('void app.start();', 'window.app=app;void app.start();'); },
    configureServer(server) { server.middlewares.use('/__capacity', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Capacity storage regression</title>'); }); },
  }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
    '/api': `http://127.0.0.1:${backend.port}`, '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
  } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch(name === 'chromium' && !process.env.CI ? { channel: 'chrome' } : {});
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedLink = text; } } }));
      const page = await context.newPage();
      let posts = 0;
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms') posts++; });
      await page.goto(origin);
      const roomId = () => page.evaluate(() => window.app.session?.vault.roomId);
      const openList = async () => {
        await page.locator('#chat-settings').click();
        await page.locator('#chamber-switch-space').click();
        await page.locator('.is-space-list-page:not(.space-sidebar) #space-create').waitFor();
      };
      const createFromList = async () => {
        const before = await roomId();
        await page.locator('.is-space-list-page:not(.space-sidebar) #space-create').click();
        await page.waitForFunction(previous => window.app.session?.vault.roomId && window.app.session.vault.roomId !== previous && document.querySelector('#copy-invite'), before);
        await page.waitForFunction(() => !window.app.spaceCreationAbort);
      };
      await page.locator('#create-room').click();
      await page.locator('#copy-invite').waitFor();
      const first = await roomId();
      for (let i = 0; i < 2; i++) { await openList(); await createFromList(); }
      assert.equal(posts, 3, 'Three actual creations must succeed');
      const current = await roomId();
      await openList();
      const list = page.locator('.is-space-list-page:not(.space-sidebar)');
      await list.evaluate(node => { window.capacityList = node; });
      await list.locator('#space-create').click();
      await page.locator('#app-toast').filter({ hasText: message }).waitFor();
      assert.equal(await roomId(), current);
      assert.equal(await list.evaluate(node => node === window.capacityList), true, 'Rejected creation retains the current list');
      assert.equal(posts, 3, 'Rejected creation must not contact the room-creation endpoint');

      const source = await browser.newPage();
      await source.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedLink = text; } } }));
      await source.goto(origin); await source.locator('#create-room').click(); await source.locator('#copy-invite').click();
      await source.waitForFunction(() => !!window.copiedLink);
      await page.goto(await source.evaluate(() => window.copiedLink));
      await page.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
      assert.equal(await page.evaluate(() => window.app.session.vault.role), 'joiner', 'Joining remains available at the creation limit');
      await page.locator('#chat-settings').click(); await page.locator('#archive-settings').click();
      const intro = await page.locator('.archive-page:not(.local-page-outgoing) .backup-intro').innerText();
      assert.equal(intro, '凭证密码仅用于本浏览器加密，不上传服务器。');
      await page.reload(); await page.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
      await openList(); await list.locator('#space-create').click();
      await page.locator('#app-toast').filter({ hasText: message }).waitFor();
      assert.equal(posts, 3, 'Reload preserves the creation limit and joined rooms add no creation requests');

      await page.evaluate(async removed => {
        const { changeOwnSpace } = await import('/src/lib/own-space-directory.ts');
        await changeOwnSpace(window.app.session, { roomId: removed, name: 'removed room' }, true);
      }, first);
      await createFromList();
      assert.equal(posts, 4, 'List removal releases one creation place without deleting retained history');
      const returnRoom = await roomId();
      await page.evaluate(async removed => {
        const { changeOwnSpace } = await import('/src/lib/own-space-directory.ts');
        await changeOwnSpace(window.app.session, { roomId: removed, name: 'removed third room' }, true);
        const before = window.app.handleCreate.bind(window.app);
        const fixture = structuredClone(window.app.session.vault);
        fixture.roomId = crypto.randomUUID(); delete fixture.spaceRecoveryCode;
        window.app.handleCreate = async (...args) => {
          window.app.handleCreate = before;
          const v = await import('/src/lib/vault.ts'), k = await import('/src/lib/browser-room-key.ts');
          await v.createVault(fixture, '', 'platform', await k.automaticRoomCredential());
          return before(...args);
        };
      }, current);
      await openList(); await list.locator('#space-create').click();
      await page.locator('#app-toast').filter({ hasText: message }).waitFor();
      assert.equal(await roomId(), returnRoom, 'A late cross-tab quota rejection returns to the original room');
      assert.equal(posts, 4, 'A late quota rejection must not create a server room');
      await source.close();
      await context.close();

      // Two independent tabs compete for the last place under the real storage lease.
      const storage = await browser.newContext();
      const a = await storage.newPage(); await a.goto(`${origin}/__capacity`);
      const seed = async (page, roles) => page.evaluate(async roles => {
        const v = await import('/src/lib/vault.ts'), k = await import('/src/lib/browser-room-key.ts');
        const { generateIdentity } = await import('/src/lib/crypto.ts');
        const { newArchiveKey } = await import('/src/lib/room-archive-crypto.ts');
        const output = [];
        for (const role of roles) {
          const identity = await generateIdentity(), other = await generateIdentity();
          const creator = role === 'creator' ? identity : other;
          const vault = { v: 3, roomId: crypto.randomUUID(), accessToken: 'a'.repeat(43), pairingSecret: '', creatorFingerprint: 'fixture',
            role: role === 'joiner' ? 'joiner' : 'creator', identity, members: [ { ...creator.publicBundle, role: 'creator', joinProof: null, addedBy: null },
              ...(role === 'creator' ? [] : [{ ...identity.publicBundle, role: role === 'joiner' ? 'joiner' : 'creator', addedBy: creator.publicBundle.deviceId, joinProof: 'fixture' }]) ],
            lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420', roomArchiveV2: { key: newArchiveKey() } };
          output.push(await v.createVault(vault, '', 'platform', await k.automaticRoomCredential()));
        }
        window.seeded = output;
        await v.assertRoomCreationCapacity(await k.browserRoomKey(), () => true);
      }, roles);
      await seed(a, ['creator', 'creator', 'joiner', 'linked-creator']);
      const b = await storage.newPage(); await b.goto(`${origin}/__capacity`);
      const compete = page => page.evaluate(async () => {
        const v = await import('/src/lib/vault.ts'), k = await import('/src/lib/browser-room-key.ts');
        const { generateIdentity } = await import('/src/lib/crypto.ts');
        const { newArchiveKey } = await import('/src/lib/room-archive-crypto.ts');
        const identity = await generateIdentity();
        const vault = { v: 3, roomId: crypto.randomUUID(), accessToken: 'a'.repeat(43), pairingSecret: '', creatorFingerprint: 'fixture', role: 'creator', identity,
          members: [{ ...identity.publicBundle, role: 'creator', joinProof: null }], lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420', roomArchiveV2: { key: newArchiveKey() }, pendingChamberCreate: true };
        const credential = await k.automaticRoomCredential();
        try { await v.createVault(vault, '', 'platform', credential, () => true, { browserSecret: await k.browserRoomKey() }); return 'created'; }
        catch (cause) { return cause.message; }
      });
      assert.deepEqual((await Promise.all([compete(a), compete(b)])).sort(), ['created', message].sort());
      const dedup = await a.evaluate(async () => {
        const v = await import('/src/lib/vault.ts'), k = await import('/src/lib/browser-room-key.ts');
        const original = window.seeded[0];
        await v.createVault(original.vault, '', 'platform', await k.automaticRoomCredential());
        await v.deleteSpaceVault(window.seeded[1]);
        await v.assertRoomCreationCapacity(await k.browserRoomKey(), () => true);
        try { await v.assertRoomCreationCapacity(await k.browserRoomKey(), () => false); return false; }
        catch (cause) { return cause.name === 'AbortError'; }
      });
      assert.equal(dedup, true, 'Duplicate snapshots count once; deletion frees a place; cancelled checks reject');
      await storage.close();
      console.log(`PASS ${name}: creation limit, unchanged page, joining, reload, recovery copy, removal, cross-tab race and deduplication`);
    } finally { await browser.close(); }
  }
} finally { await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true }); }
