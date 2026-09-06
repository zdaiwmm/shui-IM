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
        app, root, session, resumed: 0, renderUnlock: app.renderUnlock.bind(app),
        setFocused(value) { focused = value; },
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
    assert.deepEqual(await page.evaluate(() => ({
      root: getComputedStyle(document.querySelector('#app')).visibility,
      trigger: getComputedStyle(document.querySelector('.cover-trigger')).visibility,
    })), { root: 'visible', trigger: 'visible' }, 'A rendered cover and its gesture target must become visible immediately');
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
  assert.ok(corner.width >= 80 && corner.height >= 80, 'The corner must expose the enlarged 80px target');
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x - 8, corner.y + corner.height / 2);
  await page.clock.runFor(999);
  await assertCovered(page);
  await page.clock.runFor(1);
  assert.equal(await page.locator('.cover-activation-feedback, .cover-firework').count(), 0,
    'Completing the hold must enter without decorative overlays');
  await page.locator('.chat-shell').waitFor();
  await page.mouse.up();
  assert.equal((await state(page)).resumed, 1, 'The existing corner hold must use the same retained-session gateway');
  await page.clock.runFor(1200);
  assert.equal(await page.locator('.cover-activation-feedback').count(), 0, 'Activation feedback must clean itself up');
  results.cornerHoldResumes = { target: 80, hold: 1000, immediateEntry: true, noDecorativeOverlay: true, captureKeepsSmallDrift: true, releaseAfterThresholdCommits: true };

  const cornerDown = async targetPage => {
    const box = await targetPage.locator('.cover-trigger').boundingBox();
    assert.ok(box);
    await targetPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await targetPage.mouse.down();
  };
  for (const cancellation of ['release', 'blur', 'hidden', 'manual', 'pointercancel', 'entry-epoch']) {
    await cover(page);
    await cornerDown(page);
    await page.clock.runFor(cancellation === 'release' ? 999 : 400);
    if (cancellation === 'release') await page.mouse.up();
    else if (cancellation === 'blur') await page.evaluate(() => { window.privacyFixture.blur(); window.privacyFixture.focus(); });
    else if (cancellation === 'hidden') await page.evaluate(() => { window.privacyFixture.visibility(true); window.privacyFixture.visibility(false); });
    else if (cancellation === 'manual') await page.evaluate(() => window.privacyFixture.app.lockNow());
    else if (cancellation === 'pointercancel') await page.locator('.cover-trigger').dispatchEvent('pointercancel', { pointerId: 1 });
    else await page.evaluate(() => { window.privacyFixture.app.coverEntryEpoch += 1; });
    await page.mouse.up();
    await page.clock.runFor(cancellation === 'release' ? 200 : 700);
    await assertCovered(page, cancellation !== 'manual');
    assert.equal(await page.locator('.cover-activation-feedback').count(), 0);
    assert.equal((await state(page)).resumed, 0, `${cancellation} must not leave a pending reveal`);
  }
  // Simulate iOS updating hasFocus after pointer delivery, without a window
  // focus event. A trusted primary pointer in the sole cover hot-zone is the
  // return edge; real blur/hidden still increment the entry epoch above.
  await cover(page);
  await page.evaluate(() => window.privacyFixture.setFocused(false));
  await cornerDown(page);
  await page.clock.runFor(100);
  await page.evaluate(() => window.privacyFixture.setFocused(true));
  await page.clock.runFor(1080);
  await page.mouse.up();
  await page.locator('.chat-shell').waitFor();
  assert.equal((await state(page)).resumed, 1);
  await page.clock.runFor(340);
  await cover(page);
  await page.evaluate(() => window.privacyFixture.setFocused(false));
  await cornerDown(page);
  await page.clock.runFor(1000);
  await page.locator('.chat-shell').waitFor();
  assert.equal((await state(page)).resumed, 1, 'A trusted cover pointer must not depend on the transient hasFocus value');
  assert.equal(await page.locator('.cover-activation-feedback').count(), 0);
  await page.mouse.up();
  await page.evaluate(() => window.privacyFixture.setFocused(true));
  await page.clock.runFor(520);
  // A missed focus event can leave the opaque curtain over a safe cover. The
  // corner forwards this fresh pointer only; other points leave it opaque.
  await cover(page);
  await page.evaluate(() => window.privacyFixture.app.obscurePrivacySurface());
  await page.mouse.click(40, 40);
  assert.equal(await page.locator('html.privacy-obscured').count(), 1);
  await cornerDown(page);
  await page.clock.runFor(1000);
  await page.locator('.chat-shell').waitFor();
  await page.mouse.up();
  assert.equal((await state(page)).resumed, 1);
  await page.clock.runFor(520);
  // The same curtain callback must never reveal an active private screen.
  await page.evaluate(() => window.privacyFixture.app.obscurePrivacySurface());
  await page.mouse.click(corner.x + corner.width / 2, corner.y + corner.height / 2);
  assert.equal(await page.locator('html.privacy-obscured').count(), 1);
  await page.evaluate(() => window.privacyFixture.app.revealPrivacySurface());
  await cover(page);
  await cornerDown(page);
  await page.clock.runFor(400);
  await page.evaluate(() => {
    window.privacyFixture.blur(); window.privacyFixture.focus();
    window.addEventListener('pointerup', event => event.stopImmediatePropagation(), { capture: true, once: true });
  });
  await page.mouse.up();
  await cornerDown(page);
  await page.clock.runFor(1000);
  await page.locator('.chat-shell').waitFor();
  await page.mouse.up();
  assert.equal((await state(page)).resumed, 1, 'A missed pointerup after departure must not block the next hold');
  await page.clock.runFor(520);
  const reducedPage = await createPage({ reducedMotion: 'reduce' });
  await cover(reducedPage);
  await reducedPage.evaluate(() => window.privacyFixture.setFocused(false));
  await cornerDown(reducedPage);
  assert.equal(await reducedPage.locator('.cover-trigger.is-holding').count(), 1, 'Reduced motion hold must start');
  await reducedPage.clock.runFor(1000);
  assert.equal(await reducedPage.locator('.cover-activation-feedback').count(), 0, 'Reduced motion must skip the expanding feedback');
  await reducedPage.mouse.up();
  await reducedPage.locator('.chat-shell').waitFor();
  assert.equal((await state(reducedPage)).resumed, 1, 'Reduced-motion trusted entry must not depend on a lagging hasFocus value');
  await reducedPage.close();
  results.cornerLifecycle = { canceledBeforeThreshold: true, actualDepartureRejected: true, entryEpochRejected: true, delayedFocusAccepted: true, transientMissingFocusAccepted: true, safeCurtainRecovery: true, privateCurtainUnchanged: true, missedPointerReleaseRecovered: true, reducedMotionSkipsFeedback: true };

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

  await cover(page);
  await page.evaluate(() => {
    const { app } = window.privacyFixture;
    app.retainedSession = { ...app.retainedSession, stored: { ...app.retainedSession.stored, ciphertext: 'A'.repeat(64) } };
  });
  await holdF(page);
  await requireAuthentication(page);
  assert.equal((await state(page)).resumed, 0);
  assert.equal((await state(page)).retained, false);
  results.staleRetainedSessionRequiresVerification = true;

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

  // Exercise the real modern unlock UI with a synthetic encrypted vault. Only
  // the device-verification boundary is deferred here; crypto/OS behavior has
  // its own platform-vault suite. This isolates late UI callbacks and retries.
  const unlockPage = await createPage({ viewport: { width: 390, height: 844 } });
  await unlockPage.evaluate(async () => {
    const fixture = window.privacyFixture;
    const { createVault } = await import('/src/lib/vault.ts');
    await createVault(fixture.session.vault, '', 'platform', {
      record: { credentialId: 'A'.repeat(32), prfSalt: 'B'.repeat(32), transports: ['internal'], authenticatorAttachment: 'platform', backupEligible: false, createdAt: new Date().toISOString() },
      prfOutput: new Uint8Array(32).fill(5),
    });
    fixture.attempts = [];
    fixture.unlockClickEvents = [];
    document.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('#passkey-unlock')) {
        fixture.unlockClickEvents.push(event.isTrusted);
      }
    }, { capture: true });
    fixture.app.renderUnlock = fixture.renderUnlock;
    fixture.app.withDeviceVerification = () => new Promise((resolve, reject) => fixture.attempts.push({ resolve, reject }));
    // Production reaches this state by locking an already-v3 vault. Re-render
    // the cover after this fixture replaces its initial legacy record so the
    // cover-time preparation observes the same ordering.
    fixture.app.renderCover();
  });
  await unlockPage.evaluate(async () => {
    const fixture = window.privacyFixture;
    // Let any cover-time vault snapshot finish, then hold the lifecycle lock.
    // A trusted cover completion must start WebAuthn from prepared metadata
    // instead of waiting for this lock and losing Safari user activation.
    await navigator.locks.request('quiet-room:vault:current', () => {});
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    fixture.pendingUnlockVaultLease = navigator.locks.request('quiet-room:vault:current', async () => {
      acquired();
      await new Promise(resolve => { fixture.releaseUnlockVaultLease = resolve; });
    });
    await ready;
  });
  await cornerDown(unlockPage);
  await unlockPage.clock.runFor(999);
  assert.equal(await unlockPage.evaluate(() => window.privacyFixture.attempts.length), 0);
  await unlockPage.clock.runFor(1);
  const attemptsBeforeVaultLeaseRelease = await unlockPage.evaluate(() => window.privacyFixture.attempts.length);
  await unlockPage.evaluate(async () => {
    const fixture = window.privacyFixture;
    fixture.releaseUnlockVaultLease();
    await fixture.pendingUnlockVaultLease;
  });
  assert.equal(attemptsBeforeVaultLeaseRelease, 1, 'Trusted cover completion waited for IndexedDB/lifecycle work before starting device verification');
  await unlockPage.waitForFunction(() => window.privacyFixture.attempts.length === 1);
  assert.equal(await unlockPage.locator('.cover-activation-feedback, .cover-firework').count(), 0, 'Verification must begin without decorative overlays');
  assert.deepEqual(await unlockPage.evaluate(() => window.privacyFixture.unlockClickEvents), [], 'Trusted entry must call the unlock operation directly, without button.click()');
  assert.equal(await unlockPage.locator('#passkey-unlock').isDisabled(), true, 'Entering the gateway must start device verification immediately');
  await unlockPage.mouse.up();
  await unlockPage.evaluate(() => window.privacyFixture.app.lockNow());
  assert.equal(await unlockPage.locator('.cover-activation-feedback').count(), 0, 'Explicit locking must remove in-flight activation feedback immediately');
  await cornerDown(unlockPage);
  await unlockPage.clock.runFor(1000);
  await unlockPage.waitForFunction(() => window.privacyFixture.attempts.length === 2);
  await unlockPage.mouse.up();
  await unlockPage.clock.runFor(520);
  await unlockPage.evaluate(async () => {
    const fixture = window.privacyFixture;
    fixture.attempts[0].resolve(fixture.session);
    await Promise.resolve(); await Promise.resolve();
  });
  assert.equal(await unlockPage.evaluate(() => window.privacyFixture.app.unlocking), true, 'An obsolete success must not clear the newer attempt flag');
  assert.equal((await state(unlockPage)).resumed, 0, 'An obsolete unlock must never restore private content');
  assert.equal(await unlockPage.locator('#passkey-unlock').isDisabled(), true);
  await unlockPage.evaluate(async () => {
    const { PlatformVaultCancellationError } = await import('/src/lib/platform-vault.ts');
    window.privacyFixture.attempts[1].reject(new PlatformVaultCancellationError());
    await Promise.resolve(); await Promise.resolve();
  });
  await unlockPage.waitForFunction(() => !window.privacyFixture.app.unlocking);
  assert.equal(await unlockPage.locator('#passkey-unlock').isEnabled(), true);
  assert.equal(await unlockPage.locator('.form-error').innerText(), '', 'Cancellation must not leave a red error message');
  assert.equal(await unlockPage.locator('#passkey-unlock').innerText(), '重新验证');
  await unlockPage.locator('#passkey-unlock').click();
  assert.equal(await unlockPage.evaluate(() => window.privacyFixture.attempts.length), 3, 'Canceling verification must leave a usable retry');
  assert.deepEqual(await unlockPage.evaluate(() => window.privacyFixture.unlockClickEvents), [true], 'Only the explicit retry may dispatch a button click');
  await unlockPage.evaluate(async () => {
    window.privacyFixture.attempts[2].reject(new Error('合成的非取消验证失败'));
    await Promise.resolve(); await Promise.resolve();
  });
  await unlockPage.waitForFunction(() => !window.privacyFixture.app.unlocking);
  assert.match(await unlockPage.locator('.form-error').innerText(), /合成的非取消验证失败/, 'Non-cancellation failures must remain visible');
  const errorPaint = await unlockPage.locator('.form-error').evaluate(element => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.append(probe);
    const result = { actual: getComputedStyle(element).color, danger: getComputedStyle(probe).color };
    probe.remove();
    return result;
  });
  assert.equal(errorPaint.actual, errorPaint.danger, 'Non-cancellation failures must retain the danger/red treatment');
  await unlockPage.evaluate(() => window.privacyFixture.app.lockNow());

  // If cover-time preparation is unavailable, the guarded async fallback must
  // still reject storage results that cross a hidden or entry-epoch boundary.
  for (const boundary of ['entry-epoch', 'hidden']) {
    await unlockPage.evaluate(async () => {
      const fixture = window.privacyFixture;
      let acquired;
      const ready = new Promise(resolve => { acquired = resolve; });
      fixture.pendingVaultLease = navigator.locks.request('quiet-room:vault:current', async () => {
        acquired(); await new Promise(resolve => { fixture.releaseVaultLease = resolve; });
      });
      await ready;
      fixture.app.coverStoredVault = null;
      fixture.app.coverStoredVaultPreparation += 1;
    });
    await cornerDown(unlockPage);
    await unlockPage.clock.runFor(1000);
    await unlockPage.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'quiet-room:vault:current'));
    assert.equal(await unlockPage.evaluate(() => window.privacyFixture.attempts.length), 3);
    await unlockPage.evaluate(boundary => {
      const fixture = window.privacyFixture;
      if (boundary === 'hidden') fixture.visibility(true);
      else fixture.app.coverEntryEpoch += 1;
      fixture.releaseVaultLease();
    }, boundary);
    await unlockPage.evaluate(async () => {
      const fixture = window.privacyFixture;
      await fixture.pendingVaultLease;
      await navigator.locks.request('quiet-room:vault:current', () => {});
      await Promise.resolve(); await Promise.resolve();
    });
    if (boundary === 'hidden') await unlockPage.evaluate(() => { window.privacyFixture.visibility(false); window.privacyFixture.focus(); });
    await unlockPage.waitForFunction(() => window.privacyFixture.app.privacyCovered);
    await unlockPage.mouse.up();
    await assertCovered(unlockPage, false);
    assert.equal(await unlockPage.evaluate(() => window.privacyFixture.attempts.length), 3, `${boundary} must block the late fallback verification`);
  }

  await unlockPage.evaluate(async () => {
    const fixture = window.privacyFixture;
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    fixture.pendingVaultLease = navigator.locks.request('quiet-room:vault:current', async () => {
      acquired(); await new Promise(resolve => { fixture.releaseVaultLease = resolve; });
    });
    await ready;
    fixture.app.privacyCovered = false;
    fixture.pendingUnlockRender = fixture.app.renderUnlock();
    fixture.app.lockNow();
    fixture.app.privacyCovered = false;
    fixture.newUnlockRender = fixture.app.renderUnlock();
    fixture.releaseVaultLease();
    await fixture.pendingVaultLease;
    await Promise.all([fixture.pendingUnlockRender, fixture.newUnlockRender]);
  });
  assert.equal(await unlockPage.evaluate(() => window.privacyFixture.attempts.length), 3, 'A stale storage read must not render or auto-start an extra verification');
  await unlockPage.evaluate(() => window.privacyFixture.app.lockNow());
  for (const entry of ['renderUnlock', 'renderGateway']) {
    await unlockPage.evaluate(async entry => {
      const fixture = window.privacyFixture;
      let acquired;
      const ready = new Promise(resolve => { acquired = resolve; });
      fixture.pendingVaultLease = navigator.locks.request('quiet-room:vault:current', async () => {
        acquired(); await new Promise(resolve => { fixture.releaseVaultLease = resolve; });
      });
      await ready;
      fixture.app.privacyCovered = false;
      fixture.pendingEntry = fixture.app[entry]();
      fixture.blur(); fixture.focus();
      fixture.releaseVaultLease();
      await fixture.pendingVaultLease;
      await fixture.pendingEntry;
    }, entry);
    await assertCovered(unlockPage, false);
    assert.equal(await unlockPage.evaluate(() => window.privacyFixture.attempts.length), 3, 'A focus departure during storage reads must prevent automatic verification');
  }
  results.modernUnlock = { startsDirectlyAtTrustedThreshold: true, startsBeforeLifecycleLock: true, noProgrammaticButtonClick: true, noDecorativeOverlay: true, lateSuccessIgnored: true, newerBusyStateRetained: true, cancellationSilentRetry: true, otherErrorsVisible: true, fallbackReadStillChecksHiddenAndEntryEpoch: true, staleStorageReadIgnored: true, storageReadDepartureCovered: true };
  await unlockPage.close();

  // Keep the real gateway, withDeviceVerification and platform-vault code.
  // Only the native authenticator is deferred, so this observes the actual
  // navigator.credentials.get options and request lifetime across teardown.
  const pendingPage = await createPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const touchDriver = browser.browserType().name() === 'chromium'
    ? await pendingPage.context().newCDPSession(pendingPage) : null;
  await pendingPage.evaluate(async () => {
    const fixture = window.privacyFixture;
    const { createVault } = await import('/src/lib/vault.ts');
    await createVault(fixture.session.vault, '', 'platform', {
      record: { credentialId: 'A'.repeat(32), prfSalt: 'B'.repeat(32), transports: ['internal'], authenticatorAttachment: 'platform', backupEligible: false, createdAt: new Date().toISOString() },
      prfOutput: new Uint8Array(32).fill(5),
    });
    fixture.app.renderUnlock = fixture.renderUnlock;
    fixture.nativeRequests = [];
    fixture.coverTouchDefaultPrevented = [];
    document.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch' && event.target.matches?.('.cover-trigger')) {
        fixture.coverTouchDefaultPrevented.push(event.defaultPrevented);
      }
    });
    const nativeFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      nativeFocus.apply(this, args);
      if (this.id === 'passkey-unlock' && fixture.focusMode) {
        if (fixture.focusMode === 'sync') fixture.focus();
        else if (fixture.focusMode === 'delayed') setTimeout(() => fixture.setFocused(true), 48);
        else fixture.setFocused(true);
      }
    };
    // WebKit may return a fresh CredentialsContainer wrapper per property
    // read; install a stable native boundary instead of patching one wrapper.
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: options => {
      const request = { signal: options.signal, pending: true };
      fixture.nativeRequests.push(request);
      return new Promise((resolve, reject) => {
        request.cancel = () => { request.pending = false; reject(new DOMException('Synthetic cancellation', 'NotAllowedError')); };
        const abort = () => { request.pending = false; reject(new DOMException('Synthetic abort', 'AbortError')); };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    } } });
    fixture.app.renderCover();
  });
  for (const boundary of ['lock', 'pagehide', 'freeze', 'timeout']) {
    await pendingPage.evaluate(async () => {
      const fixture = window.privacyFixture;
      fixture.app.lockNow();
      fixture.visibility(false); fixture.focus();
      await navigator.locks.request('quiet-room:vault:current', () => {});
    });
    const before = await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length);
    if (touchDriver) {
      const bounds = await pendingPage.locator('.cover-trigger').boundingBox();
      await touchDriver.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
      });
    } else await cornerDown(pendingPage);
    await pendingPage.clock.runFor(1000);
    if (touchDriver) await touchDriver.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else await pendingPage.mouse.up();
    assert.equal(await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length), before + 1,
      JSON.stringify(await pendingPage.evaluate(() => ({
        secure: window.isSecureContext, credentialAPI: typeof window.PublicKeyCredential,
        gateway: document.querySelector('.gateway')?.textContent,
        covered: window.privacyFixture.app.privacyCovered,
      }))));
    await pendingPage.clock.runFor(5000);
    assert.equal(await pendingPage.locator('#passkey-unlock').isDisabled(), true, 'A slow native request must remain single-flight');
    assert.equal(await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.filter(request => request.pending).length), 1,
      'Repeated gateway entry must not retain an abandoned native request');
    if (boundary === 'timeout') await pendingPage.clock.runFor(60_000);
    else await pendingPage.evaluate(boundary => {
      if (boundary === 'lock') window.privacyFixture.app.lockNow();
      else if (boundary === 'freeze') document.dispatchEvent(new Event('freeze'));
      else window.dispatchEvent(new Event(boundary));
    }, boundary);
    assert.equal(await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.at(-1).pending), false,
      `${boundary} abandoned the gateway but left navigator.credentials.get pending`);
    await assertCovered(pendingPage, false);
  }
  results.nativeRequestLifetime = {
    pointerInput: touchDriver ? 'trusted-touch' : 'mouse',
    slowRequestSingleFlight: true, abandonedRequestsAborted: true,
  };
  if (touchDriver) {
    assert.deepEqual(await pendingPage.evaluate(() => window.privacyFixture.coverTouchDefaultPrevented), [false, false, false, false],
      'The touch corner must retain the browser default focus path');
  }
  for (const departure of ['none', 'hidden', 'lock', 'pagehide', 'freeze']) {
    await pendingPage.evaluate(async () => {
      const fixture = window.privacyFixture;
      fixture.app.lockNow(); fixture.visibility(false); fixture.setFocused(false);
      await navigator.locks.request('quiet-room:vault:current', () => {});
    });
    const before = await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length);
    await cornerDown(pendingPage);
    await pendingPage.clock.runFor(1000);
    assert.equal(await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length), before,
      'A visible but unfocused gateway must not call WebAuthn and enter the 250ms rejection loop');
    assert.equal(await pendingPage.locator('#passkey-unlock').isDisabled(), false, 'Focus recovery must retain a usable button');
    await pendingPage.clock.runFor(5000);
    assert.equal(await pendingPage.locator('.gateway').count(), 1);
    await pendingPage.mouse.up();
    if (departure !== 'none') {
      await pendingPage.evaluate(departure => {
        const fixture = window.privacyFixture;
        if (departure === 'hidden') fixture.visibility(true);
        else if (departure === 'lock') fixture.app.lockNow();
        else if (departure === 'freeze') document.dispatchEvent(new Event('freeze'));
        else window.dispatchEvent(new Event('pagehide'));
      }, departure);
      await assertCovered(pendingPage, false);
    }
    await pendingPage.evaluate(() => { window.privacyFixture.visibility(false); window.privacyFixture.focus(); });
    await pendingPage.clock.runFor(30);
    assert.equal(await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length), before + (departure === 'none' ? 1 : 0),
      'Focus return must start one live entry only, never an abandoned gateway');
    if (departure === 'none') {
      await pendingPage.evaluate(() => window.privacyFixture.focus());
      assert.equal(await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length), before + 1);
      await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.at(-1).cancel());
      await pendingPage.clock.runFor(1);
      assert.equal(await pendingPage.locator('#passkey-unlock').isDisabled(), false);
      assert.equal(await pendingPage.locator('#passkey-unlock').textContent(), '重新验证');
    }
  }
  results.gatewayFocusRecovery = { noUnfocusedNativeRequest: true, usableWhileWaiting: true, focusedReturnStartsOnce: true, silentFocusTransitionStartsOnce: true, abandonedWaitIgnored: true };
  for (const mode of ['sync', 'silent', 'delayed']) {
    await pendingPage.evaluate(async mode => {
      const fixture = window.privacyFixture;
      fixture.app.lockNow(); fixture.visibility(false); fixture.setFocused(false);
      fixture.focusMode = mode;
      await navigator.locks.request('quiet-room:vault:current', () => {});
    }, mode);
    const before = await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length);
    await cornerDown(pendingPage);
    await pendingPage.clock.runFor(1000);
    await pendingPage.mouse.up();
    if (mode === 'delayed') await pendingPage.clock.runFor(64);
    assert.equal(await pendingPage.evaluate(() => window.privacyFixture.nativeRequests.length), before + 1,
      `${mode} focus recovery must start exactly one native request`);
    assert.equal(await pendingPage.locator('#passkey-unlock').isDisabled(), true);
  }
  await pendingPage.evaluate(() => window.privacyFixture.app.lockNow());
  await pendingPage.close();

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
