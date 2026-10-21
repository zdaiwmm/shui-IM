import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

// Disposable localhost rooms and browser profiles, with real service/MLS replacement.
const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-device-access-'));
let service, vite, browser;
try {
  service = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
  vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error',
    plugins: [{ name: 'device-access-observer', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/main.ts')) return code.replace('void app.start();', 'window.app=app;void app.start();');
    } }], server: { host: '127.0.0.1', port: 0, hmr: false,
      proxy: { '/api': `http://127.0.0.1:${service.port}`, '/ws': { target: `ws://127.0.0.1:${service.port}`, ws: true } } } });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const origin = `http://localhost:${vite.httpServer.address().port}`, errors = [];
  const endpoint = async () => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    page.on('pageerror', error => errors.push(error.message));
    return { page, context };
  };
  const { page: alice } = await endpoint(), { page: bob, context: bobContext } = await endpoint(), { page: replacement } = await endpoint();
  const ready = page => page.waitForFunction(() => document.querySelector('#message-input')?.disabled === false && app.connectionState === 'connected');
  const send = async (page, text) => { await page.locator('#message-input').fill(text); await page.locator('#composer').evaluate(form => form.requestSubmit()); };
  const help = async (targetId) => {
    await alice.locator('#chat-settings').click(); await alice.locator('#help-peer-enter').click();
    await alice.locator(`[data-device-id="${targetId}"]`).getByRole('button', { name: '生成进入链接', exact: true }).click();
    await alice.locator('[data-help-action]').click();
    await alice.locator('.app-toast').filter({ hasText: '聊天链接已复制' }).waitFor();
    const url = await alice.evaluate(() => navigator.clipboard.readText());
    await alice.locator('#device-back').click();
    await alice.locator('.is-settings-page .space-back:visible, .is-settings-page .settings-dismiss-handle:visible').click();
    return url;
  };
  const blocked = async () => {
    await bob.locator('.access-denied-page').waitFor();
    assert.equal(await bob.locator('.chat-shell, #message-input, .peer-summary, .chat-header').count(), 0);
    assert.equal(await bob.locator('.access-denied-steps li').count(), 3);
    assert.match(await bob.locator('.access-denied-page').innerText(), /设置 → 帮对方进入密室/);
    assert.match(await bob.locator('.access-denied-page').innerText(), /回到聊天页面并保持打开/);
    assert.match(await bob.locator('.access-denied-replacement').innerText(), /选中的那台设备将被移出/);
    assert.equal(await bob.locator('.access-denied-page button').count(), 1);
    assert.equal(await bob.evaluate(() => app.activeSurface), 'away');
  };
  await alice.goto(origin); await alice.locator('#create-room').click(); await alice.locator('#copy-invite').click();
  await alice.locator('.app-toast').filter({ hasText: '已复制' }).waitFor();
  await bob.goto(await alice.evaluate(() => navigator.clipboard.readText())); await ready(bob); await ready(alice);
  await send(bob, '合成的原有历史'); await alice.getByText('合成的原有历史', { exact: true }).waitFor();
  const original = await bob.evaluate(() => ({ roomId: app.session.vault.roomId, deviceId: app.session.vault.identity.publicBundle.deviceId }));
  await bob.evaluate(() => new Promise(resolve => { const socket = app.socket.socket; socket.addEventListener('close', resolve, { once: true }); socket.close(); }));
  await bobContext.setOffline(true);
  await send(bob, '合成的离线待发'); await bob.waitForFunction(() => app.outbox.size === 1);
  await bob.locator('#message-input').fill('保留的合成草稿');
  assert.equal(await bob.locator('.access-denied-page').count(), 0, 'Ordinary offline operation retains chat');
  const ciphertext = await bob.evaluate(async () => JSON.stringify(await (await import('/src/lib/vault.ts')).loadOutbox(app.session)));
  const link = await help(original.deviceId);
  await replacement.goto(link); await ready(replacement);
  const replacementId = await replacement.evaluate(() => app.session.vault.identity.publicBundle.deviceId);
  await bobContext.setOffline(false); await blocked();
  await bob.waitForFunction(() => app.session.vault.localAccessDeniedDeviceId === app.session.vault.identity.publicBundle.deviceId);
  await bob.evaluate(async () => {
    // Wait for the encrypted denial marker to commit, rather than testing memory only.
    await (await import('/src/lib/vault.ts')).withVaultMutation(app.session, async () => {});
  });
  const preserved = await bob.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    let rejected = false; try { await app.enqueuePayload({ v: 1, kind: 'text', text: '不能发送', sentAt: new Date().toISOString() }); } catch { rejected = true; }
    return { outbox: JSON.stringify(await v.loadOutbox(app.session)), draft: (await v.loadUiPreferences(app.session)).composerDraft, rejected };
  });
  assert.equal(preserved.outbox, ciphertext); assert.equal(preserved.draft, '保留的合成草稿'); assert.equal(preserved.rejected, true);
  const layout = async (page, width, scheme) => {
    await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.QR_VISUAL_DIR) { await mkdir(process.env.QR_VISUAL_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.QR_VISUAL_DIR, `denied-${width}-${scheme}.png`) }); }
    const button = await page.locator('#access-denied-spaces').evaluate(n => { const r = n.getBoundingClientRect(); return { height: r.height, bottom: r.bottom, viewport: innerHeight, hit: n.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; });
    assert.ok(button.height >= 44 && button.bottom <= button.viewport && button.hit, JSON.stringify({ width, scheme, button }));
  };
  for (const scheme of ['light', 'dark']) for (const width of [320, 390]) await layout(bob, width, scheme);
  // A desktop context is necessary: widening the mobile context invokes the
  // intentional portrait-only guard. Only synthetic encrypted localhost data is copied.
  const desktop = await browser.newContext({ storageState: await bobContext.storageState({ indexedDB: true }), viewport: { width: 1440, height: 844 } });
  const desktopPage = await desktop.newPage(); desktopPage.on('pageerror', error => errors.push(error.message));
  await desktopPage.goto(origin); await desktopPage.locator('.access-denied-page').waitFor();
  for (const scheme of ['light', 'dark']) await layout(desktopPage, 1440, scheme);
  await desktop.close();
  await bob.setViewportSize({ width: 390, height: 844 });
  await bob.reload(); await blocked();
  await bob.locator('#access-denied-spaces').click();
  await bob.locator('.is-space-list-page .space-row').first().click(); await blocked();
  assert.equal(await bob.locator('.space-drawer-overlay:not(.is-closing)').count(), 0, 'Selecting the denied room closes its list');
  const returnLink = await help(replacementId);
  await bob.goto(returnLink); await ready(bob);
  assert.equal(await bob.locator('.access-denied-page').count(), 0);
  assert.equal(await bob.evaluate(() => app.session.vault.roomId), original.roomId);
  assert.notEqual(await bob.evaluate(() => app.session.vault.identity.publicBundle.deviceId), original.deviceId);
  await bob.getByText('合成的原有历史', { exact: true }).waitFor();
  assert.equal(await bob.evaluate(async () => JSON.stringify(await (await import('/src/lib/vault.ts')).loadOutbox(app.session))), ciphertext, 'Retired-device ciphertext is retained in encrypted storage');
  assert.equal(await bob.evaluate(() => app.outbox.size), 0, 'Retired-device items never enter the new identity send queue');
  await send(bob, '合成的重新进入后消息');
  try { await alice.getByText('合成的重新进入后消息', { exact: true }).waitFor(); }
  catch (cause) {
    for (const [name, page] of [['sender', bob], ['receiver', alice]]) console.error(name, await page.evaluate(() => ({
      connected: app.connectionState, denied: app.accessFailure, phase: app.session?.vault.mls?.phase,
      outbox: [...app.outbox.values()].map(item => ({ senderMatches: item.envelope?.senderId === app.session.vault.identity.publicBundle.deviceId, encrypted: !!item.envelope })),
      pending: [...app.pending.values()].map(item => item.status), surface: app.activeSurface,
      notice: document.querySelector('.app-toast')?.textContent, inputLength: document.querySelector('#message-input')?.value.length,
    })));
    throw cause;
  }
  assert.equal(await alice.getByText('合成的离线待发', { exact: true }).count(), 0, 'Old outbox is never transferred to new device credentials');
  assert.deepEqual(errors, []);
  console.log('Device access page passed: actual replacement, offline distinction, durable draft/ciphertext, reload/list guard, responsive themes and same-browser authorized reentry.');
} finally { await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true }); }
