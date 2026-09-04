import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-desktop-session-'));
const backend = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
const vite = await createServer({
  configFile: false,
  root: path.resolve(import.meta.dirname, '..'),
  logLevel: 'error',
  plugins: [{
    name: 'desktop-session-test-observer',
    transform(code, id) {
      // Expose the running application for assertions. All lifecycle, vault,
      // history, MLS, and transport methods remain their production versions.
      if (id.endsWith('/src/main.ts')) return `${code}\nglobalThis.__desktopSessionApp = app;`;
    },
  }],
  server: {
    host: '127.0.0.1', port: 0, hmr: false,
    proxy: {
      '/api': `http://127.0.0.1:${backend.port}`,
      '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
    },
  },
});

const errors = [];
let browser;
const trace = step => { if (process.env.QUIET_ROOM_TEST_TRACE) console.log(step); };

async function createDesktop() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // Headless pages share one OS window. Give each context its own focus and
    // visibility state so switching test actors does not implicitly cover it.
    window.__desktopFocused = true;
    window.__desktopHidden = false;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => window.__desktopFocused });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__desktopHidden });
    for (const method of ['create', 'get']) {
      const original = navigator.credentials[method].bind(navigator.credentials);
      Object.defineProperty(navigator.credentials, method, {
        configurable: true,
        value: options => {
          const key = `desktop-test-credential-${method}`;
          const count = Number(sessionStorage.getItem(key) ?? '0');
          sessionStorage.setItem(key, String(count + 1));
          return original(options);
        },
      });
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, hasPrf: true,
      automaticPresenceSimulation: true, isUserVerified: true,
      defaultBackupEligibility: false, defaultBackupState: false,
    },
  });
  return page;
}

async function holdF(page) {
  await page.locator('.cover-trigger').waitFor();
  await page.keyboard.down('f');
  await page.waitForTimeout(2100);
  await page.keyboard.up('f');
}

async function expectChat(page) {
  await page.locator('.chat-shell').waitFor({ timeout: 15_000 }).catch(async cause => {
    throw new Error(`Expected live chat: ${await page.locator('body').innerText()}`, { cause });
  });
  await page.locator('#self-presence strong').filter({ hasText: /^在线$/ }).waitFor({ timeout: 10_000 });
}

const verificationCount = page => page.evaluate(() => Number(sessionStorage.getItem('desktop-test-credential-get') ?? '0'));
const state = page => page.evaluate(() => {
  const app = window.__desktopSessionApp;
  return {
    desktop: app.desktopBrowser,
    covered: app.privacyCovered,
    active: Boolean(app.session),
    retained: Boolean(app.retainedSession),
    socket: Boolean(app.socket),
    messages: app.messages.size,
    protocol: (app.session ?? app.retainedSession)?.vault.protocol,
    fatal: Boolean(document.querySelector('#fatal-lock')),
  };
});

async function depart(page, reason) {
  await page.evaluate(reason => {
    if (reason === 'blur') {
      window.__desktopFocused = false;
      window.dispatchEvent(new Event('blur'));
    } else {
      window.__desktopHidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    }
  }, reason);
  await page.locator('.cover-trigger').waitFor({ state: 'attached' });
  assert.deepEqual(await state(page), {
    desktop: true, covered: true, active: false, retained: true,
    socket: false, messages: 0, protocol: 'mls-rfc9420', fatal: false,
  }, `${reason} must stop private runtime and keep only a retained session`);
  assert.equal(await page.locator('.chat-shell, .message, #message-input').count(), 0, 'Covered page must remove private markup');
}

async function returnToPage(page) {
  await page.evaluate(() => {
    window.__desktopHidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    window.__desktopFocused = true;
    window.dispatchEvent(new Event('focus'));
  });
}

async function send(page, text) {
  await page.locator('#message-input').fill(text);
  await page.locator('.send-button').click();
  await page.locator('.message.outgoing').filter({ hasText: text }).waitFor({ timeout: 10_000 });
}

