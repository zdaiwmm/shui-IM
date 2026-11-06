import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit, devices } from 'playwright';
import { createServer } from 'vite';
import { outputDirectory, outputReady } from './harness.mjs';

// Synthetic legacy model, real production renderer and complete CSS cascade.
// Excludes authentication/network/MLS and native keyboard/compositor claims.
await outputReady();
const styles = [...(await readFile('src/main.ts', 'utf8')).matchAll(/import '(\.\/[^']+\.css)'/g)].map(x => '/src/' + x[1].slice(2));
const vite = await createServer({ root: process.cwd(), configFile: false, appType: 'custom', logLevel: 'error',
  cacheDir: path.join(outputDirectory, 'vite-history'), server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'history-audit', configureServer(server) { server.middlewares.use('/__history_audit', (_req, res) => {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');
  }); } }] });
const results = { kind: 'synthetic-model-real-renderer', startedAt: new Date().toISOString(), cases: [] };
const selectedEngine = process.env.AUDIT_ENGINE;
assert.ok(!selectedEngine || ['chromium', 'webkit'].includes(selectedEngine));
if (selectedEngine) {
  try {
    const prior = JSON.parse(await readFile(path.join(outputDirectory, 'history-render.json'), 'utf8'));
    results.startedAt = prior.startedAt; results.resumedAt = new Date().toISOString();
    results.cases = prior.cases.filter(row => row.engine !== selectedEngine);
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
let browser;
try {
  await vite.listen();
  for (const [engine, mobile] of [[chromium, false], [chromium, true], [webkit, true]]) {
    if (selectedEngine && engine.name() !== selectedEngine) continue;
    browser = await engine.launch(engine === chromium && !process.env.CI ? { channel: 'chrome' } : {});
    for (const size of [100, 1000, 10000]) for (let trial = 0; trial < 5; trial++) {
      const context = await browser.newContext({ locale: 'zh-CN', ...(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }) });
      const page = await context.newPage();
      try {
        await page.goto(`http://localhost:${vite.httpServer.address().port}/__history_audit`);
        if (mobile) {
          await page.evaluate(() => { window.auditTouchEvents = 0; document.addEventListener('touchstart', () => window.auditTouchEvents++, { once: true }); });
          await page.touchscreen.tap(5, 5);
          assert.equal(await page.evaluate(() => window.auditTouchEvents), 1);
        }
        await page.evaluate(async ({ styles }) => {
          for (const style of styles) await import(style);
          const { QuietRoomApp } = await import('/src/app.ts'), v = await import('/src/lib/vault.ts');
          const own = { deviceId: 'audit-own', role: 'creator', status: 'active' }, peer = { deviceId: 'audit-peer', role: 'joiner', status: 'active' };
          const session = await v.createVault({ v: 1, roomId: 'synthetic-history', accessToken: 'synthetic', role: 'creator', protocol: 'legacy-v1', lastSeq: 0,
            members: [own, peer], identity: { publicBundle: own } }, 'synthetic-history-audit', 'password');
          const app = new QuietRoomApp(document.querySelector('#app'));
          app.session = session; app.privacyCovered = false; app.runtimeEpoch++; app.runtimeAbort = new AbortController();
          // Same non-network boundaries as frontend-lifecycle. No rendering methods are replaced.
          app.updateSafetyCode = async () => {}; app.updateBackgroundNotificationControl = async () => {};
          app.mountChatImageObserver = () => {}; app.mountGalleryThumbnails = () => {};
          app.uiPreferences = {}; app.uiPreferencesHydrated = true; app.restoreChatAnchorOnNextRender = false;
          app.renderChat(); window.auditHistory = app;
          window.auditMessage = seq => ({ seq, clientMsgId: `audit-${seq}`, senderId: 'audit-peer', status: 'delivered',
            acceptedAt: '2026-11-06T00:00:00Z', payload: { v: 1, kind: 'text', sentAt: '2026-11-06T00:00:00Z', text: `合成历史 ${seq}，用于审计列表布局。` } });
        }, { styles });
        const sample = await page.evaluate(async size => {
          const app = auditHistory;
          app.messages = new Map(Array.from({ length: size }, (_, n) => [n + 1, auditMessage(n + 1)]));
          const start = performance.now(); app.renderMessages({ scroll: 'bottom' }); const initialRenderMs = performance.now() - start;
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
          const stable = [], inputFrames = [], input = document.querySelector('#message-input');
          for (let i = 0; i < 20; i++) {
            const start = performance.now(); app.renderMessages({ scroll: 'preserve' }); stable.push(performance.now() - start);
            const inputStart = performance.now(); input.value = `合成输入${i}`;
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '入' }));
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            inputFrames.push(performance.now() - inputStart);
          }
          const rows = document.querySelectorAll('#message-list > .message').length;
          const nodes = document.querySelectorAll('*').length, heap = performance.memory?.usedJSHeapSize ?? null;
          const profile = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints,
            dispatchedTouchEvents: window.auditTouchEvents ?? null, coarse: matchMedia('(pointer:coarse)').matches, ua: navigator.userAgent };
          return { size, profile, initialRenderMs, unchangedRenderMs: stable, syntheticInputToTwoRafMs: inputFrames, rows, nodes, heap };
        }, size);
        if (mobile) {
          assert.equal(sample.profile.width, 390); assert.equal(sample.profile.dpr, 3);
          assert.ok(sample.profile.coarse); assert.match(sample.profile.ua, /iPhone/);
          // Desktop-hosted WebKit reports maxTouchPoints=0 even with hasTouch.
          // Require an actual Playwright touch dispatch instead of spoofing it.
          if (engine === chromium) assert.ok(sample.profile.touch > 0);
        }
        if (trial === 0) await page.screenshot({ path: path.join(outputDirectory, `history-${engine.name()}-${mobile}-${size}.png`) });
        Object.assign(sample, await page.evaluate(() => {
          auditHistory.lockNow();
          return { lockedRows: document.querySelectorAll('#message-list > .message').length,
            cacheAfterLock: auditHistory.imageCache.size, messagesAfterLock: auditHistory.messages.size };
        }));
        assert.equal(sample.rows, size); assert.equal(sample.lockedRows, 0); assert.equal(sample.messagesAfterLock, 0);
        results.cases.push({ engine: engine.name(), mobile, trial, ...sample });
        console.log('HISTORY_RENDER', JSON.stringify({ engine: engine.name(), mobile, trial, size, initialRenderMs: sample.initialRenderMs,
          unchangedMedianMs: [...sample.unchangedRenderMs].sort((a, b) => a - b)[10], nodes: sample.nodes }));
        await writeFile(path.join(outputDirectory, 'history-render.json'), JSON.stringify(results, null, 2));
      } finally { await context.close(); }
    }
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); await vite.close(); }
