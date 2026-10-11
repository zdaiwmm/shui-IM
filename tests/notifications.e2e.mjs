import { auditP1Surface } from './helpers/p1-surface-audit.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-notifications-'));
let service, vite, browser;
try {
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true, pushService: { enabled: true, publicKey: 'A'.repeat(87), allowedHosts: ['push.example.test'], wake: async () => ({ delivered: true }) } });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${service.port}` } }, plugins: [{ name: 'notification-fixture', configureServer(server) { server.middlewares.use('/__notifications', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>'); }); } }] });
  await vite.listen();
  const url = `http://localhost:${vite.httpServer.address().port}/__notifications`;
  for (const engine of [chromium, webkit]) {
    browser = await engine.launch(engine === chromium && !process.env.CI ? process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' } : {});
    const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    if (engine === chromium) {
      const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
    }
    await page.goto(url);
    await page.evaluate(async mode => {
      await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
      (await import('/src/lib/appearance.ts')).mountAppearance();
      document.body.className = 'app-mode';
      window.permission = 'default'; window.prompts = 0; window.unsubscribed = 0; window.subscribeCount = 0; window.endpoint = null;
      const subscription = () => ({ endpoint, toJSON: () => ({ endpoint, keys: { p256dh: 'A'.repeat(43), auth: 'B'.repeat(22) } }), unsubscribe: async () => { unsubscribed++; endpoint = null; return true; } });
      Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return window.permission; }, requestPermission() { prompts++; if (window.deferPermission) return new Promise(resolve => { window.releasePermission = () => { permission = 'granted'; resolve('granted'); }; }); permission = window.deny ? 'denied' : 'granted'; return Promise.resolve(permission); } } });
      Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => endpoint ? subscription() : null, subscribe: async () => { subscribeCount++; endpoint = 'https://push.example.test/' + crypto.randomUUID(); return subscription(); } }, getNotifications: async () => [] }) } });
      const { generateIdentity } = await import('/src/lib/crypto.ts'); const { createRoom } = await import('/src/lib/api.ts'); const { randomBase64Url } = await import('/src/lib/base64.ts');
      const make = async () => { const identity = await generateIdentity(), accessToken = randomBase64Url(32); const room = await createRoom(identity.publicBundle, accessToken, randomBase64Url(32), '本机', []); return { v: 3, roomId: room.roomId, accessToken, role: 'creator', pairingSecret: '', creatorFingerprint: 'f'.repeat(43), identity, members: [{ ...identity.publicBundle, role: 'creator', status: 'active' }], lastSeq: 0, createdAt: room.createdAt, protocol: 'legacy-v1', pairingState: 'ready', recoveryExperience: { completed: 'created', coverEnabled: false } }; };
      window.aVault = await make(); window.bVault = await make();
      window.np = await import('/src/lib/notification-policy.ts');
      if (mode === 'chromium') {
        window.v = await import('/src/lib/vault.ts'); window.sp = await import('/src/lib/spaces.ts');
        window.a = await v.createVault(aVault); await sp.rememberLocalSpace(a, undefined, { roomId: a.vault.roomId, name: '林间' });
        window.credential = v.cloneDeviceCredential(a);
        await v.selectLocalSpace(crypto.randomUUID()); window.b = await v.createVault({ ...bVault, spaceRecoveryCode: a.vault.spaceRecoveryCode }, '', 'platform', { ...credential, prfOutput: credential.prfOutput.slice() });
        await sp.rememberLocalSpace(b, undefined, { roomId: b.vault.roomId, name: '海边' }); await v.selectLocalSpace(v.vaultSpaceId(a.stored));
        const { QuietRoomApp } = await import('/src/app.ts'); window.app = new QuietRoomApp(document.querySelector('#app'));
        app.session = a; app.deviceCredential = v.cloneDeviceCredential(a); app.runtimeAbort = new AbortController(); app.privacyCovered = false;
        app.rememberSpacePreview = async () => {}; app.refreshOtherSpacePreviews = async () => {}; app.updatePeerStatus = () => {};
        document.querySelector('#app').innerHTML = '<section class="chat-shell"><button id="open-spaces">空间</button></section>';
        await app.openPrivateSpaces();
      } else {
        const { DeviceNotifications } = await import('/src/lib/device-notifications.ts'); const { mountNotificationSettings } = await import('/src/lib/notification-settings.ts');
        window.abort = new AbortController(); const spaces = [{ roomId: aVault.roomId, name: '林间' }, { roomId: bVault.roomId, name: '海边' }];
        document.querySelector('#app').innerHTML = '<section class="device-shell notification-page"><header class="subpage-header device-header"><div><h1>通知</h1></div></header><main class="device-content notification-content"></main></section>';
        mountNotificationSettings(document.querySelector('main'), new DeviceNotifications(spaces, async (id, _verify, action) => action(id === aVault.roomId ? aVault : bVault), abort.signal), { systemSurface: operation => operation() });
      }
    }, engine.name());
    if (engine === chromium) { await page.locator('#space-settings').click(); await page.locator('#notification-settings').click(); }
    const master = page.locator('#notification-master');
    await page.waitForFunction(() => document.querySelector('#notification-status')?.textContent === '本机支持通知');
    assert.equal(await page.evaluate(() => prompts), 0);
    assert.equal(await page.locator('[data-notification-space]').count(), 2);
    assert.equal(await page.locator('button').filter({ hasText: '测试通知' }).count(), 0);
    await master.click(); await page.waitForFunction(() => document.querySelector('#notification-master').getAttribute('aria-checked') === 'true' && !document.querySelector('#notification-master').disabled);
    assert.equal(await page.evaluate(() => prompts), 1);
    const first = page.locator('[data-notification-space]').nth(0), second = page.locator('[data-notification-space]').nth(1);
    assert.equal(await first.getAttribute('aria-checked'), 'true'); assert.equal(await second.getAttribute('aria-checked'), 'true');
    await second.click(); await page.waitForFunction(() => document.querySelectorAll('[data-notification-space]')[1].getAttribute('aria-checked') === 'false' && !document.querySelector('#notification-master').disabled);
    await auditP1Surface(page,`notifications-${engine.name()}`,'.notification-page');
    assert.equal(await page.evaluate(() => unsubscribed), 0);
    assert.equal(await first.getAttribute('aria-checked'), 'true');
    await master.click(); await page.waitForFunction(() => document.querySelector('#notification-master').getAttribute('aria-checked') === 'false' && !document.querySelector('#notification-master').disabled);
    assert.equal(await second.isDisabled(), true); assert.equal(await second.getAttribute('aria-checked'), 'false');
    await master.click(); await page.waitForFunction(() => document.querySelector('#notification-master').getAttribute('aria-checked') === 'true' && !document.querySelector('#notification-master').disabled);
    assert.equal(await second.getAttribute('aria-checked'), 'false'); assert.equal(await page.evaluate(() => prompts), 1);
    // A failed server acknowledgement must not claim the selected space is on.
    await page.route('**/push/**', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }) : route.continue());
    await second.click(); await page.waitForFunction(() => document.querySelector('.notification-feedback')?.textContent.includes('暂不可用') && !document.querySelector('#notification-master').disabled);
    assert.equal(await second.getAttribute('aria-checked'), 'false'); assert.equal(await first.getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => unsubscribed), 1);
    await page.unroute('**/push/**');
    for (const [width, height, colorScheme] of [[320, 480, 'light'], [393, 520, 'dark'], [1280, 800, 'light']]) {
      await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.waitForFunction(() => { const el = document.querySelector('.notification-page'), r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height <= innerHeight && el.scrollWidth <= el.clientWidth; });
      const geometry = await page.locator('.notification-page').evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height, innerWidth, innerHeight, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; });
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.innerWidth && geometry.height <= geometry.innerHeight && geometry.scrollWidth <= geometry.clientWidth, JSON.stringify({ width, height, ...geometry }));
      await master.focus(); assert.equal(await master.evaluate(el => document.activeElement === el), true);
      if (process.env.NOTIFICATION_SCREENSHOTS) { await mkdir(process.env.NOTIFICATION_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.NOTIFICATION_SCREENSHOTS, `${engine.name()}-${width}-${colorScheme}.png`) }); }
    }
    await page.setViewportSize({ width: 393, height: 852 });
    await page.evaluate(() => { permission = 'denied'; }); await page.locator('.notification-refresh').click();
    await page.waitForFunction(() => document.querySelector('#notification-status')?.textContent === '系统已阻止通知' && !document.querySelector('.notification-refresh').disabled);
    assert.equal(await master.isDisabled(), false, 'a blocked device can still turn off its master');
    await master.click(); await page.waitForFunction(() => document.querySelector('#notification-master').getAttribute('aria-checked') === 'false' && !document.querySelector('.notification-refresh').disabled);
    assert.equal(await master.isDisabled(), true);
    await page.evaluate(() => { permission = 'default'; }); await page.locator('.notification-refresh').click();
    await page.waitForFunction(() => !document.querySelector('#notification-master').disabled);
    await page.route('**/api/push/public-key', route => route.fulfill({ contentType: 'application/json', body: '{"enabled":false,"publicKey":null}' }));
    await page.locator('.notification-refresh').click(); await page.waitForFunction(() => document.querySelector('#notification-status')?.textContent === '通知服务暂不可用' && !document.querySelector('.notification-refresh').disabled);
    assert.equal(await master.isDisabled(), true);
    await page.unroute('**/api/push/public-key');
    await page.route('**/api/push/public-key', route => route.abort());
    await page.locator('.notification-refresh').click(); await page.waitForFunction(() => document.querySelector('#notification-status')?.textContent === '暂时无法确认' && !document.querySelector('.notification-refresh').disabled);
    await page.unroute('**/api/push/public-key');
    await page.evaluate(() => { window.originalUserAgent = navigator.userAgent; Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' }); });
    await page.locator('.notification-refresh').click(); await page.waitForFunction(() => document.querySelector('#notification-status')?.textContent === '添加到主屏幕后可用' && !document.querySelector('.notification-refresh').disabled);
    assert.equal(await master.isDisabled(), true);
    await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent }); });
    await page.locator('.notification-refresh').click(); await page.waitForFunction(() => !document.querySelector('#notification-master').disabled);
    if (engine === chromium) {
      // Exercise the actual app entry, shared transition and return path.
      await page.locator('#notification-copy-entry').click();
      await page.waitForFunction(() => !document.querySelector('#notification-copy-title')?.disabled);
      await page.locator('#notification-copy-title').fill('本机提醒');
      await page.locator('#notification-copy-save').click();
      await page.waitForFunction(() => document.querySelector('.notification-copy-feedback')?.textContent === '已保存');
      await page.locator('#notification-copy-back').click();
      await page.waitForFunction(() => document.querySelector('[data-notification-copy-summary]')?.textContent.includes('本机提醒'));
    }
    // A late native permission result cannot enable notifications after the runtime ends.
    await page.evaluate(() => { deferPermission = true; }); await master.click();
    await page.waitForFunction(() => !!window.releasePermission);
    await page.evaluate(mode => { mode === 'chromium' ? app.runtimeAbort.abort() : abort.abort(); releasePermission(); }, engine.name());
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => np.readNotificationPolicy().enabled), false);
    assert.equal(await page.evaluate(async () => (await (await caches.open(np.NOTIFICATION_POLICY_CACHE)).match(np.NOTIFICATION_POLICY_URL)).text()), 'off');
    if (engine === chromium) assert.equal(await page.evaluate(() => v.currentSpaceId() === v.vaultSpaceId(a.stored)), true);
    // Direct component coverage also runs in WebKit; no physical iPhone is simulated by this fixture.
    await page.evaluate(async () => {
      window.copyAbort = new AbortController(); window.copyBack = 0;
      window.copyModule = await import('/src/lib/notification-copy-ui.ts');
      window.mountCopy = () => copyModule.mountNotificationCopy(document.querySelector('#app'), { signal: copyAbort.signal, isActive: () => true, backIcon: '‹', onBack: () => { copyBack++; } });
      mountCopy();
    });
    const titleInput = page.locator('#notification-copy-title'), bodyInput = page.locator('#notification-copy-body'), saveCopy = page.locator('#notification-copy-save');
    await page.waitForFunction(() => !document.querySelector('#notification-copy-title').disabled);
    assert.equal(await page.locator('[data-copy-paused]').isVisible(), true);
    await titleInput.fill('<img src=x onerror=alert(1)>');
    assert.equal(await saveCopy.isDisabled(), true, 'overlong draft stays editable but cannot save');
    await titleInput.fill('<b>提醒</b>'); await bodyInput.fill('稍后查看');
    assert.equal(await page.locator('[data-copy-title]').innerText(), '<b>提醒</b>');
    assert.equal(await page.locator('.notification-copy-text b').count(), 0);
    await page.locator('#notification-copy-back').click();
    await page.locator('[data-continue]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-continue]') === document.activeElement);
    assert.equal(await page.locator('.notification-copy-page').evaluate(el => el.inert), true);
    await page.locator('[data-continue]').click();
    await page.locator('.notification-copy-discard').waitFor({ state: 'detached' });
    assert.equal(await titleInput.inputValue(), '<b>提醒</b>');
    await page.evaluate(() => { window.originalCacheOpen = caches.open.bind(caches); caches.open = async () => { throw new Error('quota fixture'); }; });
    await saveCopy.click();
    await page.waitForFunction(() => document.querySelector('.notification-copy-feedback').textContent.includes('保存失败'));
    assert.equal(await bodyInput.inputValue(), '稍后查看');
    await page.evaluate(() => { caches.open = originalCacheOpen; });
    await saveCopy.click();
    await page.waitForFunction(() => document.querySelector('.notification-copy-feedback').textContent === '已保存');
    assert.equal(await page.evaluate(async () => (await (await caches.open(np.NOTIFICATION_POLICY_CACHE)).match(np.NOTIFICATION_POLICY_URL)).text()), 'off');
    await page.evaluate(() => { copyAbort.abort('navigation'); copyAbort = new AbortController(); mountCopy(); });
    await page.waitForFunction(() => !document.querySelector('#notification-copy-title').disabled);
    assert.equal(await titleInput.inputValue(), '<b>提醒</b>');
    for (const [width, height, colorScheme] of [[320, 480, 'light'], [393, 520, 'dark'], [1280, 800, 'light']]) {
      await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.locator('summary').click();
      const geometry = await page.locator('.notification-copy-page').evaluate(el => { const r = el.getBoundingClientRect(), main = el.querySelector('main'), card = el.querySelector('figure'); return { left: r.left, right: r.right, height: r.height, innerWidth, innerHeight, overflow: el.scrollWidth > el.clientWidth, scrolling: main.scrollHeight > main.clientHeight, image: card.querySelector('img').naturalWidth, ratio: card.clientWidth / card.clientHeight }; });
      assert.ok(geometry.left >= 0 && geometry.right <= geometry.innerWidth && geometry.height <= geometry.innerHeight && !geometry.overflow, JSON.stringify(geometry));
      assert.equal(geometry.image, 722); assert.ok(Math.abs(geometry.ratio - 4.6) < .1);
      if (width < 400) assert.equal(geometry.scrolling, true);
      await page.locator('#notification-copy-reset').scrollIntoViewIfNeeded();
      if (process.env.NOTIFICATION_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.NOTIFICATION_SCREENSHOTS, `${engine.name()}-copy-${width}-${colorScheme}.png`) });
    }
    await page.locator('#notification-copy-reset').click();
    await saveCopy.click(); await page.waitForFunction(() => document.querySelector('.notification-copy-feedback').textContent === '已保存');
    assert.equal(await titleInput.inputValue(), 'Quiet Room');
    assert.equal(await page.locator('.notification-copy-text').isVisible(), false, 'default uses the unchanged cropped source pixels');
    await page.setViewportSize({ width: 393, height: 852 }); await page.emulateMedia({ colorScheme: 'light' });
    if (await page.locator('details').evaluate(el => el.open)) await page.locator('summary').click();
    await titleInput.scrollIntoViewIfNeeded();
    if (process.env.NOTIFICATION_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.NOTIFICATION_SCREENSHOTS, `${engine.name()}-copy-default.png`) });
    await titleInput.fill('未保存'); await page.locator('#notification-copy-back').click();
    await page.locator('[data-discard]').click(); assert.equal(await page.evaluate(() => copyBack), 1);
    await titleInput.fill('隐私草稿'); await page.evaluate(() => copyAbort.abort());
    assert.equal(await titleInput.inputValue(), '');
    const prototype = await context.newPage();
    // The custom Vite fixture has no HTML fallback; load the exact standalone artifact.
    await prototype.setContent(await readFile(new URL('../docs/requirements/2026-10-08-device-notifications/prototype/index.html', import.meta.url), 'utf8'));
    assert.equal(await prototype.locator('#status').innerText(), '本机支持通知');
    await prototype.locator('#master').click(); assert.equal(await prototype.locator('#master').getAttribute('aria-checked'), 'true');
    await prototype.locator('#master').click(); await prototype.locator('#scenario').selectOption('blocked');
    assert.equal(await prototype.locator('#master').isDisabled(), true); assert.equal(await prototype.locator('#spaces [role=switch]').count(), 3);
    assert.equal((await prototype.locator('body').innerText()).includes('备份'), false);
    await prototype.close();
    console.log(`PASS notifications ${engine.name()}: unified device/space switches, server confirmation, opt-out isolation, permission denial/cancellation, responsive light/dark UI`);
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
