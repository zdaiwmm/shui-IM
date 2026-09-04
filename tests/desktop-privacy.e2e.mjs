import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'desktop-privacy-fixture', configureServer(vite) {
    // Register before Vite's SPA fallback so index.html cannot boot a second
    // app with competing global keyboard and lifecycle listeners.
    vite.middlewares.use('/__desktop_privacy', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});

let browser;
const errors = [];
const results = process.env.QUIET_ROOM_TEST_TRACE ? new Proxy({}, {
  set(target, key, value) { target[key] = value; console.log(`PASS ${String(key)}`); return true; },
}) : {};
const idleDuration = 30 * 60_000;
try {
  await server.listen();
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const url = `http://localhost:${server.httpServer.address().port}/__desktop_privacy`;
  const createPage = async (options = {}, standalone = false, touchPoints) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...options });
    page.on('pageerror', error => errors.push(error.message));
    if (touchPoints !== undefined) await page.addInitScript(value => {
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value });
    }, touchPoints);
    if (standalone) await page.addInitScript(() => {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => query.includes('display-mode') && query.includes('standalone')
        ? { matches: true, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }
        : matchMedia(query);
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    });
    await page.clock.install({ time: new Date('2026-09-04T02:00:00Z') });
    await page.clock.pauseAt(new Date('2026-09-04T02:00:01Z'));
    await page.goto(url);
    await page.evaluate(async () => {
      await import('/src/styles.css');
      await import('/src/cover.css');
      const { QuietRoomApp } = await import('/src/app.ts');
      const { createVault } = await import('/src/lib/vault.ts');
      const root = document.querySelector('#app');
      const app = new QuietRoomApp(root);
      const own = { deviceId: 'privacy-own', role: 'creator', status: 'active' };
      const session = await createVault({ v: 1, roomId: 'desktop-privacy', accessToken: 'test', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'desktop-privacy-passphrase', 'password');
      let focused = true;
      let hidden = false;
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      app.unreadCounter.refresh = async () => {};
      app.flushUiPreferencesSave = () => {};
      const fixture = {
        app, root, session, resumed: 0,
        focus() { focused = true; window.dispatchEvent(new Event('focus')); },
        blur() { focused = false; window.dispatchEvent(new Event('blur')); },
        visibility(value) { hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
        async fresh() {
          app.lockNow();
          hidden = false;
          focused = true;
          document.documentElement.classList.remove('privacy-obscured');
          app.session = session;
          app.privacyCovered = false;
          app.runtimeEpoch++;
          await app.openSession();
          fixture.resumed = 0;
        },
      };
      // Keep the real vault, cover, lifecycle, timers and gateway. Transport and
      // history are independent of whether the gateway requires verification.
      app.openSession = async () => {
        if (app.session?.key !== session.key || app.session.vault.roomId !== session.vault.roomId ||
            app.session.vault.identity.publicBundle.deviceId !== own.deviceId || app.privacyCovered) {
          throw Error('Gateway resumed without the authenticated session identity');
        }
        fixture.resumed++;
        app.runtimeAbort = new AbortController();
        app.resetIdleLock();
        app.activeSurface = 'chat';
        document.body.className = 'app-mode';
        root.innerHTML = '<section class="chat-shell"><textarea id="message-input"></textarea><button id="activity">活动</button></section>';
      };
      app.renderUnlock = async () => { root.innerHTML = '<section class="gateway" data-auth-required>需要设备验证</section>'; };
      window.privacyFixture = fixture;
      await app.start();
    });
    return page;
  };
  const state = page => page.evaluate(() => {
    const { app, root, resumed } = window.privacyFixture;
    return {
      desktop: app.desktopBrowser,
      covered: app.privacyCovered,
      active: !!app.session,
      retained: !!app.retainedSession,
      deadline: app.idleDeadline,
      monotonicDeadline: app.idleMonotonicDeadline,
      remaining: app.idleDeadline - Date.now(),
      chat: !!root.querySelector('.chat-shell'),
      auth: !!root.querySelector('[data-auth-required]'),
      resumed,
    };
  });
  const fresh = page => page.evaluate(() => window.privacyFixture.fresh());
  const cover = async page => {
    await fresh(page);
    await page.evaluate(() => { window.privacyFixture.blur(); window.privacyFixture.focus(); });
  };
  const holdF = async (page, duration = 2000) => {
    await page.keyboard.down('f');
    await page.clock.runFor(duration);
    await page.keyboard.up('f');
  };
  const assertCovered = async (page, retained = true) => {
    const actual = await state(page);
    assert.equal(actual.covered, true, 'Private UI must remain covered');
    assert.equal(actual.active, false, 'Covered UI must not keep an active runtime session');
    assert.equal(actual.retained, retained, 'Retained session must follow the selected lock policy');
    assert.equal(actual.chat, false, 'Covered page must not retain private chat markup');
    return actual;
  };
  const requireAuthentication = async page => {
    try { await page.locator('[data-auth-required]').waitFor({ timeout: 3000 }); }
    catch (cause) {
      const details = await page.evaluate(() => ({
        focused: document.hasFocus(), hidden: document.hidden,
        coverTimer: window.privacyFixture.app.coverTimer,
        activeElement: document.activeElement?.outerHTML,
        html: document.querySelector('#app').innerHTML,
      }));
      throw Error(`Expected authentication gateway: ${JSON.stringify({ ...await state(page), ...details })}`, { cause });
    }
  };

  const page = await createPage();
  await fresh(page);
  const initial = await state(page);
  assert.equal(initial.desktop, true);
  assert.equal(initial.remaining, idleDuration, 'Desktop idle timeout must be exactly 30 minutes');
  await page.clock.runFor(60_000);
  await page.locator('#message-input').focus();
  await page.keyboard.type('正常操作');
  assert.equal((await state(page)).remaining, idleDuration, 'Trusted activity in the active app must renew idle time');
  results.activeIdleTimeoutMinutes = 30;

  await fresh(page);
  const beforeRemoteCallUpdates = await state(page);
  await page.evaluate(() => {
    const { app } = window.privacyFixture;
    app.callView = { update() {}, destroy() {} };
    app.callController = { active: true, destroy() { app.updateCallView({ phase: 'ended' }); } };
  });
  await page.clock.runFor(60_000);
  await page.evaluate(() => {
    const { app } = window.privacyFixture;
    for (const phase of ['incoming', 'connecting', 'connected']) app.updateCallView({ phase });
    app.updateCallView({ phase: 'connected', cameraEnabled: true, connectionQuality: 'poor' });
  });
  const afterRemoteCallUpdates = await state(page);
  assert.equal(afterRemoteCallUpdates.deadline, beforeRemoteCallUpdates.deadline, 'Remote call updates must not renew the desktop idle deadline');
  assert.equal(afterRemoteCallUpdates.monotonicDeadline, beforeRemoteCallUpdates.monotonicDeadline);
  await page.clock.runFor(idleDuration - 60_000);
  await assertCovered(page, false);
  assert.equal((await state(page)).deadline, 0);
  assert.equal((await state(page)).monotonicDeadline, 0);
  results.remoteCallUpdatesDoNotExtendIdle = true;

  await cover(page);
  const coveredAt = await assertCovered(page);
  await page.keyboard.down('f');
  await page.clock.runFor(900);
  await page.keyboard.down('f'); // A trusted browser auto-repeat must not restart the hold.
  await page.clock.runFor(1099);
  await assertCovered(page);
  assert.equal((await state(page)).deadline, coveredAt.deadline, 'Cover key events must not renew idle time');
  await page.clock.runFor(1);
  await page.keyboard.up('f');
  await page.locator('.chat-shell').waitFor();
  assert.equal((await state(page)).resumed, 1, 'A full F hold must resume the retained session exactly once');
  assert.equal((await state(page)).chat, true);
  results.fHold = { milliseconds: 2000, repeatsDoNotRestart: true, resumesWithoutVerification: true };

  await cover(page);
  const corner = await page.locator('.cover-trigger').boundingBox();
  assert.ok(corner);
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.clock.runFor(999);
  await assertCovered(page);
  await page.clock.runFor(1);
  await page.mouse.up();
  await page.locator('.chat-shell').waitFor();
  assert.equal((await state(page)).resumed, 1, 'The existing corner hold must use the same retained-session gateway');
  results.cornerHoldResumes = true;

  await cover(page);
  await page.evaluate(async () => {
    const fixture = window.privacyFixture;
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    fixture.pendingVaultLease = navigator.locks.request('quiet-room:vault:current', async () => {
      acquired();
      await new Promise(resolve => { fixture.releaseVaultLease = resolve; });
    });
    await ready;
  });
  await holdF(page);
  await assertCovered(page);
  await page.evaluate(async () => {
    const fixture = window.privacyFixture;
    fixture.blur(); fixture.focus();
    fixture.releaseVaultLease();
    await fixture.pendingVaultLease;
    // The barrier queues behind the pending authenticated snapshot read.
    await navigator.locks.request('quiet-room:vault:current', () => {});
  });
  await assertCovered(page);
  assert.equal((await state(page)).resumed, 0, 'A late snapshot read must not reveal chat after another focus departure');
  await holdF(page);
  await page.locator('.chat-shell').waitFor();
  assert.equal((await state(page)).resumed, 1);
  results.pendingResumeCanceledByDeparture = true;

  for (const cancellation of ['release', 'blur', 'hidden', 'composition', 'modifier']) {
    await cover(page);
    await page.keyboard.down('f');
    await page.clock.runFor(1000);
    if (cancellation === 'release') await page.keyboard.up('f');
    else if (cancellation === 'blur') await page.evaluate(() => { window.privacyFixture.blur(); window.privacyFixture.focus(); });
    else if (cancellation === 'hidden') await page.evaluate(() => { window.privacyFixture.visibility(true); window.privacyFixture.visibility(false); });
    else if (cancellation === 'composition') await page.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionstart')));
    else await page.keyboard.down('Shift');
    await page.clock.runFor(2500);
    await page.keyboard.up('f');
    if (cancellation === 'modifier') await page.keyboard.up('Shift');
    await assertCovered(page);
    assert.equal((await state(page)).resumed, 0, `${cancellation} must cancel an F hold`);
  }
  await cover(page);
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true })));
  await page.clock.runFor(2100);
  await assertCovered(page);
  await page.evaluate(() => {
    const field = document.createElement('input');
    field.id = 'cover-input';
    document.querySelector('.cover').append(field);
    field.focus();
  });
  await holdF(page);
  await assertCovered(page);
  await fresh(page);
  await page.locator('#message-input').focus();
  await holdF(page);
  assert.equal((await state(page)).chat, true, 'Typing F in active chat must not invoke the cover gateway');
  assert.equal((await state(page)).resumed, 0);
  results.fScope = { canceledOnReleaseBlurHiddenCompositionAndModifiers: true, syntheticEventsIgnored: true, inputsIgnored: true, activeChatUnaffected: true };

  await cover(page);
  const untouched = await state(page);
  await page.clock.runFor(idleDuration - 1000);
  await page.keyboard.press('a');
  await page.mouse.click(50, 50);
  assert.equal((await state(page)).deadline, untouched.deadline, 'Cover clicks and arbitrary keys must not prolong retention');
  await page.clock.runFor(1000);
  await assertCovered(page, false);
  await holdF(page);
  await requireAuthentication(page);
  assert.equal((await state(page)).resumed, 0);
  results.idleExpiryRequiresVerification = true;

  // Delayed timers must not turn a resumed tab into a fresh session. Check both
  // clocks independently: wall time covers suspension, monotonic time clock rollback.
  for (const deadline of ['idleDeadline', 'idleMonotonicDeadline']) {
    for (const returnPath of ['focus', 'visibility', 'gateway']) {
      await cover(page);
      await page.evaluate(({ deadline, returnPath }) => {
        const { app, blur, visibility } = window.privacyFixture;
        if (returnPath === 'focus') blur();
        if (returnPath === 'visibility') visibility(true);
        window.clearTimeout(app.idleTimer);
        app.idleTimer = null;
        app[deadline] = (deadline === 'idleDeadline' ? Date.now() : performance.now()) - 1;
      }, { deadline, returnPath });
      if (returnPath === 'focus') await page.evaluate(() => window.privacyFixture.focus());
      else if (returnPath === 'visibility') await page.evaluate(() => window.privacyFixture.visibility(false));
      else await page.evaluate(() => window.privacyFixture.app.renderGateway());
      const actual = await state(page);
      assert.equal(actual.retained, false, `${returnPath} must reject an expired ${deadline} even when the timer never fired`);
      assert.equal(actual.active, false);
      assert.equal(actual.resumed, 0);
    }
  }
  await cover(page);
  await page.evaluate(() => {
    const { app } = window.privacyFixture;
    window.clearTimeout(app.idleTimer);
    app.idleTimer = null;
    app.idleDeadline = Date.now() + 1000;
  });
  await holdF(page);
  const crossedDeadline = await state(page);
  assert.equal(crossedDeadline.retained, false, 'A hold started before expiry must discard its session at completion');
  assert.equal(crossedDeadline.active, false);
  assert.equal(crossedDeadline.resumed, 0, 'A hold started before expiry must recheck its deadline on completion');
  if (crossedDeadline.covered) await holdF(page);
  await requireAuthentication(page);
  results.delayedTimersAndBothClocks = true;

  for (const boundary of ['manual', 'pagehide', 'freeze', 'bfcache']) {
    await cover(page);
    await page.evaluate(boundary => {
      if (boundary === 'manual') window.privacyFixture.app.lockNow();
      else if (boundary === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      else if (boundary === 'freeze') document.dispatchEvent(new Event('freeze'));
      else window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }, boundary);
    await assertCovered(page, false);
    await holdF(page);
    await requireAuthentication(page);
    assert.equal((await state(page)).resumed, 0, `${boundary} must discard the retained session`);
  }
  await cover(page);
  await page.reload();
  await page.evaluate(async () => {
    const { QuietRoomApp } = await import('/src/app.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    await app.start();
    if (app.session || app.retainedSession) throw Error('Refreshing restored an unlocked session');
    await app.renderGateway();
  });
  assert.ok(await page.locator('.gateway').count(), 'Refreshing must return to authentication');
  results.explicitAndPageLifecycleLocks = ['manual', 'pagehide', 'freeze', 'bfcache', 'refresh'];
  await page.close();

  const exclusions = [
    { name: 'mobile-browser', options: { viewport: { width: 390, height: 844 }, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } },
    { name: 'tablet-browser', options: { viewport: { width: 1024, height: 768 }, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } },
    { name: 'ipad-desktop-mode', options: { viewport: { width: 1024, height: 768 }, hasTouch: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' }, touchPoints: 5 },
    { name: 'standalone-pwa', options: {}, standalone: true },
  ];
  results.excludedSurfaces = [];
  for (const exclusion of exclusions) {
    const excludedPage = await createPage(exclusion.options, exclusion.standalone, exclusion.touchPoints);
    await fresh(excludedPage);
    assert.equal((await state(excludedPage)).desktop, false, `${exclusion.name} must keep the existing strict policy`);
    await excludedPage.evaluate(() => window.privacyFixture.visibility(true));
    await assertCovered(excludedPage, false);
    await excludedPage.evaluate(() => { window.privacyFixture.visibility(false); window.privacyFixture.focus(); });
    await holdF(excludedPage);
    await assertCovered(excludedPage, false);
    assert.equal((await state(excludedPage)).resumed, 0, `${exclusion.name} must not enable the desktop F shortcut`);
    if (exclusion.name === 'mobile-browser') {
      await fresh(excludedPage);
      await excludedPage.evaluate(() => {
        const { app } = window.privacyFixture;
        app.callView = { update() {}, destroy() {} };
        // Destroy emits synchronously while session cleanup is still underway.
        app.callController = { active: false, destroy() { app.updateCallView({ phase: 'ended' }); } };
        app.lockNow();
      });
      const endedCall = await assertCovered(excludedPage, false);
      assert.equal(endedCall.deadline, 0, 'Call teardown must not leave an idle deadline after mobile lock');
      assert.equal(endedCall.monotonicDeadline, 0);
      await excludedPage.clock.runFor(10 * 60_000 + 1);
      await fresh(excludedPage);
      assert.equal((await state(excludedPage)).active, true, 'An old call teardown deadline must not reject a later unlock');
      results.mobileCallCleanupClearsDeadline = true;
    }
    results.excludedSurfaces.push(exclusion.name);
    await excludedPage.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
