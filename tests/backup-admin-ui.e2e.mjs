import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';
import { makeAdminConfig, totp } from '../server/admin-auth.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'quiet-backup-ui-'));
const screenshots = process.argv[2];
let service, vite, browser;
try {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const reservation = createNetServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const password = 'synthetic-admin-browser-password';
  const config = await makeAdminConfig(password);
  service = await startServer({ port, host: '127.0.0.1', dataDir: directory, adminConfig: config, adminOrigin: `http://localhost:${port}`, quiet: true });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${port}` } },
    plugins: [{ name: 'backup-ui-fixture', configureServer(server) {
      server.middlewares.use('/__fixture', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div></html>');
      });
    } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
  await page.goto(`http://localhost:${vite.httpServer.address().port}/__fixture`);
  const roomId = await page.evaluate(async () => {
    await Promise.all(['/src/styles.css', '/src/chat-layout.css', '/src/auth-recovery.css', '/src/chat-interactions.css', '/src/cover.css', '/src/voice-messages.css', '/src/call.css'].map(file => import(file)));
    document.documentElement.dataset.colorScheme = 'light';
    const v = await import('/src/lib/vault.ts');
    const { syncCloudBackup } = await import('/src/lib/cloud-backup.ts');
    const { QuietRoomApp } = await import('/src/app.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { createRoom } = await import('/src/lib/api.ts');
    const { randomBackupSecret } = await import('/src/lib/backup-crypto.ts');
    const identity = await generateIdentity(); const token = randomBackupSecret();
    const room = await createRoom(identity.publicBundle, token);
    const session = await v.createVault({ v: 3, roomId: room.roomId, role: 'creator', accessToken: token, pairingSecret: '', creatorFingerprint: 'fixture',
      identity, members: [{ ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null }], lastSeq: 0,
      createdAt: new Date().toISOString(), protocol: 'mls-rfc9420', mls: { protocol: 'mls-rfc9420', phase: 'awaiting-peer' } });
    await syncCloudBackup(session, new AbortController().signal);
    const app = new QuietRoomApp(document.querySelector('#app')); await app.start();
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController(); app.resetIdleLock();
    document.body.className = 'app-mode'; app.renderBackupSettings(); window.fixtureApp = app;
    return room.roomId;
  });
  const snapshot = async (page, name) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name}: horizontal overflow`);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
  };
  await snapshot(page, 'backup-mobile');
  await page.getByRole('button', { name: '恢复保险箱', exact: true }).click();
  await snapshot(page, 'restore-gallery-mobile');
  await page.locator('#view-local-recovery').click();
  await page.locator('#verify-recovery-passkey').click();
  await page.locator('.local-recovery-code').waitFor();
  // Never retain even synthetic code pixels in published visual evidence.
  await page.locator('.local-recovery-code').evaluate(element => { element.textContent = 'QR3-示意恢复码，请在自己的设备上验证后查看'; });
  await snapshot(page, 'local-code-mobile');
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; admin.on('pageerror', error => errors.push(error.message));
  await admin.goto(`http://localhost:${port}`);
  await admin.getByRole('heading', { name: '登录会话管理' }).waitFor();
  await snapshot(admin, 'admin-login-desktop');
  await admin.locator('[name=password]').fill(password);
  await admin.locator('[name=code]').fill(totp(config.totpSecret));
  await admin.getByRole('button', { name: '验证并登录' }).click();
  await admin.getByRole('heading', { name: '会话管理', exact: true }).waitFor();
  await admin.getByRole('button', { name: roomId }).waitFor();
  await snapshot(admin, 'admin-rooms-desktop');
  await admin.getByRole('button', { name: roomId }).click();
  await admin.getByRole('heading', { name: '清理整个会话' }).waitFor();
  await snapshot(admin, 'admin-detail-desktop');
  await admin.setViewportSize({ width: 390, height: 844 });
  await snapshot(admin, 'admin-detail-mobile');
  await admin.getByRole('button', { name: '准备清理' }).click();
  await snapshot(admin, 'admin-cleanup-mobile');
  assert.equal(await admin.locator('[name=confirmRoomId]').getAttribute('required'), '');
  await admin.getByRole('button', { name: '退出后台' }).click();
  await admin.getByRole('heading', { name: '登录会话管理' }).waitFor();
  assert.equal((await admin.request.get(`http://localhost:${port}/admin-api/rooms`)).status(), 401);
  assert.deepEqual(errors, []);
  console.log('Backup/admin browser UI passed: fresh-passkey view, scoped restore form, real admin login, room/device/backup detail, deletion confirmation, logout and mobile overflow.');
} finally {
  await browser?.close(); await vite?.close(); await service?.close(); await rm(directory, { recursive: true, force: true });
}
