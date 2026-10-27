import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { submitPassword } from '../helpers/password.mjs';
import { observeExitRequests } from '../helpers/webkit-exit-diagnostics.mjs';

/** Real gateway, encrypted local protection and creation, with synthetic links only. */
export async function verifyExpiredInviteEntry(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true, deviceScaleFactor: 3 });
  const page = await context.newPage(), errors = [], exitEvidence = await observeExitRequests(page);
  page.setDefaultTimeout(20_000);
  page.on('pageerror', error => errors.push(exitEvidence.capture(error)));
  const hash = `#j=${randomBytes(32).toString('base64url')}`;
  const shortRequests = '**/api/short-invites/*';
  const openFromCover = async target => {
    await page.evaluate(async target => {
      localStorage.setItem('quiet-room:cover-enabled', '1');
      app.lockNow();
      history.replaceState({ expiredInviteTest: true }, '', `/?entry=synthetic${target}`);
      await app.renderGateway({ trustedCoverActivation: true, autoUnlock: false });
    }, target);
  };
  try {
    await page.goto(baseUrl);
    await page.locator('#create-room').waitFor();
    const device = await page.evaluate(() => ({ maxTouchPoints: navigator.maxTouchPoints ?? null,
      coarse: matchMedia('(pointer: coarse)').matches, dpr: devicePixelRatio, width: innerWidth }));
    assert.deepEqual({ coarse: device.coarse, dpr: device.dpr, width: device.width }, { coarse: true, dpr: 3, width: 390 });
    // Playwright WebKit can omit maxTouchPoints even with hasTouch enabled.
    // Record the actual value; the creation action below also uses a real tap.
    console.log('Expired invitation mobile parameters', JSON.stringify(device));

    for (const failure of ['malformed', 'unavailable', 'invalid-envelope', 'expired']) {
      if (failure === 'unavailable') await page.route(shortRequests, route => route.fulfill({ status: 503 }));
      if (failure === 'invalid-envelope') await page.route(shortRequests, route => route.fulfill({ json: { v: 0 } }));
      await openFromCover(failure === 'malformed' ? '#j=invalid' : hash);
      await page.locator('#create-room').waitFor();
      assert.equal(await page.evaluate(() => app.privacyCovered), false, `${failure}: welcome must be actionable`);
      assert.equal(await page.locator('body').getAttribute('class'), 'app-mode');
      assert.equal(new URL(page.url()).hash, '');
      assert.equal(new URL(page.url()).search, '?entry=synthetic');
      assert.deepEqual(await page.evaluate(() => history.state), { expiredInviteTest: true });
      assert.ok(await page.locator('#app-toast').textContent(), `${failure}: explain the failed invitation`);
      await page.unroute(shortRequests);
    }

    // A lock while already covered changes the entry generation without changing
    // the runtime. The old failed request must not replace that newer cover.
    for (const boundary of ['lock', 'hidden']) {
      let release, received;
      const requested = new Promise(resolve => { received = resolve; });
      const response = new Promise(resolve => { release = resolve; });
      await page.route(shortRequests, async route => { received(); await response; await route.fulfill({ status: 404 }); });
      await page.evaluate(target => {
        app.lockNow(); history.replaceState(null, '', target);
        window.oldInviteEntry = app.renderGateway({ trustedCoverActivation: true, autoUnlock: false });
      }, hash);
      await requested;
      await page.evaluate(boundary => {
        if (boundary === 'lock') app.lockNow();
        else {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
        }
      }, boundary);
      release(); await page.evaluate(() => window.oldInviteEntry);
      assert.equal(await page.evaluate(() => app.privacyCovered), true);
      assert.equal(await page.locator('.cover').count(), 1, `${boundary}: a late failure must preserve the cover`);
      assert.equal(await page.locator('#create-room, #app-toast').count(), 0);
      assert.equal(new URL(page.url()).hash, hash, 'A stale response must leave the next entry target intact');
      if (boundary === 'hidden') await page.evaluate(() => {
        delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.unroute(shortRequests);
    }

    await openFromCover(hash);
    let creations = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms') creations++; });
    await page.locator('#create-room').tap();
    await page.locator('#copy-invite').waitFor();
    assert.equal(creations, 1, 'Creating after a failed invitation must create exactly one room');
    const original = await page.evaluate(async () => {
      const keys = await import('/src/lib/browser-room-key.ts');
      const protection = await import('/src/lib/password-protection.ts');
      const vaults = await import('/src/lib/vault.ts');
      await keys.protectBrowserRoomKey(await protection.deriveNumericPasswordCredential('927451'));
      app.roomLockEnabled = true;
      localStorage.setItem('quiet-room:cover-enabled', '0');
      return { room: app.session.vault.roomId, stored: JSON.stringify(await vaults.readStoredVault()) };
    });

    // Cold entry with a durable vault must use its ordinary lock screen. The
    // expired invitation cannot expose a fresh-create shortcut or mutate the vault.
    await page.goto(`${baseUrl}/${hash}`);
    await page.locator('.numeric-password-page').waitFor();
    assert.equal(await page.locator('#create-room, #message-input').count(), 0);
    assert.match(await page.locator('#app-toast').textContent(), /聊天链接已失效/);
    assert.equal(await page.evaluate(async () => JSON.stringify(await (await import('/src/lib/vault.ts')).readStoredVault())), original.stored);
    await submitPassword(page, '927451');
    await page.locator('#copy-invite').waitFor();
    assert.equal(await page.evaluate(() => app.session.vault.roomId), original.room, 'Unlock returns to the original room');
    assert.equal(creations, 1, 'A failed invitation and unlock must not create another room');
    await context.close();
    const nativeExit = error => browser.browserType().name() === 'webkit' && exitEvidence.confirmsNativeExit(error);
    assert.deepEqual(errors.filter(error => !nativeExit(error)), []);
    console.log(`Expired invitation: normal gateway fallback, one-room creation, protected cold entry and stale-lock rejection passed; ${errors.filter(nativeExit).length} confirmed native exit diagnostics recorded.`);
  } finally { await context.close(); }
}
