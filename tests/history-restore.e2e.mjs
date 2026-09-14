import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
let vite, browser;
const screenshots = process.argv[2];
try {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  vite = await createServer({ configFile: false, appType: 'custom', root: process.cwd(), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'history-fixture', configureServer(server) {
      server.middlewares.use('/__restore', (_request, response) => {
        response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div>');
      });
    } }] });
  await vite.listen();
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => console.error('Fixture page error:', error.stack));
  await page.goto(`http://localhost:${vite.httpServer.address().port}/__restore`);
  await page.evaluate(async () => {
    await Promise.all(['/src/styles.css', '/src/design-system.css', '/src/chat-layout.css', '/src/auth-recovery.css', '/src/chat-interactions.css', '/src/backup.css'].map(file => import(file)));
    const v = await import('/src/lib/vault.ts');
    const b = await import('/src/lib/cloud-backup.ts');
    const c = await import('/src/lib/backup-crypto.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { randomBase64Url } = await import('/src/lib/base64.ts');
    const { attachHistoryRestore } = await import('/src/lib/history-restore-ui.ts');
    const identity = await generateIdentity();
    const roomId = crypto.randomUUID(), sentAt = '2026-09-14T00:00:00.000Z';
    const image = { v: 1, blobId: crypto.randomUUID(), key: randomBase64Url(32), ivPrefix: randomBase64Url(8), chunkSize: 2097152,
      chunkCount: 1, originalSize: 10, originalName: 'synthetic.png', mimeType: 'image/png', lastModified: 1, sha256: 'a'.repeat(64) };
    const payloads = [{ kind: 'text', text: 'restored chat' }, { kind: 'gallery-image', image }, { kind: 'image', image }, { kind: 'image', image }];
    const messages = payloads.map((payload, index) => ({ seq: index + 1, clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId,
      payload: { v: 1, sentAt, ...payload }, acceptedAt: sentAt, status: 'stored' }));
    messages.push({ seq: 5, clientMsgId: crypto.randomUUID(), senderId: identity.publicBundle.deviceId, payload: { v: 1, kind: 'message-delete', sentAt,
      target: { clientMsgId: messages[3].clientMsgId, serverSeq: 4, senderId: identity.publicBundle.deviceId } }, acceptedAt: sentAt, status: 'stored' });
    const hidden = { v: 1, category: 'images', clientMsgId: messages[2].clientMsgId, assetIndex: 0, hidden: true, pinnedAt: null };
    const recovery = c.newRecoveryCode();
    const checkpoint = { v: 1, roomId, role: 'creator', identity, accessToken: 'synthetic', members: [{ ...identity.publicBundle, role: 'creator', status: 'active', joinProof: null }],
      lastSeq: 5, createdAt: sentAt, protocol: 'mls-rfc9420' };
    const archive = { id: c.randomBackupSecret(), key: c.randomBackupSecret(), token: c.randomBackupSecret(), parts: [] };
    const responses = new Map();
    for (const records of [messages.slice(0, 2), messages.slice(2, 4), messages.slice(4)]) {
      const id = c.randomBackupSecret();
      const sealed = await c.sealJson({ v: 1, roomId, messages: records }, archive.key, c.archiveAad(roomId, archive.id, id));
      archive.parts.push({ id, digest: await c.backupDigest(sealed), firstSeq: records[0].seq, lastSeq: records.at(-1).seq, count: records.length });
      responses.set(`/api/history-archives/${archive.id}/${id}`, sealed);
    }
    const bundle = { v: 1, backupId: recovery.id, deviceId: identity.publicBundle.deviceId, roomId, checkpoint, archives: [archive], galleryHidden: [hidden] };
    responses.set(`/api/recovery-backups/${recovery.id}`, { revision: 1, sealed: await c.sealRecovery(bundle, recovery.code) });
    let target, controller;
    const originalFetch = window.fetch;
    window.fixture = { code: recovery.code, hidden, messages, responses, delay: 0, requests: 0, fail: false,
      async setup(role = 'creator') {
        controller?.abort();
        if (target) await v.clearLocalBrowserData(target);
        await v.deleteCurrentVault();
        target = await v.createVault({ ...checkpoint, role, lastSeq: 0, protocol: 'legacy-v1' }, 'synthetic-restore-password', 'password');
        target.vault.backup = { v: 1, ...c.newRecoveryCode(), revision: 1, cursor: 0, archives: [], syncedAt: sentAt };
        controller = new AbortController();
        document.body.className = 'app-mode';
        document.querySelector('#app').innerHTML = '<main class="backup-page"><header class="subpage-header"><h1>备份与恢复</h1></header><section class="backup-content"><div class="backup-settings-group"><section class="backup-setting"><h2>恢复历史内容</h2><button class="secondary-button" data-restore="all">恢复历史记录</button></section></div></section></main>';
        attachHistoryRestore({ root: document.querySelector('#app'), session: target, signal: controller.signal,
          isActive: () => !controller.signal.aborted, withClipboard: action => action(), onChanged: () => {} });
      },
      async extraCode({ conflict = false, wrongRoom = false } = {}) {
        const other = c.newRecoveryCode();
        const extra = conflict ? { ...messages[0], payload: { ...messages[0].payload, text: 'conflicting text' } }
          : { ...messages[0], seq: 6, clientMsgId: crypto.randomUUID(), payload: { v: 1, sentAt, kind: 'gallery-image', image } };
        const id = c.randomBackupSecret();
        const sealed = await c.sealJson({ v: 1, roomId, messages: [extra] }, archive.key, c.archiveAad(roomId, archive.id, id));
        responses.set(`/api/history-archives/${archive.id}/${id}`, sealed);
        const extraRoom = wrongRoom ? crypto.randomUUID() : roomId;
        const next = { ...bundle, backupId: other.id, roomId: extraRoom, checkpoint: { ...checkpoint, roomId: extraRoom },
          archives: [{ ...archive, parts: [...archive.parts, { id, digest: await c.backupDigest(sealed), firstSeq: extra.seq, lastSeq: extra.seq, count: 1 }] }] };
        responses.set(`/api/recovery-backups/${other.id}`, { revision: 1, sealed: await c.sealRecovery(next, other.code) });
        return other.code;
      },
      restore: async (codes = recovery.code, abort = new AbortController(), onProgress = () => {}) => b.restoreUnifiedHistory(target, codes, abort.signal, onProgress),
      history: () => v.loadHistory(target), preferences: () => v.loadUiPreferences(target),
      saveStalePreferences: () => v.saveUiPreferences(target, { composerDraft: 'later draft' }),
      abort: () => controller.abort(), target: () => target,
    };
    window.fetch = async (url, options) => {
      if (!responses.has(String(url))) return originalFetch(url, options);
      window.fixture.requests++;
      if (window.fixture.delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, window.fixture.delay);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
      });
      if (window.fixture.fail) throw new TypeError('synthetic network interruption');
      return new Response(JSON.stringify(responses.get(String(url))), { headers: { 'Content-Type': 'application/json' } });
    };
    await window.fixture.setup();
  });
  const restored = await page.evaluate(async () => {
    const f = window.fixture;
    const progress = [];
    const result = await f.restore(`${f.code}\n${f.code}`, undefined, value => progress.push(value));
    await f.saveStalePreferences();
    const prefs = await f.preferences();
    const history = await f.history();
    const { reduceMessageDeletions } = await import('/src/lib/message-deletions.ts');
    const deleted = reduceMessageDeletions(history, new Map([[f.target().vault.identity.publicBundle.deviceId, 'creator']]));
    const retry = await f.restore();
    return { result, retry, count: history.length, direct: history.some(m => m.payload.kind === 'gallery-image'),
      hidden: prefs.galleryCuration?.some(record => record.hidden && record.clientMsgId === f.hidden.clientMsgId),
      deleted: deleted.has(f.messages[3].clientMsgId), readingIndeterminate: progress.filter(p => p.phase === 'reading').every(p => p.percent === null),
      monotonic: progress.filter(p => p.percent !== null).every((p, i, values) => i === 0 || p.percent >= values[i - 1].percent),
      cursor: f.target().vault.lastSeq, requests: f.requests };
  });
  assert.equal(restored.count, 5); assert.equal(restored.direct, true); assert.equal(restored.hidden, true); assert.equal(restored.deleted, true);
  assert.deepEqual(restored.result.chat, { restored: 3, total: 3 }); assert.deepEqual(restored.result.gallery, { restored: 3, total: 3 });
  assert.equal(restored.retry.changed, false); assert.equal(restored.cursor, 0); assert.equal(restored.readingIndeterminate, true); assert.equal(restored.monotonic, true);
  assert.equal(restored.requests, 8, 'one code and three parts per run, no duplicate downloads for a bounded archive');
  const cancelled = await page.evaluate(async () => {
    const f = window.fixture; await f.setup();
    const abort = new AbortController(); let interrupted = false;
    try { await f.restore(f.code, abort, value => { if (value.phase === 'restoring' && value.chat.restored >= 1) abort.abort(); }); }
    catch (error) { interrupted = error.name === 'AbortError'; }
    const partial = await f.history();
    const deletionFirst = partial.some(m => m.payload.kind === 'message-delete');
    const final = await f.restore();
    return { interrupted, deletionFirst, final, count: (await f.history()).length };
  });
  assert.equal(cancelled.interrupted, true); assert.equal(cancelled.deletionFirst, true); assert.equal(cancelled.count, 5); assert.equal(cancelled.final.percent, 100);
  const merged = await page.evaluate(async () => {
    const f = window.fixture; await f.setup();
    const extra = await f.extraCode();
    const result = await f.restore(`${f.code}\n${extra}`);
    const count = (await f.history()).length;
    await f.setup();
    let conflict = false, wrongRoom = false;
    try { await f.restore(`${f.code}\n${await f.extraCode({ conflict: true })}`); } catch (error) { conflict = error.message.includes('冲突'); }
    try { await f.restore(await f.extraCode({ wrongRoom: true })); } catch (error) { wrongRoom = error.message.includes('不属于当前会话'); }
    return { result, count, conflict, wrongRoom, noPartialWrites: (await f.history()).length === 0 };
  });
  assert.equal(merged.count, 6); assert.equal(merged.result.gallery.total, 4);
  assert.equal(merged.conflict, true); assert.equal(merged.wrongRoom, true); assert.equal(merged.noPartialWrites, true);
  await page.evaluate(async () => { await window.fixture.setup(); window.fixture.delay = 350; });
  await page.evaluate(() => {
    window.fixture.clipboard = ''; window.fixture.permission = 'granted';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => window.fixture.clipboard } });
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: window.fixture.permission }) } });
  });
  await page.locator('[data-restore]').click();
  await page.locator('[data-clipboard=empty]').waitFor();
  assert.equal(await page.locator('[data-paste]').isDisabled(), true);
  await page.locator('[data-close]').click();
  await page.locator('.history-restore-sheet').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.fixture.clipboard = window.fixture.code; });
  await page.locator('[data-restore]').click();
  await page.locator('[data-clipboard=content]').waitFor();
  await page.locator('[data-paste]').click();
  assert.equal(await page.locator('textarea').inputValue(), await page.evaluate(() => window.fixture.code));
  assert.equal(await page.locator('[type=submit]').isEnabled(), true);
  assert.equal(await page.locator('textarea').evaluate(el => el === document.activeElement), true);
  await page.locator('[data-close]').click();
  await page.locator('.history-restore-sheet').waitFor({ state: 'detached' });
  await page.evaluate(() => { window.fixture.permission = 'prompt'; });
  await page.locator('[data-restore]').click();
  assert.equal(await page.locator('[data-clipboard=unknown]').count(), 1, 'no clipboard permission prompt on open');
  assert.equal(await page.locator('.history-restore-sheet:not(.is-closing) textarea').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('[type=submit]').isDisabled(), true);
  await page.locator('.history-restore-sheet:not(.is-closing) textarea').fill('   '); assert.equal(await page.locator('[type=submit]').isDisabled(), true);
  for (const [name, width, height, colorScheme] of [['light', 390, 844, 'light'], ['narrow-dark', 320, 740, 'dark']]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme });
    const fits = await page.locator('.history-restore-panel').evaluate(node => { const r = node.getBoundingClientRect(); return r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight; });
    assert(fits, `${name}: panel fits`);
    if (screenshots) await page.screenshot({ path: `${screenshots}/input-${name}.png` });
  }
  await page.locator('.history-restore-sheet:not(.is-closing) textarea').fill(await page.evaluate(() => window.fixture.code));
  await page.locator('[type=submit]').click();
  assert.equal(await page.locator('.history-restore-sheet.is-closing textarea').inputValue(), '', 'code is cleared during exit animation');
  await page.locator('[data-dismiss]').click();
  assert.match(await page.locator('[data-restore]').textContent(), /正在恢复中/);
  await page.locator('[data-restore]').click();
  await page.getByRole('heading', { name: '恢复完成', exact: true }).waitFor();
  assert.equal(await page.locator('[data-count=gallery]').count(), 1);
  if (screenshots) await page.screenshot({ path: `${screenshots}/progress-dark.png` });
  await page.locator('[data-dismiss]').click();
  const participant = await page.evaluate(async () => { window.fixture.delay = 0; await window.fixture.setup('joiner'); const result = await window.fixture.restore(); return { result, direct: (await window.fixture.history()).some(m => m.payload.kind === 'gallery-image') }; });
  assert.equal(participant.result.gallery, undefined); assert.equal(participant.direct, false);
  await page.locator('[data-restore]').click();
  await page.locator('.history-restore-sheet:not(.is-closing) textarea').fill(await page.evaluate(() => window.fixture.code));
  await page.evaluate(() => { window.fixture.fail = true; });
  await page.locator('[type=submit]').click();
  await page.getByRole('heading', { name: '恢复未完成', exact: true }).waitFor();
  assert.equal(await page.locator('[data-count=gallery]').count(), 0);
  assert.equal(await page.locator('[data-retry]').isVisible(), true);
  await page.locator('[data-retry]').click();
  assert.equal(await page.locator('.history-restore-sheet:not(.is-closing) textarea').evaluate(el => el === document.activeElement), true);
  await page.evaluate(() => window.fixture.abort());
  assert.equal(await page.locator('.history-restore-sheet').count(), 0, 'lock removes dialogs synchronously');
  console.log('Unified restore passed: all records, direct Safe uploads, durable deletions, retry/dedup, abort, unchanged cursor, exact totals, focus, error, roles, themes and narrow layout.');
} finally { await browser?.close(); await vite?.close(); }
