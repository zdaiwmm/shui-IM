import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { submitPassword } from './helpers/password.mjs';

// Imported by the existing Chamber full-flow entry, and runnable on both engines.
export async function verifyChamberInviteReentry(page, invite, pin) {
  const home = new URL('/', invite).href;
  const dirty = new URL(invite); dirty.pathname = '/synthetic-participant-entry'; dirty.search = '?source=synthetic-reentry';
  const snapshot = () => page.evaluate(() => ({
    room: app.session.vault.roomId, device: app.session.vault.identity.publicBundle.deviceId,
    slot: app.session.stored.spaceId ?? 'current', root: app.session.vault.personalBinding.identity.id,
  }));
  const original = await snapshot();
  let invitationRequests = 0;
  const observe = request => {
    if (request.url().includes('/chamber-invitation') && request.method() === 'POST') invitationRequests++;
  };
  page.on('request', observe);
  // A live same-tab link replaces the current history entry, without navigation.
  let navigations = 0;
  const navigated = request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; };
  page.on('request', navigated);
  const historyLength = await page.evaluate(async dirty => {
    history.replaceState({ syntheticReentry: true }, '', dirty);
    const length = history.length;
    await app.routeInvitation();
    return length;
  }, dirty.href);
  await page.waitForFunction(() => document.querySelector('#message-input') && !document.querySelector('#message-input').disabled);
  assert.ok(page.url() === home, 'An existing participant lands at the canonical home URL');
  assert.equal(navigations, 0, 'URL cleanup must not reload the document');
  assert.equal(await page.evaluate(() => history.length), historyLength, 'Cleanup must not add a history entry');
  assert.deepEqual(await page.evaluate(() => history.state), { syntheticReentry: true });
  assert.deepEqual(await snapshot(), original);
  page.off('request', navigated);

  await page.evaluate(() => sessionStorage.clear());
  await page.goto(dirty.href);
  await submitPassword(page, pin);
  await page.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input') && !document.querySelector('#message-input').disabled);
  assert.ok(page.url() === home, 'Current URL must be the canonical home; URL material omitted');
  assert.deepEqual(await snapshot(), original, 'Cold entry must retain the original root, device and vault');
  await page.reload(); await submitPassword(page, pin);
  await page.waitForFunction(() => document.querySelector('#message-input') && !document.querySelector('#message-input').disabled);
  assert.ok(page.url() === home, 'Current URL must be the canonical home; URL material omitted');
  assert.deepEqual(await snapshot(), original);

  const tab = await page.context().newPage();
  tab.setDefaultTimeout(20_000);
  try {
    await tab.goto(dirty.href); await submitPassword(tab, pin);
    await tab.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input') && !document.querySelector('#message-input').disabled);
    assert.ok(tab.url() === home, 'A new tab in the same browser uses its durable local vault');
    assert.deepEqual(await tab.evaluate(() => ({
      room: app.session.vault.roomId, device: app.session.vault.identity.publicBundle.deviceId,
      slot: app.session.stored.spaceId ?? 'current', root: app.session.vault.personalBinding.identity.id,
    })), original);
  } finally { await tab.close(); }
  await page.bringToFront();
  if (await page.locator('.numeric-password-page').count()) await submitPassword(page, pin);
  // A different selected vault must resolve the requested room through the encrypted directory.
  const otherSlot = await page.evaluate(async pin => {
    const v = await import('/src/lib/vault.ts'), c = await import('/src/lib/crypto.ts');
    const api = await import('/src/lib/api.ts'), spaces = await import('/src/lib/spaces.ts');
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const protection = await import('/src/lib/password-protection.ts');
    const directory = app.session.vault.spaceRecoveryCode;
    if (!await app.leaveSpace()) throw new Error('Synthetic fixture could not leave the original room');
    await v.selectLocalSpace(crypto.randomUUID());
    const identity = await c.generateIdentity(), token = randomBase64Url(32), inviteToken = randomBase64Url(32);
    const room = await api.createRoom(identity.publicBundle, token, inviteToken);
    const credential = await protection.deriveNumericPasswordCredential(pin);
    try {
      const session = await v.createVault({ v: 3, roomId: room.roomId, accessToken: token, inviteToken,
        pairingSecret: randomBase64Url(32), creatorFingerprint: await c.bundleFingerprint(identity.publicBundle),
        role: 'creator', protocol: room.protocol, lastSeq: 0, pairingState: 'ready',
        members: [{ ...identity.publicBundle, role: 'creator', status: 'active' }], identity, createdAt: room.createdAt,
      }, '', 'password', credential);
      await spaces.rememberLocalSpace(session, directory);
      return v.vaultSpaceId(session.stored);
    } finally { delete credential.rootKek; }
  }, pin);
  await page.goto(dirty.href); await submitPassword(page, pin); await submitPassword(page, pin);
  await page.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input') && !document.querySelector('#message-input').disabled);
  assert.ok(page.url() === home, 'Current URL must be the canonical home; URL material omitted');
  assert.deepEqual(await snapshot(), original, 'A different selected room must not displace the invited original endpoint');
  assert.equal(await page.evaluate(async id => (await import('/src/lib/vault.ts')).localSpaceExists(id), otherSlot), true);
  assert.equal(invitationRequests, 0, 'Existing participants must not claim the consumed invitation again');
  page.off('request', observe);
}

