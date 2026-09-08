import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({
  configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  plugins: [{ name: 'release-update-fixture', configureServer(vite) {
    vite.middlewares.use('/__release_update', (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div></body></html>');
    });
  } }],
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/__release_update`);
  await page.evaluate(async () => {
    localStorage.setItem('quiet-room.current-release', 'previous-release');
    await import('/src/styles.css');
    await import('/src/chat-layout.css');
    const [{ QuietRoomApp }, vault, release] = await Promise.all([
      import('/src/app.ts'),
      import('/src/lib/vault.ts'),
      import('/src/lib/release-update.ts'),
    ]);
    const member = { deviceId: 'release-own', role: 'creator', status: 'active' };
    const session = await vault.createVault({
      v: 1, roomId: 'release-room', accessToken: 'test', role: 'creator', protocol: 'legacy-v1', lastSeq: 0,
      members: [member, { deviceId: 'release-peer', role: 'joiner', status: 'active' }], identity: { publicBundle: member },
    }, 'release-update-passphrase', 'password');
    const app = new QuietRoomApp(document.querySelector('#app'));
    app.session = session;
    app.privacyCovered = false;
    app.runtimeEpoch += 1;
    app.runtimeAbort = new AbortController();
    app.uiPreferencesHydrated = true;
    app.updateSafetyCode = async () => {};
    app.updateBackgroundNotificationControl = async () => {};
    app.renderChat();
    window.releaseFixture = { app, release };
  });

  await page.locator('.release-notes-sheet.is-visible').waitFor();
  const notes = await page.locator('.release-notes-panel li').allTextContents();
  const expectedNotes = await page.evaluate(async () => {
    const history = (await import('/release-history.json')).default;
    return [...new Set([...history.flatMap(item => item.notes), ...window.releaseFixture.release.currentRelease.notes])];
  });
  if (!notes.length || JSON.stringify(notes) !== JSON.stringify(expectedNotes) || notes.some(note => !note.trim())) {
    throw new Error(`Release notes were not rendered as the manifest's ordered list: ${JSON.stringify({ notes, expectedNotes })}`);
  }
  await page.getByRole('button', { name: '关闭更新说明' }).click();
  await page.locator('.release-notes-sheet').waitFor({ state: 'detached' });
  const seen = await page.evaluate(() => {
    window.releaseFixture.app.renderChat();
    return {
      stored: localStorage.getItem('quiet-room.seen-release-notes'),
      current: window.releaseFixture.release.currentRelease.id,
      repeated: Boolean(document.querySelector('.release-notes-sheet')),
    };
  });
  if (seen.stored !== seen.current || seen.repeated) throw new Error(`Release notes did not remain one-time: ${JSON.stringify(seen)}`);
  await page.getByLabel('更多操作').click();
  await page.locator('#release-history').click();
  await page.locator('.release-history-content h2').first().waitFor();
  const versions = await page.locator('.release-history-content h2').allTextContents();
  if (JSON.stringify(versions) !== JSON.stringify(await page.evaluate(() => window.releaseFixture.release.releaseLog.map(item => item.id)))) throw new Error('Release log order mismatch');
  await page.getByRole('button', { name: '返回聊天' }).click();
  await page.locator('.chat-shell:not(.is-page-outgoing)').waitFor();

  await page.evaluate(() => window.releaseFixture.release.acceptReleaseWorkerMessage({ type: 'quiet-room-release-ready', releaseId: 'next-release' }));
  const banner = page.locator('.release-update-reminder');
  await banner.waitFor();
  const layout = await banner.evaluate(element => ({
    text: element.textContent.replace(/\s+/g, ' ').trim(),
    buttonHeight: element.querySelector('button').getBoundingClientRect().height,
  }));
  if (layout.text !== '有新版本待更新 更新' || layout.buttonHeight < 44 - 0.01) throw new Error(`Update banner is incomplete: ${JSON.stringify(layout)}`);
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  await page.evaluate(async () => {
    const { mountPortraitOrientation } = await import('/src/lib/portrait-orientation.ts');
    const nativeMatch = window.matchMedia;
    const mobile = new EventTarget(); mobile.matches = true;
    window.matchMedia = query => query === '(pointer: coarse)' ? mobile : nativeMatch(query);
    Object.defineProperty(screen.orientation, 'type', { configurable: true, value: 'portrait-primary' });
    const root = document.querySelector('#app'), dispose = mountPortraitOrientation(root);
    let reads = 0; const presence = [];
    window.releaseFixture.app.socket = { setChatPresence: value => presence.push(value) };
    const originalRead = window.releaseFixture.app.unreadCounter.markRead;
    window.releaseFixture.app.unreadCounter.markRead = () => { reads++; return Promise.resolve(); };
    if (root.inert) throw Error('Portrait unexpectedly blocked');
    Object.defineProperty(screen.orientation, 'type', { configurable: true, value: 'landscape-primary' });
    screen.orientation.dispatchEvent(new Event('change'));
    if (root.inert) throw Error('Contradictory emulated orientation blocked portrait');
    Object.defineProperty(screen, 'width', { configurable: true, value: 844 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 390 });
    screen.orientation.dispatchEvent(new Event('change'));
    if (!root.inert || document.querySelector('.portrait-orientation-guard').hidden) throw Error('Landscape remained interactive');
    window.releaseFixture.app.updateCallView({ phase: 'idle' });
    if (!root.inert) throw Error('Call dismissal bypassed landscape protection');
    window.releaseFixture.app.markVisibleMessagesRead();
    if (reads || presence.at(-1) !== false) throw Error('Landscape advertised readable chat');
    Object.defineProperty(screen.orientation, 'type', { configurable: true, value: 'portrait-primary' });
    Object.defineProperty(screen, 'width', { configurable: true, value: 390 });
    Object.defineProperty(screen, 'height', { configurable: true, value: 844 });
    screen.orientation.dispatchEvent(new Event('change'));
    if (root.inert || !document.querySelector('.portrait-orientation-guard').hidden) throw Error('Portrait failed to restore');
    dispose(); window.matchMedia = nativeMatch;
    window.releaseFixture.app.socket = null;
    window.releaseFixture.app.unreadCounter.markRead = originalRead;
  });
  console.log(JSON.stringify({ releaseNotes: notes.length, oneTime: true, updateBanner: layout }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
