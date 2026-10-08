import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

// Local synthetic endpoints only. UI paths use the product app; injected setup
// creates independently encrypted vaults and a real service/MLS group.
const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-audit-interactions-'));
let service, vite, browser;
const errors = [], results = {};
const visualDirectory = process.argv[2];
try {
  service = await startServer({ host: '127.0.0.1', port: 0, dataDir, quiet: true });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, proxy: { '/api': `http://127.0.0.1:${service.port}`, '/ws': { target: `ws://127.0.0.1:${service.port}`, ws: true } } }, plugins: [{ name: 'audit-interactions-fixture', configureServer(server) {
    server.middlewares.use('/__audit_interactions', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>'); });
  } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const endpoint = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
    await page.goto(`http://localhost:${vite.httpServer.address().port}/__audit_interactions`);
    await page.evaluate(async () => {
      await (await import('/tests/fixtures/product-styles.ts')).loadProductStyles();
      window.v = await import('/src/lib/vault.ts'); window.api = await import('/src/lib/api.ts'); window.c = await import('/src/lib/crypto.ts'); window.m = await import('/src/lib/mls.ts'); window.sp = await import('/src/lib/spaces.ts'); window.links = await import('/src/lib/invite-link.ts');
      window.app = new (await import('/src/app.ts')).QuietRoomApp(document.querySelector('#app'));
      app.privacyCovered = false; app.runtimeAbort = new AbortController(); document.body.className = 'app-mode';
    });
    return { page, context, cdp };
  };
  const shot = async (page, name) => {
    if (!visualDirectory) return;
    await mkdir(visualDirectory, { recursive: true });
    await page.screenshot({ path: path.join(visualDirectory, `${name}.png`), animations: 'disabled' });
  };
  const { page: r } = await endpoint();
  await r.evaluate(() => {
    window.recoveryLink = { roomId: crypto.randomUUID(), requestId: crypto.randomUUID(), capability: 'a'.repeat(43) };
    app.renderFirstRun(null);
  });
  for (let i = 0; i < 10; i++) {
    await r.evaluate(() => { location.hash = `recover=${encodeURIComponent(JSON.stringify(recoveryLink))}`; });
    await r.locator('#joint-start').waitFor(); assert.equal(await r.evaluate(() => location.hash), '');
    await r.locator('#joint-back').click(); await r.locator('#joint-start').waitFor({ state: 'detached' });
  }
  results.sameTabRecoveryAndReturn = true;
  const first = await r.evaluate(() => {
    const original = { ...recoveryLink, requestId: crypto.randomUUID() };
    location.hash = `recover=${encodeURIComponent(JSON.stringify(original))}`; window.dispatchEvent(new HashChangeEvent('hashchange'));
    location.hash = `recover=${encodeURIComponent(JSON.stringify({ ...original, requestId: crypto.randomUUID() }))}`; window.dispatchEvent(new HashChangeEvent('hashchange'));
    return original;
  });
  await r.locator('#joint-start').waitFor();
  assert.equal(await r.locator('.joint-request-code').textContent(), await r.evaluate(async link => (await import('/src/lib/joint-recovery.ts')).jointRecoveryCode(link), first));
  await r.locator('#joint-back').click();
  results.firstIntentSurvivesRejectedConcurrentLink = true;
  for (const kind of ['repair', 'device', 'participant']) {
    const url = await r.evaluate(kind => {
      const base = { v: 1, roomId: crypto.randomUUID(), creatorFingerprint: 'a'.repeat(43) };
      if (kind === 'participant') return links.makeParticipantInviteUrl({ ...base, accessToken: 'b'.repeat(43), pairingSecret: 'c'.repeat(43) });
      if (kind === 'device') return links.makeDeviceInviteUrl({ ...base, kind: 'device-link', linkId: crypto.randomUUID(), secret: 'b'.repeat(43), role: 'creator', authorizerId: crypto.randomUUID(), authorizerFingerprint: 'a'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString() });
      return links.makeRepairInviteUrl({ ...base, kind: 'repair-link', linkId: crypto.randomUUID(), secret: 'b'.repeat(43), sourceDeviceId: crypto.randomUUID(), initiatorId: crypto.randomUUID(), initiatorFingerprint: 'a'.repeat(43), sourceFingerprint: 'a'.repeat(43), expiresAt: new Date(Date.now() + 600000).toISOString() });
    }, kind);
    for (let i = 0; i < 2; i++) {
      await r.evaluate(url => { location.hash = new URL(url).hash; }, url);
      await r.waitForFunction(kind => document.querySelector('.gateway h1')?.textContent === (kind === 'repair' ? '修复这台设备' : kind === 'device' ? '添加这台设备' : '加入私密空间'), kind).catch(async error => { console.log('INVITATION_DIAGNOSTIC', kind, i, await r.evaluate(() => ({ heading: document.querySelector('.gateway h1')?.textContent, hasHash: Boolean(location.hash), covered: app.privacyCovered, routing: app.routingInvitation, native: app.nativeSurfaceActive(), body: document.body.innerText }))); throw error; });
      await r.locator('.gateway-back').click();
      await r.waitForFunction(kind => document.querySelector('.gateway h1')?.textContent !== (kind === 'repair' ? '修复这台设备' : kind === 'device' ? '添加这台设备' : '加入私密空间'), kind);
    }
  }
  results.allInvitationKindsReopen = true;
  await r.evaluate(() => { app.renderJointRecovery(null); }); await r.locator('#joint-open-code').click();
  const field = r.locator('#joint-code-form textarea');
  await field.fill('QR4-incomplete'); await r.locator('#joint-code-form button[type=submit]').click();
  assert.equal(await field.inputValue(), 'QR4-incomplete'); assert.match(await r.locator('#joint-code-form .form-error').textContent(), /QR4.*QR3/);
  const directory = await r.evaluate(async () => {
    window.testCode = sp.newSpaceRecoveryCode();
    const oldCode = (await import('/src/lib/backup-crypto.ts')).newRecoveryCode().code;
    return { code: testCode, sealed: await sp.sealSpaceDirectory(testCode, [{ roomId: recoveryLink.roomId, name: '合成测试空间', code: oldCode }]) };
  });
  let requests = 0;
  await r.route('**/api/space-directories/*', route => {
    requests += 1;
    return route.fulfill({ status: requests === 1 ? 503 : 200, contentType: 'application/json', body: JSON.stringify(requests === 1 ? { error: 'synthetic outage' } : { sealed: directory.sealed }) });
  });
  await field.fill(directory.code); await r.locator('#joint-code-form button[type=submit]').click();
  await r.getByRole('button', { name: '重试', exact: true }).waitFor(); assert.equal(await field.inputValue(), '');
  await shot(r, 'recovery-retry-390');
  await r.getByRole('button', { name: '重试', exact: true }).click();
  await r.locator('[data-recovery-spaces] select').waitFor(); assert.equal(requests, 2);
  assert.equal(await r.locator('[data-recovery-spaces] option').textContent(), '合成测试空间');
  await r.locator('#joint-code-close').click(); await r.locator('#joint-code-form').waitFor({ state: 'detached' });
  await r.unroute('**/api/space-directories/*');
  results.localFormatAndDirectoryRetry = true;
  let release, requested;
  const requestSeen = new Promise(resolve => { requested = resolve; });
  await r.route('**/api/space-directories/*', async route => { requested(); await new Promise(resolve => { release = resolve; }); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sealed: directory.sealed }) }).catch(() => {}); });
  await r.locator('#joint-open-code').click(); await field.fill(directory.code); await r.locator('#joint-code-form button[type=submit]').click(); await requestSeen;
  await r.locator('#joint-code-close').click(); release(); await r.locator('#joint-code-form').waitFor({ state: 'detached' });
  await r.waitForTimeout(150); assert.equal(await r.locator('[data-recovery-spaces]').count(), 0);
  results.cancelRejectsLateRecovery = true;
  await r.unroute('**/api/space-directories/*');
  let cooldownRequests = 0;
  await r.route('**/api/space-directories/*', route => {
    cooldownRequests += 1;
    return route.fulfill({ status: cooldownRequests === 1 ? 429 : 200, headers: { 'Retry-After': '1' }, contentType: 'application/json', body: JSON.stringify(cooldownRequests === 1 ? {} : { sealed: directory.sealed }) });
  });
  await r.locator('#joint-open-code').click(); await field.fill(directory.code); await r.locator('#joint-code-form button[type=submit]').click();
  await r.waitForFunction(() => document.querySelector('#joint-code-form .form-error')?.textContent.includes('过于频繁'));
  assert.equal(await r.locator('#joint-code-form button[type=submit]').isDisabled(), true);
  await r.locator('#joint-code-form').evaluate(form => { form.dispatchEvent(new Event('submit', { cancelable: true })); });
  assert.equal(cooldownRequests, 1);
  await r.getByRole('button', { name: '重试', exact: true }).click(); await r.locator('[data-recovery-spaces] select').waitFor();
  assert.equal(cooldownRequests, 2);
  await r.locator('#joint-code-close').click(); await r.locator('#joint-code-form').waitFor({ state: 'detached' });
  await r.unroute('**/api/space-directories/*');
  await r.route('**/api/space-directories/*', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await r.locator('#joint-open-code').click(); await field.fill(directory.code); await r.locator('#joint-code-form button[type=submit]').click();
  await r.waitForFunction(() => document.querySelector('#joint-code-form .form-error')?.textContent.includes('找不到'));
  assert.equal(await field.inputValue(), ''); assert.equal(await field.isVisible(), true);
  await r.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await r.locator('#joint-code-form').waitFor({ state: 'detached' });
  results.cooldownTerminalAndHiddenCleanup = true;
  await r.context().close();

  const { page: a } = await endpoint(); const fEndpoint = await endpoint(); const f = fEndpoint.page;
  const setup = await a.evaluate(async () => {
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const [ai, bi] = await Promise.all([c.generateIdentity(), c.generateIdentity()]);
    const at = randomBase64Url(32), bt = randomBase64Url(32), invite = randomBase64Url(32), secret = randomBase64Url(32);
    const room = await api.createRoom(ai.publicBundle, at, invite, 'audit A', ['joint-recovery-v1']);
    const state = await api.joinRoom(room.roomId, invite, bi.publicBundle, await c.createJoinProof(secret, bi.publicBundle), bt, 'audit B', ['joint-recovery-v1']);
    const vault = { v: 3, roomId: room.roomId, accessToken: at, role: 'creator', pairingSecret: '', creatorFingerprint: await c.bundleFingerprint(ai.publicBundle), identity: ai, members: state.members, lastSeq: 0, lastReceiptSeq: 0, createdAt: room.createdAt, protocol: 'mls-rfc9420', pairingState: 'ready' };
    vault.mls = await m.createCreatorMlsState(room.roomId, ai, state.members); vault.mls = await m.prepareCreatorWelcome(vault);
    await api.publishMlsWelcome(room.roomId, at, vault.mls.pendingWelcome); delete vault.mls.pendingWelcome; vault.mls.lastEventSeq = 0;
    window.session = await v.createVault(vault, 'synthetic-audit-password', 'password'); app.session = session;
    await app.openSession();
    const linkId = crypto.randomUUID(), linkSecret = randomBase64Url(32), expiresAt = new Date(Date.now() + 600000).toISOString();
    await api.createDeviceLink(room.roomId, at, ai.publicBundle.deviceId, linkId, linkSecret, expiresAt);
    const fingerprint = await c.bundleFingerprint(ai.publicBundle);
    return { v: 1, kind: 'device-link', roomId: room.roomId, linkId, secret: linkSecret, role: 'creator', authorizerId: ai.publicBundle.deviceId, authorizerFingerprint: fingerprint, creatorFingerprint: fingerprint, expiresAt };
  });
  // A synthetically sealed checkpoint for an unavailable other room reaches
  // preparation, then fails the real service lookup before any signed request.
  const unavailable = await a.evaluate(async () => {
    const backup = await import('/src/lib/backup-crypto.ts'); const code = backup.newRecoveryCode();
    const checkpoint = structuredClone(session.vault); checkpoint.roomId = crypto.randomUUID();
    for (const field of ['backup', 'spaceRecoveryCode', 'historyRestoreTask', 'recoverySource', 'pendingJointRecovery', 'pendingRecovery', 'recoveryExperience']) delete checkpoint[field];
    return { code: code.code, sealed: await backup.sealRecovery({ v: 1, backupId: code.id, roomId: checkpoint.roomId, deviceId: checkpoint.identity.publicBundle.deviceId, checkpoint, archives: [] }, code.code) };
  });
  await a.route('**/api/recovery-backups/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: 1, sealed: unavailable.sealed }) }));
  await a.locator('#message-input').fill('原空间的合成草稿');
  await a.evaluate(() => { app.uiPreferences.composerDraft = document.querySelector('#message-input').value; app.flushUiPreferencesSave(); app.renderJointRecovery(null); });
  await a.locator('#joint-open-code').click(); await a.locator('#joint-code-form textarea').fill(unavailable.code);
  await a.locator('#joint-code-form button[type=submit]').click();
  await a.waitForFunction(() => document.querySelector('#joint-code-form .form-error')?.textContent.length > 0);
  await a.locator('#joint-code-close').click(); await a.locator('#joint-code-form').waitFor({ state: 'detached' });
  await a.locator('#joint-back').click(); await a.locator('#message-input').waitFor();
  assert.equal(await a.evaluate(() => app.session.vault.roomId), setup.roomId);
  assert.equal(await a.locator('#message-input').inputValue(), '原空间的合成草稿');
  assert.equal(await a.evaluate(() => app.session.vault.pendingJointRecovery), undefined);
  await a.unroute('**/api/recovery-backups/*');
  results.crossSpacePreparationFailureReturnsOriginalVault = true;
  let statusRequests = 0, simultaneous = 0, maxSimultaneous = 0;
  f.on('request', request => { if (request.url().includes('/status')) { statusRequests += 1; simultaneous += 1; maxSimultaneous = Math.max(maxSimultaneous, simultaneous); } });
  const finished = request => { if (request.url().includes('/status')) simultaneous -= 1; };
  f.on('requestfinished', finished); f.on('requestfailed', finished);
  await f.evaluate(async invite => { app.newDeviceName = () => 'audit F'; app.renderJoinDevice(invite); }, setup);
  await f.locator('[data-device-verify]').click(); await f.locator('#retry-device-link').waitFor().catch(async error => { console.log('DEVICE_DIAGNOSTIC', await f.evaluate(() => ({ body: document.body.innerText, covered: app.privacyCovered, pairing: app.session?.vault.pairingState })), errors); throw error; });
  const fId = await f.evaluate(() => app.session.vault.identity.publicBundle.deviceId);
  await shot(f, 'device-wait-390');
  await f.evaluate(() => { location.hash = `recover=${encodeURIComponent(JSON.stringify({ roomId: crypto.randomUUID(), requestId: crypto.randomUUID(), capability: 'a'.repeat(43) }))}`; });
  await f.waitForFunction(() => location.hash === '');
  assert.equal(await f.locator('#retry-device-link').count(), 1);
  assert.equal(await f.evaluate(() => app.session.vault.identity.publicBundle.deviceId), fId);
  results.newInvitationCannotReplacePendingIdentity = true;
  await f.locator('#pending-device-lock').click();
  await f.locator('#retry-device-link').waitFor({ state: 'detached' });
  await f.evaluate(async () => { app.privacyCovered = false; app.session = await v.unlockVault(); app.runtimeAbort = new AbortController(); await app.openSession(); });
  await f.locator('#retry-device-link').waitFor();
  assert.equal(await f.evaluate(() => app.session.vault.identity.publicBundle.deviceId), fId);
  results.lockResumesOriginalDeviceRequest = true;
  await f.evaluate(async () => { await Promise.all(Array.from({ length: 10 }, () => app.completePendingDeviceLink())); });
  assert.equal(maxSimultaneous, 1);
  await f.evaluate(async () => { await app.renderPendingDeviceLink(new api.ApiError('合成服务已确认邀请过期', 410, 'DEVICE_LINK_EXPIRED')); });
  assert.equal(await f.locator('#retry-device-link').textContent(), '本次接入未完成');
  assert.equal(await f.locator('#retry-device-link').isDisabled(), true);
  const replacement = await a.evaluate(async original => {
    const fresh = { ...original, linkId: crypto.randomUUID(), secret: (await import('/src/lib/base64.ts')).randomBase64Url(32), expiresAt: new Date(Date.now() + 600000).toISOString() };
    await api.createDeviceLink(fresh.roomId, session.vault.accessToken, fresh.authorizerId, fresh.linkId, fresh.secret, fresh.expiresAt);
    return links.makeDeviceInviteUrl(fresh);
  }, setup);
  await f.evaluate(url => { location.hash = new URL(url).hash; }, replacement);
  await f.waitForFunction(() => document.querySelector('.gateway h1')?.textContent === '添加这台设备');
  await f.locator('.gateway-back').click(); await f.locator('#retry-device-link').waitFor();
  assert.equal(await f.evaluate(() => app.session.vault.identity.publicBundle.deviceId), fId);
  results.endedDeviceTaskAllowsExplicitNewInviteAndSafeReturn = true;
  await a.evaluate(async () => { await app.renderDeviceManager(); });
  await a.getByRole('button', { name: '安全码一致，允许加入' }).click();
  await f.locator('#message-input').waitFor();
  const admitted = await f.evaluate(async () => ({ ready: app.session.vault.pairingState, identity: app.session.vault.identity.publicBundle.deviceId, history: (await v.loadHistory(app.session)).length, phase: app.session.vault.mls.phase }));
  assert.deepEqual(admitted, { ready: 'ready', identity: fId, history: 0, phase: 'active' });
  results.realApprovalAutoInstallsIndependentDevice = true;
  await f.waitForFunction(() => app.connectionState === 'connected');
  await f.locator('#message-input').fill('继续编写的合成草稿');
  await f.locator('#message-input').focus();
  await f.evaluate(() => { document.querySelector('#message-input').setSelectionRange(2, 5); location.hash = `recover=${encodeURIComponent(JSON.stringify({ roomId: app.session.vault.roomId, requestId: crypto.randomUUID(), capability: 'a'.repeat(43) }))}`; });
  await f.locator('#joint-start').waitFor(); await f.locator('#joint-back').click(); await f.locator('#message-input').waitFor();
  await f.waitForFunction(() => document.activeElement?.id === 'message-input');
  assert.deepEqual(await f.locator('#message-input').evaluate(input => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd })), { value: '继续编写的合成草稿', start: 2, end: 5 });
  results.recoveryReturnPreservesDraftAndFocus = true;
  await f.waitForFunction(() => app.connectionState === 'connected');
  // Ordinary offline sending still commits the original ID/ciphertext once.
  // Chromium offline emulation does not close an already open WebSocket.
  // Observe a real close before disabling HTTP: dropping the network first
  // can leave a graceful close waiting for the browser's handshake timeout.
  results.offlineTransportClose = await f.evaluate(() => new Promise(resolve => {
    const socket = app.socket.socket;
    socket.addEventListener('close', event => resolve({ event: event.type, code: event.code, readyState: socket.readyState }), { once: true });
    socket.close();
  }));
  await f.waitForFunction(() => app.connectionState !== 'connected');
  assert.equal(results.offlineTransportClose.readyState, 3, 'The actual WebSocket must be closed before offline sending');
  await fEndpoint.context.setOffline(true);
  await f.locator('#message-input').fill('合成待发内容'); await f.locator('#send-text').click();
  await f.waitForFunction(() => app.outbox.size === 1);
  const queued = await f.evaluate(async () => JSON.stringify(await v.loadOutbox(app.session)));
  await a.evaluate(async id => { const member = app.session.vault.members.find(item => item.deviceId === id); const button = document.createElement('button'); document.querySelector('#app').append(button); await app.changeMlsMembership('remove', member, button); }, fId);
  await fEndpoint.context.setOffline(false);
  await f.locator('#access-failure').waitFor();
  assert.match(await f.locator('#access-failure').textContent(), /不会自动发送/);
  assert.equal(await f.locator('#message-input').evaluate(input => input.readOnly), true);
  const blocked = await f.evaluate(async () => {
    const before = JSON.stringify(await v.loadOutbox(app.session)), state = app.session.vault.mls.groupState;
    let rejected = false;
    try { await app.enqueuePayload({ v: 1, kind: 'text', text: '禁止发送', sentAt: new Date().toISOString() }); } catch { rejected = true; }
    return { rejected, unchanged: before === JSON.stringify(await v.loadOutbox(app.session)), stateUnchanged: state === app.session.vault.mls.groupState, queued: before };
  });
  assert.equal(blocked.rejected, true); assert.equal(blocked.unchanged, true); assert.equal(blocked.stateUnchanged, true); assert.equal(blocked.queued, queued);
  assert.equal(await f.locator('#access-failure button').evaluate(button => button.getBoundingClientRect().height >= 44), true);
  await f.getByRole('button', { name: '查看接入方法' }).click();
  assert.match(await f.locator('.confirm-dialog').textContent(), /新的浏览器/);
  await f.getByRole('button', { name: '返回聊天', exact: true }).click();
  assert.equal(await f.evaluate(async () => JSON.stringify(await v.loadOutbox(app.session))), queued);
  await shot(f, 'access-stopped-390');
  await f.setViewportSize({ width: 320, height: 844 });
  assert.equal(await f.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.emulateMedia({ colorScheme: 'dark' }); await shot(f, 'access-stopped-320-dark');
  await f.emulateMedia({ colorScheme: 'light' });
  await f.setViewportSize({ width: 1440, height: 900 }); await shot(f, 'access-stopped-1440');
  results.realRevocationPreservesCiphertextAndStopsNewSends = true;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...results, maxSimultaneous, statusRequests, pageErrors: errors }, null, 2));
} finally {
  await browser?.close(); await vite?.close(); await service?.close(); await rm(dataDir, { recursive: true, force: true });
}