try {
  await vite.listen();
  const baseUrl = `http://localhost:${vite.httpServer.address().port}/`;
  browser = await chromium.launch(process.env.CHROME_PATH
    ? { headless: true, executablePath: process.env.CHROME_PATH }
    : process.env.CI ? { headless: true } : { headless: true, channel: 'chrome' });
  const creator = await createDesktop();
  const joiner = await createDesktop();

  trace('Pairing two desktop browsers with real device-bound PRF vaults');
  await creator.goto(baseUrl);
  await holdF(creator);
  await creator.locator('#create-room').click();
  await creator.locator('[data-device-verify]').click();
  await creator.locator('.pairing-screen').waitFor({ timeout: 15_000 });
  const invite = await creator.locator('#invite-url').inputValue();
  await joiner.goto(invite);
  await holdF(joiner);
  await joiner.locator('[data-device-verify]').click();
  await Promise.all([expectChat(creator), expectChat(joiner)]);
  const initialVerifications = await verificationCount(creator);
  assert.equal(await creator.evaluate(() => Number(sessionStorage.getItem('desktop-test-credential-create'))), 1, 'Initial setup must create the real platform credential');

  const firstMessage = 'desktop-session-before-cover';
  await send(creator, firstMessage);
  await joiner.getByText(firstMessage, { exact: true }).waitFor({ timeout: 10_000 });
  await creator.locator('.message.outgoing.is-delivered').filter({ hasText: firstMessage }).waitFor({ timeout: 10_000 });

  for (const reason of ['blur', 'hidden']) {
    trace(`Checking real retained-session restore after ${reason}`);
    const draft = `桌面 ${reason} 恢复后的加密草稿`;
    const queuedMessage = `desktop-peer-message-while-${reason}`;
    await creator.locator('#message-input').fill(draft);
    await depart(creator, reason);
    await send(joiner, queuedMessage);
    await joiner.locator('.message.outgoing.is-stored, .message.outgoing.is-sent').filter({ hasText: queuedMessage }).waitFor({ timeout: 10_000 });
    await returnToPage(creator);
    await holdF(creator);
    await expectChat(creator);
    await creator.getByText(firstMessage, { exact: true }).waitFor({ timeout: 10_000 });
    await creator.getByText(queuedMessage, { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await creator.locator('#message-input').inputValue(), draft, 'Encrypted composer preferences must restore the unsent draft');
    assert.equal(await verificationCount(creator), initialVerifications, 'Resuming a retained session must not request the device credential again');
    const resumed = await state(creator);
    assert.equal(resumed.active, true);
    assert.equal(resumed.retained, false);
    assert.equal(resumed.socket, true);
    assert.equal(resumed.protocol, 'mls-rfc9420');
    assert.equal(resumed.fatal, false);

    // Sending the restored draft advances the real MLS ratchet. The peer must
    // decrypt it after the sender reopened its durable vault and reconnected.
    await creator.locator('.send-button').click();
    await joiner.getByText(draft, { exact: true }).waitFor({ timeout: 10_000 });
    await creator.locator('.message.outgoing.is-delivered').filter({ hasText: draft }).waitFor({ timeout: 10_000 });
    assert.equal(await verificationCount(creator), initialVerifications);
  }

  trace('Checking manual lock and reload require new device verification');
  await creator.locator('.more-menu summary').click();
  await creator.locator('#lock-room').click();
  const manuallyLocked = await state(creator);
  assert.equal(manuallyLocked.active, false);
  assert.equal(manuallyLocked.retained, false);
  await holdF(creator);
  await expectChat(creator);
  assert.equal(await verificationCount(creator), initialVerifications + 1, 'Manual lock must perform fresh device verification');
  await creator.getByText(firstMessage, { exact: true }).waitFor();

  await creator.reload();
  await creator.locator('.cover-trigger').waitFor();
  const reloaded = await state(creator);
  assert.equal(reloaded.active, false);
  assert.equal(reloaded.retained, false);
  await holdF(creator);
  await expectChat(creator);
  assert.equal(await verificationCount(creator), initialVerifications + 2, 'Reload must perform fresh device verification');
  await send(creator, 'desktop-session-after-fresh-verification');
  await joiner.getByText('desktop-session-after-fresh-verification', { exact: true }).waitFor({ timeout: 10_000 });
  assert.equal((await state(creator)).fatal, false);
  assert.equal((await state(joiner)).fatal, false);
  assert.deepEqual(errors, []);
  console.log('Desktop session flow E2E passed: real PRF vaults, MLS pairing and messages, blur/hidden private-runtime teardown, F resume without repeated verification, encrypted draft/history restore, peer catchup, resumed sending, and fresh verification after manual lock/reload.');
} finally {
  await browser?.close();
  await vite.close();
  await backend.close();
  await rm(dataDir, { recursive: true, force: true });
}
