import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
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
  const snapshot = async (page, name, fullPage = true) => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name}: horizontal overflow`);
    if (screenshots) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage, animations: 'disabled' });
    }
  };
  const assertBackupSpacing = async (name) => {
    // The app scrolls inside #app. Wait for its viewport resize listener before
    // measuring, and capture the real viewport instead of the outer document.
    await page.waitForFunction(() => Math.abs(document.querySelector('#app').clientHeight - (visualViewport?.height ?? innerHeight)) <= 1);
    const geometry = await page.locator('.backup-page').evaluate(main => {
      const rect = element => element.getBoundingClientRect();
      const groups = [...main.querySelectorAll('.backup-heading, section, form')].map(group => {
        const children = [...group.children].filter(child => rect(child).height > 0);
        return children.slice(1).map((child, index) => rect(child).top - rect(children[index]).bottom);
      });
      const bounds = rect(main);
      return {
        gaps: groups.flat(),
        buttonHeights: [...main.querySelectorAll('button')].map(button => rect(button).height),
        controlsFit: [...main.querySelectorAll('button, input')].every(control => {
          const box = rect(control);
          return box.left >= bounds.left && box.right <= bounds.right;
        }),
      };
    });
    assert(geometry.gaps.every(gap => gap >= 8 && gap <= 24), `${name}: text, controls and hints need clear, consistent gaps (${geometry.gaps})`);
    assert(geometry.buttonHeights.every(height => height >= 44), `${name}: buttons retain usable touch targets`);
    assert(geometry.controlsFit, `${name}: controls stay inside the page`);
    await snapshot(page, name, false);
  };
  const assertBackupBottomReachable = async (name) => {
    const geometry = await page.locator('#app').evaluate(scroller => {
      scroller.scrollTop = scroller.scrollHeight;
      const buttons = [...scroller.querySelectorAll('.backup-actions > button')].map(button => button.getBoundingClientRect());
      return {
        atBottom: Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 1,
        controlsVisible: buttons.every(box => box.top >= 0 && box.bottom <= innerHeight),
      };
    });
    assert(geometry.atBottom, `${name}: the settings page can scroll to its bottom`);
    assert(geometry.controlsVisible, `${name}: both restore buttons are fully visible at the bottom`);
    await snapshot(page, name, false);
    await page.locator('#app').evaluate(scroller => { scroller.scrollTop = 0; });
  };
  await assertBackupSpacing('backup-mobile');
  assert.equal(await page.locator('#app').evaluate(element => element.scrollHeight <= element.clientHeight + 1), true, 'standard mobile: backup overview fits in one screen');
  await page.setViewportSize({ width: 320, height: 740 });
  await assertBackupSpacing('backup-small-mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => { document.documentElement.dataset.colorScheme = 'dark'; });
  await assertBackupSpacing('backup-desktop-dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await assertBackupSpacing('backup-mobile-dark');
  await assertBackupBottomReachable('backup-mobile-dark-bottom');
  await page.setViewportSize({ width: 320, height: 740 });
  await assertBackupSpacing('backup-small-mobile-dark');
  await assertBackupBottomReachable('backup-small-mobile-dark-bottom');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => { document.documentElement.dataset.colorScheme = 'light'; });
  await page.getByRole('button', { name: '恢复保险箱', exact: true }).click();
  await assertBackupSpacing('restore-gallery-mobile');
  await page.setViewportSize({ width: 320, height: 740 });
  await assertBackupSpacing('restore-gallery-small-mobile');
  const restoreSubmit = page.getByRole('button', { name: '验证并恢复保险箱', exact: true });
  await restoreSubmit.scrollIntoViewIfNeeded();
  assert.equal(await restoreSubmit.evaluate(button => {
    const box = button.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  }), true, 'small mobile: restore action remains reachable by scrolling');
  await snapshot(page, 'restore-gallery-small-mobile-bottom', false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#view-local-recovery').click();
  await page.locator('#verify-recovery-passkey').click();
  await page.locator('.local-recovery-code').waitFor();
  // Never retain even synthetic code pixels in published visual evidence.
  await page.locator('.local-recovery-code').evaluate(element => { element.textContent = 'QR3-示意恢复码，请在自己的设备上验证后查看'; });
  await snapshot(page, 'local-code-mobile');
  await page.evaluate(async () => {
    const app = window.fixtureApp;
    app.lockNow();
    app.privacyCovered = false;
    document.body.className = 'app-mode';
    const get = navigator.credentials.get.bind(navigator.credentials);
    Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: options => {
      Object.defineProperty(navigator.credentials, 'get', { configurable: true, value: get });
      return Promise.reject(new DOMException('验证已取消，请重试', 'NotAllowedError'));
    } });
    await app.renderUnlock();
  });
  await page.locator('#passkey-unlock').click();
  await page.getByRole('button', { name: '重新验证', exact: true }).waitFor();
  assert.equal(await page.locator('.gateway-unlock .form-error').textContent(), '', 'cancelled passkey verification left a red error message');
  assert.equal(await page.locator('.gateway-unlock button').count(), 1, 'unlock contains only the requested passkey action');
  assert.equal(await page.locator('.gateway-unlock .gateway-heading, .gateway-unlock .gateway-mark, .gateway-unlock .privacy-note').count(), 0, 'unlock decorations are removed');
  assert.equal(await page.locator('#passkey-unlock').evaluate(button => {
    const box = button.getBoundingClientRect();
    const error = document.querySelector('.gateway-unlock .form-error').getBoundingClientRect();
    return innerHeight - box.bottom >= 20 && innerHeight - box.bottom <= 32 && error.bottom <= box.top - 8;
  }), true, 'unlock button stays at the bottom and the neutral retry state cannot overlap it');
  await snapshot(page, 'unlock-minimal-cancel-mobile', false);
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
  await admin.getByRole('button', { name: '表情管理', exact: true }).click();
  await admin.getByText('暂无符合条件的资源').waitFor();
  await admin.getByText('新增与采集', { exact: true }).click();
  const library = JSON.parse(await readFile('src/lib/starter-library.json', 'utf8'));
  await admin.locator('#expression-upload [name=title]').fill('审核示例 GIF');
  await admin.locator('#expression-upload [name=tags]').fill('cat 可爱');
  await admin.locator('#expression-upload [name=files]').setInputFiles(path.join(process.cwd(), 'public', library.gifs[0].asset));
  await admin.getByRole('button', { name: '添加到待上架', exact: true }).click();
  await admin.getByText('审核示例 GIF', { exact: true }).waitFor();
  await admin.locator('.expression-thumbnail').evaluate(image => image.decode());
  await snapshot(admin, 'admin-expressions-desktop');
  await admin.getByRole('button', { name: '上架', exact: true }).click();
  await admin.getByText('已上架', { exact: true }).last().waitFor();
  await admin.getByRole('button', { name: '编辑 审核示例 GIF', exact: true }).click();
  await admin.locator('input[name=title]').fill('审核后的 GIF');
  await admin.getByRole('button', { name: '保存', exact: true }).click();
  await admin.getByText('已保存', { exact: true }).waitFor();
  await admin.setViewportSize({ width: 390, height: 844 });
  await snapshot(admin, 'admin-expression-detail-mobile');
  await admin.getByRole('button', { name: '返回资源列表', exact: true }).click();
  await admin.getByText('审核后的 GIF', { exact: true }).waitFor();
  await snapshot(admin, 'admin-expressions-mobile');
  await admin.getByRole('button', { name: '编辑 审核后的 GIF', exact: true }).click();
  await admin.getByText('删除资源', { exact: true }).click();
  await admin.getByRole('button', { name: '确认删除资源', exact: true }).click();
  await admin.getByText('暂无符合条件的资源').waitFor();
  await admin.getByRole('tab', { name: '贴图合集', exact: true }).click();
  await admin.getByText('新增与采集', { exact: true }).click();
  assert.equal(await admin.locator('#expression-upload input[type=file]').getAttribute('multiple'), '');
  await admin.setViewportSize({ width: 1280, height: 900 });
  await admin.getByRole('button', { name: '会话管理', exact: true }).click();
  await admin.getByRole('button', { name: roomId }).waitFor();
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
  console.log('Backup/admin browser UI passed: desktop/mobile backup spacing, usable touch targets, fresh-passkey view, scoped restore form, real admin login, room/device/backup detail, deletion confirmation, logout and mobile overflow.');
} finally {
  await browser?.close(); await vite?.close(); await service?.close(); await rm(directory, { recursive: true, force: true });
}
