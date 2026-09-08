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
  await page.locator('.release-notes-panel .primary-button').click();
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

  await page.evaluate(() => window.releaseFixture.release.acceptReleaseWorkerMessage({ type: 'quiet-room-release-ready', releaseId: 'next-release' }));
  const banner = page.locator('.release-update-reminder');
  await banner.waitFor();
  const layout = await banner.evaluate(element => ({
    text: element.textContent.replace(/\s+/g, ' ').trim(),
    buttonHeight: element.querySelector('button').getBoundingClientRect().height,
  }));
  if (layout.text !== '有新版本待更新 更新' || layout.buttonHeight < 44 - 0.01) throw new Error(`Update banner is incomplete: ${JSON.stringify(layout)}`);
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({ releaseNotes: notes.length, oneTime: true, updateBanner: layout }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
