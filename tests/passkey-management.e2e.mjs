import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
let vite, browser;
try {
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'fixture', configureServer(server) { server.middlewares.use('/__passkeys', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>'); }); } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, hasPrf: true, automaticPresenceSimulation: true, isUserVerified: true } });
  await page.goto(`http://localhost:${vite.httpServer.address().port}/__passkeys`);
  await page.evaluate(async () => {
    await import('/src/styles.css'); await import('/src/spaces.css');
    window.v = await import('/src/lib/vault.ts'); window.pk = await import('/src/lib/platform-vault.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const identity = await generateIdentity();
    window.session = await v.createVault({ v: 3, roomId: crypto.randomUUID(), accessToken: 'a'.repeat(43), role: 'creator', pairingSecret: 'b'.repeat(43), creatorFingerprint: 'c'.repeat(43), identity, members: [{ ...identity.publicBundle, role: 'creator', status: 'active' }], lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'legacy-v1', pairingState: 'ready' });
    await (await import('/src/lib/spaces.ts')).rememberLocalSpace(session);
    window.original = JSON.stringify(session.stored);
    window.credential = v.cloneDeviceCredential(session);
    window.beforeProof = Array.from(credential.prfOutput);
    const { QuietRoomApp } = await import('/src/app.ts');
    window.app = new QuietRoomApp(document.querySelector('#app'));
    app.session = session; app.deviceCredential = credential; app.runtimeAbort = new AbortController(); app.privacyCovered = false;
    app.rememberSpacePreview = async () => {}; app.refreshOtherSpacePreviews = async () => {}; app.updatePeerStatus = () => {};
    document.querySelector('#app').innerHTML = '<section class="chat-shell"><button id="open-spaces">空间</button></section>';
    window.getCount = 0; window.cancelNext = false; window.deferNext = false;
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = options => { getCount++; if (cancelNext) { cancelNext = false; return Promise.reject(new DOMException('cancel', 'NotAllowedError')); } if (deferNext) { deferNext = false; return new Promise(resolve => { window.releaseGet = () => resolve(get(options)); }); } return get(options); };
    window.signalCalls = [];
    window.realSignal = PublicKeyCredential.signalCurrentUserDetails;
    PublicKeyCredential.signalCurrentUserDetails = async details => { signalCalls.push(details); if (window.rejectSignal) throw new Error('提供方暂时不可用'); if (window.failStorage) { window.originalStored = session.stored; session.stored = { ...session.stored, payload: { ...session.stored.payload, iv: 'changed' } }; } };
    await app.openPrivateSpaces();
  });
  await page.locator('#space-settings').click();
  const before = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  assert.equal(before.length, 1);
  await page.evaluate(() => { cancelNext = true; });
  await page.locator('#passkey-management').click();
  await page.waitForFunction(() => document.querySelector('.space-drawer .form-error')?.textContent.includes('未完成'));
  assert.equal(await page.locator('.passkey-manager').count(), 0);
  await page.locator('#passkey-management').click();
  await page.locator('#passkey-rename').waitFor();
  assert.equal(await page.evaluate(() => getCount), 2);
  await page.locator('#passkey-rename').click();
  assert.equal(await page.locator('#passkey-name').evaluate(e => document.activeElement === e), true);
  for (const [width, height, colorScheme] of [[393, 852, 'light'], [320, 450, 'light'], [393, 520, 'dark']]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme });
    // setViewportSize may finish before visualViewport dispatches its resize.
    // Require the real viewport-fit callback and the unchanged bounds contract.
    await page.waitForFunction(() => {
      const overlay = document.querySelector('.passkey-name-overlay');
      const viewport = window.visualViewport;
      const box = overlay.querySelector('form').getBoundingClientRect();
      return getComputedStyle(overlay).opacity === '1'
        && Math.abs(parseFloat(overlay.style.height) - (viewport?.height ?? innerHeight)) < 1
        && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    });
    assert.equal(await page.locator('.passkey-name-overlay').evaluate(el => { const b=el.querySelector('form').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; }), true);
    if (process.env.PASSKEY_SCREENSHOTS) { await mkdir(process.env.PASSKEY_SCREENSHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.PASSKEY_SCREENSHOTS, `rename-${width}-${colorScheme}.png`) }); }
  }
  await page.setViewportSize({ width: 393, height: 852 }); await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('#passkey-name').fill('新的密钥名称');
  await page.locator('.passkey-name-overlay [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#app-toast')?.textContent === '修改成功');
  assert.equal(await page.evaluate(() => getCount), 3);
  assert.equal(await page.locator('#passkey-current-name').textContent(), '新的密钥名称');
  assert.equal(await page.evaluate(() => JSON.stringify(session.stored) === original && JSON.stringify(Array.from(credential.prfOutput)) === JSON.stringify(beforeProof)), true);
  assert.equal(await page.evaluate(async () => v.readPasskeyName({ ...credential.record, userName: '旧副本' })), '新的密钥名称');
  assert.deepEqual(await page.evaluate(() => signalCalls.map(c => [c.userId, c.name, c.displayName])), [[await page.evaluate(() => credential.record.userId), '新的密钥名称', '新的密钥名称']]);
  assert.equal((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials[0].credentialId, before[0].credentialId);
  // Explicit provider rejection keeps the editable draft and old local name.
  await page.locator('#passkey-rename').click(); await page.locator('#passkey-name').fill('再改一次');
  await page.evaluate(() => { rejectSignal = true; });
  await page.locator('.passkey-name-overlay [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.passkey-name-overlay .form-error')?.textContent.includes('提供方'));
  assert.equal(await page.locator('#passkey-name').inputValue(), '再改一次');
  assert.equal(await page.locator('#passkey-current-name').textContent(), '新的密钥名称');
  // Accepted signal plus stale local vault is reported as partial, with same-name retry.
  await page.evaluate(() => { rejectSignal = false; failStorage = true; });
  await page.locator('.passkey-name-overlay [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('.passkey-name-overlay .form-error')?.textContent.includes('结果待确认'));
  assert.equal(await page.locator('#passkey-name').evaluate(e => e.readOnly), true);
  await page.evaluate(() => { failStorage = false; session.stored = originalStored; });
  await page.locator('.passkey-name-overlay [type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('.passkey-name-overlay'));
  assert.equal(await page.locator('#passkey-current-name').textContent(), '再改一次');
  // A late assertion may not signal a rename after the session aborts.
  await page.locator('#passkey-rename').click(); await page.locator('#passkey-name').fill('不得提交');
  const calls = await page.evaluate(() => { deferNext = true; return signalCalls.length; });
  await page.locator('.passkey-name-overlay [type=submit]').click();
  await page.evaluate(() => { app.runtimeAbort.abort(); releaseGet(); });
  await page.waitForFunction(() => !document.querySelector('.passkey-manager'));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => signalCalls.length), calls);
  // Old registration without user metadata recovers the actual user handle.
  await page.evaluate(async () => {
    const legacy = { ...credential, record: { ...credential.record } };
    delete legacy.record.userId; delete legacy.record.userName;
    window.oldUser = await pk.verifyPasskeyDetails(legacy, new AbortController().signal);
  });
  assert.equal(await page.evaluate(() => oldUser), await page.evaluate(() => signalCalls[0].userId));
  await page.evaluate(async () => { PublicKeyCredential.signalCurrentUserDetails = undefined; app.runtimeAbort = new AbortController(); await app.openPrivateSpaces(); });
  await page.locator('#space-settings').click(); await page.locator('#passkey-management').click();
  await page.locator('#passkey-rename').waitFor();
  assert.equal(await page.locator('#passkey-rename').isDisabled(), true);
  assert.equal(await page.locator('.passkey-name-overlay').count(), 0);
  const hidden = await page.evaluate(async () => {
    const pending = app.withDeviceVerification(() => new Promise(resolve => { window.releaseHidden = resolve; }), true).then(() => false, () => true);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    releaseHidden('late');
    const rejected = await pending;
    delete document.hidden;
    return { rejected, locked: app.session === null, removed: !document.querySelector('.passkey-manager') };
  });
  assert.deepEqual(hidden, { rejected: true, locked: true, removed: true });
  console.log('PASS passkey management: direct verification, focused modal, fresh save, shared labels, unchanged secrets, failure/partial retry, late-result fencing, legacy user handle');
} finally { await browser?.close(); await vite?.close(); }