async function run() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chamber-reentry-'));
  let backend, vite, browser;
  try {
    backend = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
    vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', plugins: [{
      name: 'chamber-reentry-observer', enforce: 'pre', transform(code, id) {
        if (id === path.join(process.cwd(), 'src/main.ts')) return code.replace('void app.start();', 'window.app=app;void app.start();');
      },
    }], server: { host: '127.0.0.1', port: 0, hmr: false, proxy: {
      '/api': `http://127.0.0.1:${backend.port}`, '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true },
    } } });
    await vite.listen();
    const home = `http://127.0.0.1:${vite.httpServer.address().port}/`;
    const engines = process.env.CHAMBER_REENTRY_BROWSER ? [{ chromium, webkit }[process.env.CHAMBER_REENTRY_BROWSER]] : [chromium, webkit];
    for (const engine of engines) {
      browser = await engine.launch(engine === chromium && !process.env.CI ? process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' } : {});
      const pages = [], errors = [], teardownFetchDiagnostics = [];
      for (let i = 0; i < 2; i++) {
        const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0' });
        const page = await context.newPage(); page.setDefaultTimeout(20_000);
        page.on('pageerror', error => {
          // WebKit reports handled, canceled fetches from an exiting document as
          // native resource diagnostics. Keep them separate from JS exceptions.
          if (engine === webkit && error.name === 'Fetch API cannot load http' &&
              /\/unread\//.test(error.message) && /renderCover/.test(error.stack ?? '') && /lockNow/.test(error.stack ?? '')) {
            teardownFetchDiagnostics.push('pagehide unread resource canceled');
          } else errors.push({ name: error.name, message: error.message, stack: error.stack });
        }); pages.push(page);
      }
      const [a, b] = pages;
      await a.goto(home); await a.locator('#create-room').click(); await submitPassword(a, '246810');
      await a.locator('#invite-url').waitFor(); const invite = await a.locator('#invite-url').inputValue();
      await b.goto(invite); await submitPassword(b, '135790'); await b.locator('.chamber-code-card').waitFor();
      const pending = await b.evaluate(() => ({ ...app.session.vault.pendingChamberInvitation }));
      // The encrypted pending record must survive loss of the tab's claim cache.
      await b.evaluate(() => sessionStorage.clear()); await b.goto('about:blank'); await b.goto(invite);
      try { await submitPassword(b, '135790'); }
      catch (cause) {
        console.error('Synthetic pending reentry diagnostic', await b.evaluate(async () => ({
          title: document.querySelector('h1')?.textContent, body: [...document.querySelector('#app').children].map(n => n.className),
          covered: app.privacyCovered, focus: document.hasFocus(), hidden: document.hidden,
          hasVault: await (await import('/src/lib/vault.ts')).hasStoredVault(),
          method: (await (await import('/src/lib/vault.ts')).readStoredVault())?.unlockMethod,
          error: document.querySelector('.form-error')?.textContent,
        })));
        throw cause;
      }
      await b.locator('.chamber-code-card').waitFor();
      assert.deepEqual(await b.evaluate(() => ({ ...app.session.vault.pendingChamberInvitation })), pending);
      assert.ok(b.url() === home, 'Pending entry must use the canonical home; URL material omitted');
      await a.evaluate(async () => { app.chamberInvitePolledAt = 0; await app.pollChamberInvitation(); });
      const code = await a.evaluate(() => app.chamberInviteState.code);
      await b.locator('[data-code-digit="0"]').click(); await b.locator('#form-input-draft').fill(code);
      await b.locator('[data-form-input-done]').click();
      for (const page of pages) await page.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && document.querySelector('#message-input') && !document.querySelector('#message-input').disabled);
      await verifyChamberInviteReentry(b, invite, '135790');
      const outsider = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 } });
      await outsider.goto(invite);
      await outsider.getByRole('heading', { name: '此邀请已使用', exact: true }).waitFor();
      assert.equal(await outsider.locator('#message-input').count(), 0);
      assert.equal(await outsider.evaluate(async () => (await (await import('/src/lib/vault.ts')).readPersonalIdentity()) === null), true);
      await outsider.locator('#join-identity-restore').click();
      await outsider.getByRole('heading', { name: '先保护这台设备', exact: true }).waitFor();
      await outsider.close();
      assert.deepEqual(errors, []);
      console.log(`Chamber invite reentry (${engine.name()}): pending resume, live/cold entry, canonical URL/history, reload, new tab, multi-room and nonmember gates passed; ${teardownFetchDiagnostics.length} native pagehide unread-resource diagnostics recorded.`);
      await browser.close(); browser = undefined;
    }
  } finally { await browser?.close(); await vite?.close(); await backend?.close(); await rm(dataDir, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await run();
