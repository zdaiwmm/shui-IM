import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit, devices } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../../server/index.mjs';

// Disposable real application / MLS / SQLite / IndexedDB. The only source
// transform exposes the app for numeric observation, never replaces behavior.
export async function harness({ engine = 'chromium', mobile = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qr-remediation-audit-'));
  let service, vite, browser;
  const contexts = [];
  const close = async () => {
    await browser?.close(); await vite?.close(); await service?.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    service = await startServer({ port: 0, host: '127.0.0.1', dataDir: directory, quiet: true });
    vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error', cacheDir: path.join(directory, 'vite'),
      plugins: [{ name: 'audit-observer', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/src/main.ts')) {
          assert.equal(code.split('void app.start();').length, 2);
          return code.replace('void app.start();', 'window.auditApp=app;void app.start();');
        }
      } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
        '/api': `http://127.0.0.1:${service.port}`, '/ws': { target: `ws://127.0.0.1:${service.port}`, ws: true },
      } } });
    await vite.listen();
    const kind = engine === 'webkit' ? webkit : chromium;
    browser = await kind.launch(engine === 'chromium' && !process.env.CI ? { channel: 'chrome' } : {});
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const newPage = async () => {
      const context = await browser.newContext({ locale: 'zh-CN', ...(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }) });
      contexts.push(context);
      await context.addInitScript(() => {
        localStorage.setItem('quiet-room:auto-lock-seconds', '0');
        localStorage.setItem('quiet-room:lock-on-hidden', '0');
        // Isolated synthetic invitations never reach the system clipboard.
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => { window.auditClipboard = text; }, readText: async () => window.auditClipboard ?? '',
        } });
      });
      const page = await context.newPage(); page.setDefaultTimeout(30_000); return page;
    };
    const ready = page => page.waitForFunction(() => window.auditApp?.connectionState === 'connected'
      && auditApp.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input')?.disabled === false,
    undefined, { timeout: 45_000, polling: 100 });
    const pair = async () => {
      const creator = await newPage(), peer = await newPage();
      await creator.goto(origin); await creator.locator('#create-room').click();
      await creator.locator('#copy-invite').click();
      await creator.waitForFunction(() => typeof window.auditClipboard === 'string' && window.auditClipboard.includes('#j='));
      const invite = await creator.evaluate(() => window.auditClipboard);
      assert.match(invite, /#j=[A-Za-z0-9_-]{43}$/);
      await peer.goto(invite); await ready(peer); await ready(creator);
      return [creator, peer];
    };
    return { service, vite, browser, origin, newPage, ready, pair, close };
  } catch (error) { await close(); throw error; }
}

export const outputDirectory = path.resolve('.artifacts/audit-remediation');
export async function outputReady() { await mkdir(outputDirectory, { recursive: true }); }
export async function send(page, text) {
  await page.locator('#message-input').fill(text);
  await page.locator('#composer').evaluate(form => form.requestSubmit());
}
export async function protect(page) {
  // Existing new-room fixture prerequisite: a configured local application
  // lock. An automatic-access room can legitimately reopen after lockNow.
  await page.evaluate(async () => {
    const k = await import('/src/lib/browser-room-key.ts'), p = await import('/src/lib/password-protection.ts');
    await k.protectBrowserRoomKey(await p.deriveNumericPasswordCredential('927451'));
    auditApp.roomLockEnabled = true;
  });
}
export async function durable(page) {
  return page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'), k = await import('/src/lib/browser-room-key.ts');
    // Automatic backup can replace the encrypted vault between these read-only
    // observation steps. Retry only that explicit optimistic-read conflict.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const stored = await v.readStoredVault();
        const s = await v.unlockVault(await k.browserRoomKey(), undefined, stored);
        const history = await v.loadHistory(s);
        return { seq: s.vault.lastSeq, controls: s.vault.mls?.window?.controls ?? [],
          rows: history.map(row => ({ seq: row.seq, kind: row.payload.kind, id: row.clientMsgId })),
          outbox: (await v.loadOutbox(s)).length, observationRetries: attempt };
      } catch (error) {
        if (!String(error).includes('本机会话已在其它窗口') || attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  });
}
