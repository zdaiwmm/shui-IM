import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { startServer } from '../server/index.mjs';

const screenshots = process.argv[2];
const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-password-acceptance-'));
const backend = await startServer({ port: 0, host: '127.0.0.1', dataDir, quiet: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false,
  proxy: { '/api': `http://127.0.0.1:${backend.port}`, '/ws': { target: `ws://127.0.0.1:${backend.port}`, ws: true } } } });
vite.middlewares.use('/__password_acceptance', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>合成空间验收</title></head><body><div id="app"></div></body></html>');
});
let browser;
const css = ['styles', 'chat-layout', 'gallery', 'auth-recovery', 'chat-interactions', 'cover', 'voice-messages', 'call', 'motion', 'desktop', 'experience'];
async function boot(page) {
  await page.evaluate(async css => {
    await Promise.all(css.map(name => import(`/src/${name}.css`)));
    const { mountSystemChrome } = await import('/src/lib/system-chrome.ts'); mountSystemChrome();
    const { QuietRoomApp } = await import('/src/app.ts'); window.app = new QuietRoomApp(document.querySelector('#app')); await app.start();
  }, css);
}
async function password(page, secret, confirmation = secret) {
  const form = page.locator('.password-form'); await form.waitFor();
  await form.locator('[name=password]').fill(secret);
  if (await form.locator('[name=confirmation]').count()) await form.locator('[name=confirmation]').fill(confirmation);
  await form.locator('[type=submit]').click();
}
async function capture(page, name) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.waitForFunction(() => !document.querySelector('#app')?.dataset.pageTransition);
  await page.evaluate(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)); });
  await page.screenshot({ path: path.join(screenshots, `${name}.png`) });
}
async function chatContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const pixel = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const luminance = rgb => rgb.slice(0, 3).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const ratio = (fg, bg) => { const a = fg[3] / 255; const composed = fg.slice(0, 3).map((value, index) => value * a + bg[index] * (1 - a)); const l = [luminance(composed), luminance(bg)].sort((a, b) => b - a); return (l[0] + .05) / (l[1] + .05); };
    const probe = document.createElement('span'); probe.style.backgroundColor = 'color-mix(in oklch, var(--outgoing) 92%, white 8%)'; document.body.append(probe);
    const gradientStart = pixel(getComputedStyle(probe).backgroundColor); probe.remove();
    return [...document.querySelectorAll('.message-bubble')].flatMap(bubble => {
      const backgrounds = [pixel(getComputedStyle(bubble).backgroundColor)];
      if (bubble.closest('.outgoing')) backgrounds.push(gradientStart);
      return [...bubble.querySelectorAll('.message-text, .message-meta time, .message-delivery svg')].map(node => ({
        kind: node.matches('svg') ? 'icon' : 'text',
        ratio: Math.min(...backgrounds.map(bg => ratio(pixel(getComputedStyle(node).color), bg))),
      }));
    });
  });
}
try {
  await vite.listen(); const url = `http://localhost:${vite.httpServer.address().port}/__password_acceptance`;
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' })));
  for (const context of contexts) await context.addInitScript(() => { delete window.PublicKeyCredential; });
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
  // A real successful server response arriving after navigation cannot install
  // a vault or reclaim the foreground. The unused room is removed instead.
  const cancelledContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await cancelledContext.addInitScript(() => { delete window.PublicKeyCredential; });
  const cancelled = await cancelledContext.newPage();
  let releaseResponse, observeRequest;
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  const requestObserved = new Promise(resolve => { observeRequest = resolve; });
  await cancelled.route('**/api/rooms', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); observeRequest();
    await responseGate; await route.fulfill({ response });
  });
  await cancelled.goto(url); await boot(cancelled);
  await cancelled.locator('#create-room').click(); await password(cancelled, 'cancelled password 123');
  await requestObserved;
  assert.equal(await cancelled.locator('#create-room').isDisabled(), true, 'Pending creation can be duplicated');
  await cancelled.locator('#restore-cloud').click();
  const cleanup = cancelled.waitForResponse(response => response.request().method() === 'DELETE' && /\/api\/rooms\//.test(response.url()));
  releaseResponse(); assert.equal((await cleanup).ok(), true, 'Cancelled creation left an orphan room');
  assert.equal(await cancelled.evaluate(async () => { const { readStoredVault } = await import('/src/lib/vault.ts'); return Boolean(app.session || await readStoredVault()); }), false, 'Late creation installed a vault');
  await cancelledContext.close();
  await a.goto(url); await boot(a);
  assert.equal(await a.locator('#continue-browser').textContent(), '使用设备密钥找回空间');
  assert.equal(await a.locator('#restore-cloud').textContent(), '使用恢复码找回空间');
  await a.locator('#create-room').click();
  await capture(a, 'F15-password-create');
  await password(a, '🔐'.repeat(11)); assert.match(await a.locator('.password-form .form-error').textContent(), /12/);
  await password(a, '🔐'.repeat(12), 'different-password'); assert.match(await a.locator('.password-form .form-error').textContent(), /不一致/);
  await a.locator('[data-password-cancel]').click(); await a.locator('.password-sheet').waitFor({ state: 'detached' });
  assert.equal(await a.evaluate(async () => (await import('/src/lib/vault.ts')).hasStoredVault()), false, 'Cancelling new protection wrote a vault');
  await a.locator('#create-room').click(); await password(a, '🔐'.repeat(12));
  await a.locator('#invite-url').waitFor(); const invite = await a.locator('#invite-url').inputValue();
  const stored = await a.evaluate(async () => (await import('/src/lib/vault.ts')).readStoredVault());
  assert.equal(stored.v, 3); assert.equal(stored.unlockMethod, 'password');
  assert.ok(stored.wrappedKey && stored.payload && !stored.platform && !stored.ciphertext, 'New password space used a legacy format');
  assert.equal(JSON.stringify(stored).includes('🔐'), false, 'Password persisted in clear');
  await b.goto(invite); await boot(b); await b.locator('#new-device-alias').fill('测试 B'); await capture(b, 'F15-join-protection'); await b.locator('[data-device-verify]').click();
  await password(b, 'joiner password 🔑');
  for (const page of [a, b]) {
    await page.locator('#welcome-chat').waitFor(); await page.locator('#welcome-chat').click();
    await page.locator('.confirm-overlay').waitFor({ state: 'detached' });
    await page.waitForFunction(() => app.session?.vault.mls?.phase === 'active' && !document.querySelector('#message-input')?.disabled);
    if (await page.locator('.release-notes-sheet').count()) await page.locator('.release-notes-sheet button').last().click();
  }
  await capture(a, 'F02-hidden-entry-guide');
  assert.equal(await a.locator('.hidden-album-hint').count(), 1);
  assert.equal(await b.locator('.hidden-album-hint').count(), 0, 'Participant received the creator-only album hint');
  await a.locator('#message-input').fill('密码空间的真实加密消息'); await a.locator('#send-text').click();
  await b.getByText('密码空间的真实加密消息', { exact: true }).waitFor();
  await a.evaluate(() => {
    const message = [...app.messages.values()].find(item => item.payload.kind === 'text' && item.payload.text === '密码空间的真实加密消息');
    app.showMessageInfo(message);
  });
  await a.locator('[data-info-status]').waitFor(); await capture(a, 'F05-message-information');
  assert.match(await a.locator('[data-info-status]').textContent(), /已读|已送达|已保存/);
  await a.locator('.message-info-sheet button').click();
  // Every sensitive proof is fresh and bound to this original slot and operation.
  await a.evaluate(() => { window.proofResult = null; app.confirmDeviceCredential('合成验收操作').then(() => { window.proofResult = 'verified'; }, () => { window.proofResult = 'cancelled'; }); });
  await password(a, 'joiner password 🔑'); await a.waitForFunction(() => document.querySelector('.password-form .form-error')?.textContent.includes('密码不正确')); assert.match(await a.locator('.password-form .form-error').textContent(), /密码不正确/);
  assert.equal(await a.evaluate(() => proofResult), null);
  await capture(a, 'F15-password-reauth'); await a.locator('[data-password-cancel]').click();
  await a.waitForFunction(() => proofResult === 'cancelled');
  await a.evaluate(() => { window.proofResult = null; app.confirmDeviceCredential('合成验收操作').then(() => { window.proofResult = 'verified'; }, () => { window.proofResult = 'cancelled'; }); });
  await password(a, '🔐'.repeat(12)); await a.waitForFunction(() => proofResult === 'verified');
  assert.equal(await b.evaluate(() => app.session.vault.members.find(member => member.role === 'joiner').deviceName), 'iPhone · Safari · 测试 B');
  await a.evaluate(() => app.renderDeviceManager()); await a.locator('#device-back').waitFor(); await capture(a, 'F11-device-labels'); await a.locator('#device-back').click();
  await a.evaluate(() => app.renderLocalHistoryBackup()); await a.locator('#local-backup-export').click();
  await a.locator('#history-download').waitFor(); assert.equal(await a.locator('#history-download').textContent(), '导出备份');
  await capture(a, 'F04-backup-summary'); await a.locator('[data-history-summary-close]').click();
  await a.locator('#backup-help').click(); await capture(a, 'F13-backup-help'); await a.locator('#help-back').click();
  await a.evaluate(() => app.renderRecoveryCenter()); await capture(a, 'F07-recovery-code-guide');
  await a.locator('#save-my-code').click(); await a.locator('.password-form').waitFor(); await a.locator('[data-password-cancel]').click();
  await a.locator('.password-form').waitFor({ state: 'detached' });
  assert.equal(await a.locator('.local-recovery-code').count(), 0, 'Cancellation displayed a recovery code');
  assert.equal(await a.locator('.app-toast.error').count(), 0, 'Ordinary cancellation displayed an error');
  await a.locator('#save-my-code').click(); await password(a, '🔐'.repeat(12)); await a.locator('.local-recovery-code').waitFor();
  assert.ok((await a.locator('.local-recovery-code').textContent()).startsWith('QR4-')); await a.locator('#hide-local-recovery').click();
  if (await a.locator('#recovery-center-back').count()) await a.locator('#recovery-center-back').click();
  await a.evaluate(() => app.renderCoverPractice()); await capture(a, 'F08-cover-practice'); await a.locator('#practice-back').click();
  await a.evaluate(() => { app.galleryMode = 'favorites'; app.renderGallery('images'); }); await capture(a, 'F10-favorites'); await a.locator('#gallery-back').click();
  for (const width of [320, 390, 768, 1440]) {
    await a.setViewportSize({ width, height: width >= 768 ? 1000 : 844 });
    for (const colorScheme of ['light', 'dark']) {
      await a.emulateMedia({ colorScheme }); await capture(a, `F03-F09-chat-${width}-${colorScheme}`);
      const overflow = await a.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow, false, `Chat horizontally overflows at ${width} ${colorScheme}`);
      if (width === 390) {
        await b.emulateMedia({ colorScheme });
        const contrasts = [...await chatContrast(a), ...await chatContrast(b)];
        assert.ok(contrasts.some(sample => sample.kind === 'text'), 'No painted text sampled');
        assert.ok(contrasts.every(sample => sample.ratio >= (sample.kind === 'icon' ? 3 : 4.5)), `Chat contrast in ${colorScheme}: ${JSON.stringify(contrasts)}`);
        console.log(`Contrast ${colorScheme}: ${JSON.stringify(contrasts)}`);
      }
    }
  }
  await a.setViewportSize({ width: 320, height: 844 });
  await a.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await a.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await capture(a, 'F09-chat-320-text-200');
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Chat overflows with 200% text');
  await a.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await a.emulateMedia({ reducedMotion: 'no-preference' });
  await a.evaluate(() => app.lockNow());
  await a.evaluate(() => app.renderGateway({ trustedCoverActivation: true, autoUnlock: false }));
  await a.locator('#password-unlock').click(); await capture(a, 'F15-password-unlock');
  await password(a, '🔐'.repeat(12)); await a.locator('#message-input').waitFor();
  await a.evaluate(() => { const v = app.session; window.proofResult = null; app.confirmDeviceCredential('取消后不得继续').then(() => { window.proofResult = 'verified'; }, () => { window.proofResult = 'cancelled'; }); });
  await a.locator('.password-form [name=password]').fill('🔐'.repeat(12));
  await a.evaluate(() => app.lockNow());
  await a.waitForFunction(() => proofResult === 'cancelled'); assert.equal(await a.locator('#message-input').count(), 0);
  const partialContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const partial = await partialContext.newPage(); await partial.goto(url); await boot(partial);
  const summaries = await partial.evaluate(async () => {
    const v = await import('/src/lib/vault.ts'), c = await import('/src/lib/backup-crypto.ts'), b = await import('/src/lib/local-history-backup.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts'); const { encryptFileAttachment } = await import('/src/lib/file-crypto.ts');
    const { createLocalBackupFile } = await import('/src/lib/local-backup-file.ts');
    const identity = await generateIdentity(), sentAt = new Date().toISOString(), roomId = crypto.randomUUID();
    const session = await v.createVault({ v: 1, roomId, role: 'creator', identity, accessToken: c.randomBackupSecret(), pairingSecret: '', creatorFingerprint: 'synthetic',
      members: [{ ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null }], lastSeq: 10, createdAt: sentAt, protocol: 'legacy-v1',
      backup: { v: 1, ...c.newRecoveryCode(), revision: 1, cursor: 10, archives: [{ id: c.randomBackupSecret(), key: c.randomBackupSecret(), token: c.randomBackupSecret(), parts: [] }], syncedAt: sentAt } }, 'synthetic partial password', 'password');
    const manifest = await encryptFileAttachment(new File([new Uint8Array([1, 2, 3])], 'synthetic.png', { type: 'image/png' }), {
      reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }), upload: async () => {}, complete: async () => {}, savePlan: async () => {},
    });
    for (let i = 0; i < 10; i++) await v.saveHistoryMessage(session, { seq: i + 1, clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId,
      payload: i < 6 ? { v: 1, kind: 'text', text: `合成文字 ${i + 1}`, sentAt } : { v: 1, kind: 'image', image: { ...manifest, blobId: crypto.randomUUID() }, sentAt }, acceptedAt: sentAt, status: 'stored' });
    const signal = new AbortController().signal;
    const summary = await b.summarizeLocalHistory(session, signal), output = await createLocalBackupFile(signal);
    const exported = await b.exportLocalHistory(session, output.sink, signal), file = await output.finish();
    const preview = await b.previewLocalHistoryBackup(session, file, signal); await output.dispose();
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController(); app.renderLocalHistoryBackup();
    return [summary, exported, preview].map(({ text, images, attachments, missingAttachments, missingByKind }) => ({ text, images, attachments, missingAttachments, missingByKind }));
  });
  for (const summary of summaries) assert.deepEqual(summary, { text: 6, images: 4, attachments: 0, missingAttachments: 4, missingByKind: { image: 4 } });
  await partial.locator('#local-backup-export').click(); await partial.locator('#history-download').waitFor();
  assert.equal(await partial.locator('#history-download').textContent(), '继续导出部分备份');
  await partial.locator('.backup-completeness summary').click();
  assert.match(await partial.locator('.backup-completeness').textContent(), /图片：4 个原文件缺失/);
  await capture(partial, 'F04-partial-backup-6-text-4-images'); await partialContext.close();
  // The remaining creation entrances use the same actual password wrapper,
  // with the existing source device approving the real membership event.
  await a.evaluate(() => app.renderGateway({ trustedCoverActivation: true, autoUnlock: false }));
  await a.locator('#password-unlock').click(); await password(a, '🔐'.repeat(12)); await a.locator('#message-input').waitFor();
  await a.evaluate(() => app.renderDeviceManager());
  for (const repair of [false, true]) {
    if (repair) await a.locator('.peer-device-section').getByRole('button', { name: '修复此设备', exact: true }).first().click();
    else await a.getByRole('button', { name: '添加设备', exact: true }).click();
    const link = await a.locator('.device-link-sheet input[aria-label="设备链接"]').inputValue();
    const extraContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await extraContext.addInitScript(() => { delete window.PublicKeyCredential; });
    const extra = await extraContext.newPage(); await extra.goto(link); await boot(extra);
    await extra.locator('[data-device-verify]').click(); await password(extra, repair ? 'repair password 123' : 'device password 123');
    const retry = extra.locator(repair ? '#retry-repair' : '#retry-device-link'); await retry.waitFor();
    const code = (await extra.locator('.device-safety-code').textContent()).trim();
    await a.locator('.device-link-sheet [data-close]').click(); await a.locator('.device-link-sheet').waitFor({ state: 'detached' });
    await a.locator('#refresh-devices').click();
    const pendingCard = a.locator('.pending-device-card').filter({ hasText: code });
    await pendingCard.getByRole('button', { name: /安全码一致/ }).click();
    await pendingCard.waitFor({ state: 'detached' });
    if (await retry.count()) await retry.click().catch(() => undefined);
    await extra.locator('.chat-shell').waitFor();
    await extra.waitForFunction(() => app.session?.vault.mls?.phase === 'active');
    assert.equal(await extra.evaluate(() => app.session.stored.unlockMethod), 'password');
    assert.equal(await extra.evaluate(() => app.session.stored.v), 3);
    await capture(extra, repair ? 'F15-repair-password-complete' : 'F15-device-password-complete');
    await extraContext.close(); await a.locator('#refresh-devices').click();
  }
  console.log('PASS real password creation, invitation, encryption, exact-slot reauthentication, cancellation, unlock, responsive UI');
} finally { await browser?.close(); await vite.close(); await backend.close(); await rm(dataDir, { recursive: true, force: true }); }
