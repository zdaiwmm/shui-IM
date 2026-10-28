import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { submitPassword } from './helpers/password.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'inapp-lock-first-chat-'));
let backend, vite, browser;
try {
  backend = await startServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true });
  vite = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error',
    plugins: [{ name: 'first-chat-observer', enforce: 'pre', transform(code, id) {
      if (id === path.join(process.cwd(), 'src/main.ts')) return code.replace('void app.start();', 'window.app=app;void app.start();');
    } }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': `http://127.0.0.1:${backend.port}`, '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
    } } });
  await vite.listen();
  const home = `http://localhost:${vite.httpServer.address().port}/`;
  for (const engine of [chromium, webkit]) {
    browser = await engine.launch(engine === chromium && !process.env.CI
      ? process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' } : {});
    const pages = [], errors = [];
    for (let side = 0; side < 2; side++) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true,
        deviceScaleFactor: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1' });
      await context.addInitScript(() => {
        const observer = new MutationObserver(() => {
          const input = document.querySelector('#message-input');
          if (input) { window.initialComposer = input; observer.disconnect(); }
        });
        observer.observe(document, { childList: true, subtree: true });
      });
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      page.on('pageerror', error => errors.push(error.message)); pages.push(page);
    }
    const [a, b] = pages;
    await a.goto(home);
    try { await a.locator('#create-room').click(); await a.locator('#copy-invite').waitFor(); }
    catch (cause) { console.error('FIRST_CHAT_START', errors, await a.locator('body').innerText()); throw cause; }
    const invite = await a.locator('#invite-url').inputValue();
    await b.goto(invite);
    for (const [side, page] of pages.entries()) {
      await page.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && !document.querySelector('#message-input')?.disabled);
      assert.equal(await page.evaluate(() => initialComposer === document.querySelector('#message-input')), true,
        'Initial connection must activate the existing composer, preserving its touch/focus owner');
      await page.locator('#message-input').tap();
      assert.equal(await page.locator('#message-input').evaluate(input => document.activeElement === input), true,
        `${engine.name()} side ${side} must focus on the first tap without reentry`);
      // Headless engines do not open an OS keyboard. Supply its viewport
      // geometry explicitly before testing the actual send control.
      await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => 532 }); visualViewport.dispatchEvent(new Event('resize')); });
      await page.waitForFunction(() => !document.querySelector('#composer')?.hasAttribute('data-viewport-motion'));
      await page.keyboard.type(`Synthetic first chat ${side}`);
      assert.equal(await page.locator('#message-input').inputValue(), `Synthetic first chat ${side}`);
      await page.locator('#composer').evaluate(form => form.requestSubmit());
      try { await pages[1 - side].getByText(`Synthetic first chat ${side}`, { exact: true }).waitFor(); }
      catch (cause) {
        for (const p of pages) console.error('FIRST_CHAT_SEND', await p.evaluate(() => ({
          surface: app.activeSurface, covered: app.privacyCovered, phase: app.session?.vault.mls?.phase,
          input: document.querySelector('#message-input')?.value, rootClass: document.documentElement.className,
          pending: app.pending.size, outbox: app.outbox.size, notice: document.querySelector('#app-toast')?.textContent,
        })));
        throw cause;
      }
      await page.evaluate(() => { document.activeElement?.blur(); delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
    }
    // Real settings + wrapper persistence, with explicitly synthetic WebAuthn
    // outcomes. No UA-specific capability or physical authenticator claim.
    const installOutcomes = () => b.evaluate(async () => {
      window.newProtectionMode = 'unsupported'; window.newProtectionCalls = 0;
      if (!window.PublicKeyCredential) window.PublicKeyCredential = class {};
      Object.defineProperty(PublicKeyCredential, 'getClientCapabilities', { configurable: true,
        value: async () => newProtectionMode === 'unsupported' ? { 'extension:prf': false } : {} });
      Object.defineProperty(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable', { configurable: true,
        value: async () => { throw Error('Synthetic unknown shell capability'); } });
      // WebKit may return a different wrapper from navigator.credentials on
      // the next read. Pin the synthetic container, rather than shadowing one
      // ephemeral wrapper while accidentally calling the real OS ceremony.
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: {
        create: async () => { window.newProtectionCalls++; throw new DOMException('Synthetic blocked or cancelled ceremony', 'NotAllowedError'); },
        get: async () => { throw new DOMException('Synthetic existing verification blocked', 'NotAllowedError'); },
      } });
      await (await import('/src/lib/platform-vault.ts')).probePlatformVaultCapabilities();
      app.renderAutoLockSettings();
    });
    await installOutcomes();
    await b.locator('[data-remove-room-lock]').click(); await b.locator('.numeric-password-page').waitFor();
    assert.equal(await b.evaluate(() => newProtectionCalls), 0, 'Explicit unsupported capability skips native authentication');
    await b.locator('[data-numeric-left]').click(); await b.locator('.numeric-password-page').waitFor({ state: 'detached' });
    await b.waitForFunction(() => app.roomLockSetupEpoch === null);
    await b.evaluate(async () => { window.newProtectionMode = 'unknown'; await (await import('/src/lib/platform-vault.ts')).probePlatformVaultCapabilities(); });
    await b.locator('[data-remove-room-lock]').click(); await b.locator('.new-protection-choice').waitFor();
    assert.equal(await b.locator('.numeric-password-page').count(), 0, 'Unknown/cancelled native verification must not silently select a new password');
    await b.locator('[data-protection-retry]').tap();
    try { await b.waitForFunction(() => newProtectionCalls === 2); }
    catch (cause) { console.error('PROTECTION_RETRY', engine.name(), errors, await b.evaluate(() => ({calls:newProtectionCalls,
      hidden:document.hidden,covered:app.privacyCovered,epoch:app.runtimeEpoch,busy:app.roomLockSetupEpoch,
      choice:!!document.querySelector('.new-protection-choice'),password:!!document.querySelector('.numeric-password-page'),
      notice:document.querySelector('#app-toast')?.textContent}))); throw cause; }
    await b.locator('[data-protection-cancel]').tap(); await b.waitForFunction(() => app.roomLockSetupEpoch === null);
    assert.equal(await b.evaluate(async () => (await (await import('/src/lib/vault.ts')).readRoomProtection()).method), 'automatic');
    await b.locator('[data-remove-room-lock]').click(); await b.locator('.new-protection-choice').waitFor();
    // Navigation retires the pending choice. Its result must not create a
    // password on the successor chat page.
    await b.evaluate(() => app.renderChat()); await b.locator('.new-protection-choice').waitFor({ state: 'detached' });
    await b.waitForFunction(() => app.roomLockSetupEpoch === null);
    assert.equal(await b.locator('.numeric-password-page').count(), 0);
    await b.evaluate(() => app.renderAutoLockSettings());
    const lateResult = await b.evaluate(async () => {
      const proof = new Uint8Array(32).fill(9);
      let finish;
      const operation = app.prepareNewLocalProtection(() => true, false,
        () => new Promise(resolve => { finish = resolve; })).then(() => 'accepted', cause => cause.name);
      app.renderChat(); finish({ record: {}, prfOutput: proof });
      return { result: await operation, cleared: proof.every(byte => byte === 0) };
    });
    assert.deepEqual(lateResult, { result: 'AbortError', cleared: true }, 'A late native result belongs to its retired settings page');
    await b.evaluate(() => app.renderAutoLockSettings());
    await b.locator('[data-remove-room-lock]').click(); await b.locator('.new-protection-choice').waitFor();
    await b.evaluate(() => document.dispatchEvent(new Event('freeze')));
    await b.locator('.new-protection-choice').waitFor({ state: 'detached' });
    assert.equal(await b.locator('.numeric-password-page').count(), 0, 'Freeze cannot install a new wrapper or reopen its password form');
    assert.equal(await b.evaluate(async () => (await (await import('/src/lib/vault.ts')).readRoomProtection()).method), 'automatic');
    await b.reload(); await b.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
    await installOutcomes();
    await b.evaluate(async () => { window.newProtectionMode = 'unknown'; await (await import('/src/lib/platform-vault.ts')).probePlatformVaultCapabilities(); });
    await b.locator('[data-remove-room-lock]').click(); await b.locator('.new-protection-choice').waitFor();
    await b.locator('[data-protection-password]').tap(); await b.locator('.numeric-password-page').waitFor();
    await submitPassword(b, '012345'); await b.waitForFunction(() => app.roomLockEnabled && app.roomLockSetupEpoch === null);
    const protection = await b.evaluate(async () => (await (await import('/src/lib/vault.ts')).readRoomProtection()));
    assert.equal(protection.method, 'password'); assert.equal(protection.wrapper.passwordFormat, 'numeric-6');
    await b.evaluate(() => app.manualLock()); await b.reload(); await submitPassword(b, '012345');
    await b.waitForFunction(() => document.querySelector('#message-input')?.disabled === false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine.name()}: initial two-party focus/send, unsupported/unknown lock setup, retry/cancel/navigation, numeric reopen`);
    await browser.close(); browser = null;
  }
  console.log('In-app lock and first-chat regression passed');
} finally { await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true }); }
