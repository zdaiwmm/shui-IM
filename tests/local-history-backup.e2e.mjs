import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

let vite, browser;
try {
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'local-backup-fixture', configureServer(server) {
      server.middlewares.use('/__local', (_request, response) => {
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="app"></div>');
      });
    } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://localhost:${vite.httpServer.address().port}/__local`);
  const result = await page.evaluate(async () => {
    const v = await import('/src/lib/vault.ts');
    const c = await import('/src/lib/backup-crypto.ts');
    const b = await import('/src/lib/local-history-backup.ts');
    const { createLocalBackupFile } = await import('/src/lib/local-backup-file.ts');
    const { encryptFileAttachment, decryptFileAttachment } = await import('/src/lib/file-crypto.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const identity = await generateIdentity();
    const roomId = crypto.randomUUID(), sentAt = new Date().toISOString();
    const archive = { id: c.randomBackupSecret(), key: c.randomBackupSecret(), token: c.randomBackupSecret(), parts: [] };
    const base = { v: 1, roomId, role: 'creator', identity, accessToken: c.randomBackupSecret(), pairingSecret: '', creatorFingerprint: 'fixture',
      members: [{ ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null }], lastSeq: 3, createdAt: sentAt, protocol: 'legacy-v1',
      backup: { v: 1, ...c.newRecoveryCode(), revision: 1, cursor: 3, archives: [archive], syncedAt: sentAt } };
    let session = await v.createVault(base, 'synthetic-local-backup-password', 'password');
    const bytes = new Uint8Array(5 * 1024 * 1024 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const original = new File([bytes], 'original-video.mp4', { type: 'video/mp4' });
    const manifest = await encryptFileAttachment(original, {
      reserve: async () => {}, status: async () => ({ uploadedIndexes: [], completed: false }),
      upload: async (id, index, chunk) => v.saveCachedMediaChunk(session, id, index, chunk),
      complete: async () => {}, savePlan: async () => {},
    });
    const messages = [
      { v: 1, kind: 'text', text: 'synthetic private text', sentAt },
      { v: 1, kind: 'file', file: manifest, sentAt },
      { v: 1, kind: 'file', file: { ...manifest, blobId: crypto.randomUUID() }, sentAt },
    ].map((payload, i) => ({ seq: i + 1, clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId,
      payload, acceptedAt: sentAt, status: 'stored' }));
    for (const message of messages) await v.saveHistoryMessage(session, message);
    await v.saveUiPreferences(session, { hiddenChatMessageIds: [messages[0].clientMsgId] });
    const controller = new AbortController();
    const output = await createLocalBackupFile(controller.signal);
    const exported = await b.exportLocalHistory(session, output.sink, controller.signal);
    const file = await output.finish();
    // Synthetic fixture keeps an independent browser Blob, modeling a file saved outside site storage.
    const saved = new Blob([await file.arrayBuffer()]);
    await output.dispose();
    await v.clearLocalBrowserData(session); await v.deleteCurrentVault();
    session = await v.createVault({ ...base, lastSeq: 0 }, 'synthetic-local-backup-password', 'password');
    let network = 0;
    const realFetch = window.fetch;
    window.fetch = async () => { network++; throw new Error('Import must never use the network'); };
    let damagedRejected = false;
    const damaged = new Uint8Array(await saved.arrayBuffer()); damaged[damaged.length - 1] ^= 1;
    try { await b.importLocalHistory(session, new Blob([damaged]), controller.signal); } catch { damagedRejected = true; }
    const cleanAfterDamage = (await v.loadHistory(session)).length === 0;
    const imported = await b.importLocalHistory(session, saved, controller.signal);
    const repeated = await b.importLocalHistory(session, saved, controller.signal);
    const restored = await decryptFileAttachment(manifest, (id, index) => v.loadCachedMediaChunk(session, id, index,
      Math.min(manifest.chunkSize, manifest.originalSize - index * manifest.chunkSize) + 16));
    const actual = new Uint8Array(await restored.arrayBuffer());
    const originalEqual = bytes.length === actual.length && bytes.every((byte, i) => actual[i] === byte);
    const hiddenPreserved = (await v.loadUiPreferences(session)).hiddenChatMessageIds.includes(messages[0].clientMsgId);
    await v.saveUiPreferences(session, { composerDraft: 'queued before import' });
    const hiddenSurvivesQueuedSave = (await v.loadUiPreferences(session)).hiddenChatMessageIds.includes(messages[0].clientMsgId);
    let wrongRole = false, wrongRoom = false, wrongIdentity = false;
    session.vault.role = 'joiner';
    try { await b.importLocalHistory(session, saved, controller.signal); } catch { wrongRole = true; }
    session.vault.role = 'creator'; session.vault.roomId = crypto.randomUUID();
    try { await b.importLocalHistory(session, saved, controller.signal); } catch { wrongRoom = true; }
    session.vault.roomId = roomId; session.vault.backup.archives = [];
    try { await b.importLocalHistory(session, saved, controller.signal); } catch { wrongIdentity = true; }
    window.fetch = realFetch;
    session.vault.backup.archives = [archive];
    const unchangedSeq = session.vault.lastSeq;
    session.vault.lastSeq = 3; await v.saveVault(session);
    await Promise.all(['/src/styles.css', '/src/chat-layout.css', '/src/auth-recovery.css', '/src/chat-interactions.css', '/src/cover.css', '/src/recovery-experience.css'].map(file => import(file)));
    const { QuietRoomApp } = await import('/src/app.ts');
    const app = new QuietRoomApp(document.querySelector('#app')); await app.start();
    app.session = session; app.privacyCovered = false; app.runtimeAbort = new AbortController();
    document.body.className = 'app-mode'; app.revealPrivacySurface(); app.renderLocalHistoryBackup();
    window.fixtureApp = app;
    return { exported, imported, repeated, damagedRejected, cleanAfterDamage, originalEqual, hiddenPreserved,
      hiddenSurvivesQueuedSave, wrongRole, wrongRoom, wrongIdentity, network, lastSeq: unchangedSeq,
      categories: { text: exported.text, images: exported.images, videos: exported.videos, voice: exported.voice, files: exported.files, expressions: exported.expressions } };
  });
  assert.equal(result.exported.messages, 3);
  assert.equal(result.exported.attachments, 1);
  assert.equal(result.exported.missingAttachments, 1);
  assert.deepEqual(result.categories, { text: 1, images: 0, videos: 2, voice: 0, files: 0, expressions: 0 });
  assert.equal(result.imported.imported, 3);
  assert.equal(result.repeated.imported, 0);
  for (const key of ['damagedRejected', 'cleanAfterDamage', 'originalEqual', 'hiddenPreserved', 'hiddenSurvivesQueuedSave', 'wrongRole', 'wrongRoom', 'wrongIdentity']) assert.equal(result[key], true, key);
  assert.equal(result.network, 0); assert.equal(result.lastSeq, 0);
  const introLayouts = await page.evaluate(() => {
    const app = window.fixtureApp;
    const session = app.session;
    const read = () => {
      const mark = document.querySelector('.gateway-mark');
      const title = document.querySelector('.gateway-heading h1');
      const actions = document.querySelector('.welcome-actions');
      const content = document.querySelector('.gateway-intro-content');
      const primary = actions?.querySelector('.primary-button');
      const secondary = actions?.querySelector('.text-button');
      const box = node => node?.getBoundingClientRect();
      const markBox = box(mark), titleBox = box(title), actionsBox = box(actions), contentBox = box(content);
      return {
        intro: Boolean(document.querySelector('.gateway-intro')),
        markVisible: Boolean(markBox && markBox.width > 0 && markBox.height > 0),
        markLeft: markBox?.left, markTop: markBox?.top,
        titleLeft: titleBox?.left, titleTop: titleBox?.top,
        actionsLeft: actionsBox?.left, actionsBottom: actionsBox ? innerHeight - actionsBox.bottom : undefined,
        primaryHeight: box(primary)?.height, secondaryHeight: box(secondary)?.height,
        contentScrolls: Boolean(contentBox && content.scrollHeight > content.clientHeight + 1),
      };
    };
    app.renderLocalHistoryBackup('export'); const backup = read();
    app.renderLocalHistoryBackup('import'); const restore = read();
    app.renderCreate(); const create = read();
    app.session = null; app.renderFirstRun(null); const welcome = read();
    app.session = session; app.runtimeAbort = new AbortController(); app.privacyCovered = false;
    app.renderRecoveryCenter(); const recovery = read();
    app.renderLocalHistoryBackup('export');
    return { backup, restore, create, welcome, recovery };
  });
  for (const name of ['backup', 'restore', 'create', 'welcome']) {
    const layout = introLayouts[name];
    assert.equal(layout.intro, true, `${name}: shared intro layout missing`);
    assert.equal(Math.round(layout.markLeft), 20, `${name}: icon left anchor`);
    assert.equal(Math.round(layout.titleLeft), 20, `${name}: title left anchor`);
    assert.equal(Math.round(layout.actionsLeft), 20, `${name}: actions left anchor`);
    assert.equal(Math.round(layout.actionsBottom), 30, `${name}: actions bottom anchor`);
    assert.equal(Math.round(layout.primaryHeight), 52, `${name}: primary height`);
    assert.ok(Math.round(layout.secondaryHeight) >= 44, `${name}: secondary height`);
  }
  for (const name of ['restore', 'create', 'welcome']) {
    assert.equal(Math.round(introLayouts[name].markTop), Math.round(introLayouts.backup.markTop), `${name}: icon top anchor`);
    assert.equal(Math.round(introLayouts[name].titleTop), Math.round(introLayouts.backup.titleTop), `${name}: title top anchor`);
  }
  assert.equal(introLayouts.recovery.intro, true, 'recovery: shared intro layout missing');
  assert.equal(introLayouts.recovery.markVisible, false, 'recovery: dense layout retained the icon');
  assert.equal(Math.round(introLayouts.recovery.titleTop), 56, 'recovery: dense title top anchor');
  assert.equal(Math.round(introLayouts.recovery.actionsBottom), 30, 'recovery: actions bottom anchor');
  await page.setViewportSize({ width: 390, height: 620 });
  const compactLayout = await page.evaluate(() => {
    window.fixtureApp.renderRecoveryCenter();
    const mark = document.querySelector('.gateway-mark')?.getBoundingClientRect();
    const title = document.querySelector('.gateway-heading h1')?.getBoundingClientRect();
    const actions = document.querySelector('.welcome-actions')?.getBoundingClientRect();
    const content = document.querySelector('.gateway-intro-content');
    return {
      markVisible: Boolean(mark && mark.width > 0 && mark.height > 0),
      titleTop: title?.top,
      actionsBottom: actions ? innerHeight - actions.bottom : undefined,
      contentScrolls: Boolean(content && content.scrollHeight > content.clientHeight + 1),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  assert.equal(compactLayout.markVisible, false, 'compact layout retained the icon');
  assert.equal(Math.round(compactLayout.titleTop), 48, 'compact title top anchor');
  assert.equal(Math.round(compactLayout.actionsBottom), 18, 'compact actions bottom anchor');
  assert.equal(compactLayout.contentScrolls, true, 'compact long content did not scroll independently');
  assert.equal(compactLayout.horizontalOverflow, false, 'compact intro layout overflowed horizontally');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.fixtureApp.renderLocalHistoryBackup('export'));
  await page.locator('#local-backup-export').click();
  await page.locator('#history-download').waitFor({ state: 'visible' });
  await page.locator('#history-download').click();
  await page.locator('#history-download').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  assert.equal(await page.locator('#local-backup-export').textContent(), '备份聊天记录');
  assert.equal(await page.locator('#open-local-import, #local-backup-ready').count(), 0);
  for (const width of [390, 375]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 812 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const targets = await page.locator('#local-backup-export, #local-backup-back').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height >= 44));
    assert.equal(targets, true, '44px controls');
  }
  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
  await page.evaluate(() => window.fixtureApp.renderCoverPractice());
  const coverGeometry = await page.evaluate(() => {
    const hotspot = document.querySelector('.cover-practice-page .practice-hotspot')?.getBoundingClientRect();
    const guide = document.querySelector('.cover-practice-page .hold-guide')?.getBoundingClientRect();
    const notice = document.querySelector('.cover-practice-notice');
    const back = document.querySelector('#practice-back')?.getBoundingClientRect();
    const noticeBox = notice?.getBoundingClientRect();
    if (!hotspot || !guide || !noticeBox || !back) return null;
    return {
      width: Math.round(hotspot.width),
      height: Math.round(hotspot.height),
      right: innerWidth - hotspot.right,
      bottom: innerHeight - hotspot.bottom,
      guideAbove: guide.bottom <= hotspot.top + 8,
      notice: notice?.textContent ?? '',
      noticeBelowBack: noticeBox.top >= back.bottom - 1,
      noticeLeft: noticeBox.left,
      noticeRight: innerWidth - noticeBox.right,
    };
  });
  assert.equal(coverGeometry?.width, 80);
  assert.equal(coverGeometry?.height, 80);
  assert.ok((coverGeometry?.right ?? 99) <= 8, 'practice hotspot is not at the live cover right edge');
  assert.ok((coverGeometry?.bottom ?? 99) <= 8, 'practice hotspot is not at the live cover bottom edge');
  assert.equal(coverGeometry?.guideAbove, true);
  assert.match(coverGeometry?.notice ?? '', /离开私密空间后.*自动进入遮蔽层/);
  assert.equal(coverGeometry?.noticeBelowBack, true, 'cover practice notice overlaps the back button');
  assert.ok((coverGeometry?.noticeLeft ?? 0) >= 12, 'cover practice notice does not keep left inset');
  assert.ok((coverGeometry?.noticeRight ?? 0) >= 12, 'cover practice notice does not keep right inset');
  const resumedPractice = await page.evaluate(() => {
    const app = window.fixtureApp;
    const session = app.session;
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ?? Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    app.lockNow();
    if (hidden) Object.defineProperty(document, 'hidden', hidden);
    else delete document.hidden;
    app.gatewayRenderEpoch += 1;
    app.privacyCovered = false;
    app.session = session;
    app.runtimeAbort = new AbortController();
    document.body.className = 'app-mode';
    app.revealPrivacySurface();
    app.resumeUnlockedPage();
    return Boolean(document.querySelector('.cover-practice-page'));
  });
  assert.equal(resumedPractice, true, 'Unlock did not return to the cover practice page');
  await page.evaluate(() => {
    const app = window.fixtureApp;
    app.session.vault.recoveryExperience = { ...app.session.vault.recoveryExperience, coverEnabled: true };
    localStorage.setItem('quiet-room:cover-enabled', '1');
    app.renderChat();
  });
  await page.locator('.more-menu summary').click();
  await page.locator('#cover-practice-menu').click();
  await page.locator('#disable-cover-anyway').waitFor();
  assert.equal(await page.locator('#keep-cover-enabled').textContent(), '我再想想');
  assert.equal(await page.locator('#disable-cover-anyway').textContent(), '执意关闭');
  await page.locator('#keep-cover-enabled').click();
  await page.locator('#disable-cover-dialog').waitFor({ state: 'detached' });
  await page.locator('.more-menu summary').click();
  await page.locator('#cover-practice-menu').click();
  await page.locator('#disable-cover-anyway').click();
  await page.getByText('关闭成功').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('quiet-room:cover-enabled')), '0');
  const brandedCover = await page.evaluate(() => {
    const app = window.fixtureApp;
    const session = app.session;
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ?? Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    app.lockNow();
    const branded = [...document.querySelectorAll('h1, p')].some(node => /Quiet Room|两个人的私密空间/.test(node.textContent ?? ''));
    if (hidden) Object.defineProperty(document, 'hidden', hidden);
    else delete document.hidden;
    app.gatewayRenderEpoch += 1;
    app.privacyCovered = false;
    app.session = session;
    app.runtimeAbort = new AbortController();
    document.body.className = 'app-mode';
    app.revealPrivacySurface();
    app.renderLocalHistoryBackup('export');
    return branded;
  });
  assert.equal(brandedCover, false, 'Cover-off still shows the Quiet Room entry page');
  if (process.env.V8_VISUAL_DIR) {
    await mkdir(process.env.V8_VISUAL_DIR, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'backup-390x844.png'), fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'backup-375x812.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'backup-dark-390x844.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'backup-landscape-844x390.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.fixtureApp.renderLocalHistoryBackup('import'));
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'history-import-390x844.png'), fullPage: true });
    await page.evaluate(() => window.fixtureApp.renderRecoveryCenter());
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'recovery-center-390x844.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 620 });
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'recovery-center-390x620.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.fixtureApp.renderCoverPractice());
    await page.screenshot({ path: path.join(process.env.V8_VISUAL_DIR, 'cover-practice-390x844.png'), fullPage: true });
    await page.evaluate(() => window.fixtureApp.renderLocalHistoryBackup('export'));
  }
  await page.evaluate(() => window.fixtureApp.lockNow());
  await page.locator('#local-backup-export').waitFor({ state: 'detached' });
  console.log('Local backup browser regression passed: original bytes, OPFS output, no-network import, corruption, lineage, role, room, idempotency and deletion projections.');
} finally { await browser?.close(); await vite?.close(); }
