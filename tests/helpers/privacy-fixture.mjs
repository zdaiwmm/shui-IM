import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
export async function privacyFixture(options = {}) {
  const server = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'privacy-fixture', configureServer(vite) {
      vite.middlewares.use('/__privacy', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main id="app"></main>'); });
    } }] });
  await server.listen();
  const browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch()
    : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-10T02:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-10T02:00:01Z'));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__privacy`);
  await page.evaluate(async () => {
    await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
    const { QuietRoomApp } = await import('/src/app.ts');
    const { createVault } = await import('/src/lib/vault.ts');
    const app = new QuietRoomApp(document.querySelector('#app'));
    const own = { deviceId: 'privacy-own', role: 'creator', status: 'active', capabilities: ['voice-message-v1'] };
    const session = await createVault({ v: 1, roomId: 'privacy-fixture', accessToken: 'fixture', role: 'creator', protocol: 'legacy-v1', lastSeq: 0, members: [own], identity: { publicBundle: own } }, 'privacy-fixture-password', 'password');
    app.updateSafetyCode = async () => {}; app.updateBackgroundNotificationControl = async () => {};
    app.unreadCounter.refresh = async () => {}; app.flushUiPreferencesSave = () => {};
    let focused = true, hidden = false;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const focus = () => { focused = true; window.dispatchEvent(new Event('focus')); };
    const blur = () => { focused = false; window.dispatchEvent(new Event('blur')); };
    const visibility = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
    const fresh = (seconds = 60) => {
      app.lockNow(); hidden = false; focus(); localStorage.setItem('quiet-room:cover-enabled', '1');
      localStorage.setItem('quiet-room:auto-lock-seconds', String(seconds));
      app.session = session; app.privacyCovered = false; app.runtimeEpoch++;
      app.runtimeAbort = new AbortController(); app.uiPreferencesHydrated = true;
      app.uiPreferences = { recoveryReminderDismissed: true, entranceCardDismissed: true };
      document.body.className = 'app-mode'; app.renderChat(); app.resetIdleLock();
    };
    fresh(); window.fixture = { app, session, fresh, focus, blur, visibility };
  });
  return { page, errors, browser, server, close: async () => { await browser.close(); await server.close(); } };
}
