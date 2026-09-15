import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
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
  browser = process.env.QUIET_ROOM_TEST_BROWSER === 'webkit' ? await webkit.launch() : await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : process.env.CI ? {} : { channel: 'chrome' });
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
    const mountUi = () => {
        controller = new AbortController();
        document.body.className = 'app-mode';
        document.querySelector('#app').innerHTML = '<main class="backup-page"><header class="subpage-header"><h1>备份与恢复</h1></header><section class="backup-content"><div class="backup-settings-group"><section class="backup-setting"><h2>恢复历史内容</h2><button class="secondary-button" data-restore="all">恢复历史记录</button></section></div></section></main>';
        attachHistoryRestore({ root: document.querySelector('#app'), session: target, signal: controller.signal,
          isActive: () => !controller.signal.aborted, onChanged: () => {} });
    };
    const originalFetch = window.fetch;
    window.fixture = { code: recovery.code, hidden, messages, responses, delay: 0, requests: 0, fail: false,
      async setup(role = 'creator') {
        controller?.abort();
        if (target) await v.clearLocalBrowserData(target);
        await v.deleteCurrentVault();
        target = await v.createVault({ ...checkpoint, role, lastSeq: 0, protocol: 'legacy-v1' }, 'synthetic-restore-password', 'password');
        target.vault.backup = { v: 1, ...c.newRecoveryCode(), revision: 1, cursor: 0, archives: [], syncedAt: sentAt };
        mountUi();
      },
      async reopen() {
        controller.abort(); target = await v.unlockVault('synthetic-restore-password'); mountUi();

      },
      async extraCode({ conflict = false, wrongRoom = false, expressionAutoHide, malformed } = {}) {
        const other = c.newRecoveryCode();
        const extra = conflict ? { ...messages[0], payload: { ...messages[0].payload, text: 'conflicting text' } }
          : { ...messages[0], seq: 6, clientMsgId: crypto.randomUUID(), payload: { v: 1, sentAt, kind: 'gallery-image', image } };
        if (expressionAutoHide !== undefined) extra.payload = { v: 1, sentAt, kind: 'image', image,
          presentation: expressionAutoHide ? 'expression-hidden' : 'expression', expressionAutoHide };
        if (malformed === 'payload') extra.payload.injected = true;
        const id = c.randomBackupSecret();
        const sealed = await c.sealJson({ v: 1, roomId, messages: [extra] }, archive.key, c.archiveAad(roomId, archive.id, id));
        responses.set(`/api/history-archives/${archive.id}/${id}`, sealed);
        const extraRoom = wrongRoom ? crypto.randomUUID() : roomId;
        const next = { ...bundle, backupId: other.id, roomId: extraRoom, checkpoint: { ...checkpoint, roomId: extraRoom },
          archives: [{ ...archive, parts: [...archive.parts, { id, digest: await c.backupDigest(sealed),
            firstSeq: malformed === 'sequence' ? extra.seq + 1 : extra.seq, lastSeq: malformed === 'sequence' ? extra.seq + 1 : extra.seq,
            count: malformed === 'count' ? 2 : 1 }] }] };
        responses.set(`/api/recovery-backups/${other.id}`, { revision: 1, sealed: await c.sealRecovery(next, other.code) });
        return other.code;
      },
      restore: async (codes = recovery.code, abort = new AbortController(), onProgress = () => {}) => b.restoreUnifiedHistory(target, codes, abort.signal, onProgress),
      async fragmentedCode(count) {
        const next = c.newRecoveryCode(), parts = [];
        for (let seq = 1; seq <= count; seq++) {
          const id = c.randomBackupSecret();
          const message = { ...messages[0], seq, clientMsgId: crypto.randomUUID() };
          const sealed = await c.sealJson({ v: 1, roomId, messages: [message] }, archive.key, c.archiveAad(roomId, archive.id, id));
          parts.push({ id, digest: await c.backupDigest(sealed), firstSeq: seq, lastSeq: seq, count: 1 });
          responses.set(`/api/history-archives/${archive.id}/${id}`, sealed);
        }
        responses.set(`/api/recovery-backups/${next.id}`, { revision: 1,
          sealed: await c.sealRecovery({ ...bundle, backupId: next.id, archives: [{ ...archive, parts }] }, next.code) });
        return next.code;
      },
      history: () => v.loadHistory(target), preferences: () => v.loadUiPreferences(target),
      saveStalePreferences: () => v.saveUiPreferences(target, { composerDraft: 'later draft' }),
      abort: () => controller.abort(), target: () => target,
    };
    window.fetch = async (url, options) => {
      const parsed = new URL(String(url), location.origin);
      const batch = parsed.pathname.endsWith('/batch') && parsed.pathname.startsWith('/api/history-archives/');
      if (!batch && !responses.has(String(url))) return originalFetch(url, options);
      window.fixture.requests++;
      if (window.fixture.rateLimit && window.fixture.requests >= (window.fixture.rateLimitAt ?? 0) && String(url).startsWith('/api/history-archives/')) {
        window.fixture.rateLimit = false;
        return new Response('{}', { status: 429, headers: { 'Retry-After': String(window.fixture.retryAfter ?? 0.05) } });
      }
      if (window.fixture.unavailable && String(url).startsWith(window.fixture.unavailable)) return new Response('{}', { status: 401 });
      if (window.fixture.delay) await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, window.fixture.delay);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
      });
      if (window.fixture.fail) throw new TypeError('synthetic network interruption');
      const value = batch ? { parts: parsed.searchParams.get('parts').split(',').slice(0, window.fixture.batchLimit ?? 20)
        .map(id => ({ id, sealed: responses.get(parsed.pathname.replace('/batch', `/${id}`)) })) } : responses.get(String(url));
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
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
  assert.equal(restored.retry.changed, false); assert.deepEqual(restored.retry.chat, { restored: 0, total: 0 }); assert.deepEqual(restored.retry.gallery, { restored: 0, total: 0 }); assert.equal(restored.cursor, 0); assert.equal(restored.readingIndeterminate, true); assert.equal(restored.monotonic, true);
  assert.equal(restored.requests, 4, 'one code and one batch per run, no duplicate downloads for a bounded archive');
  assert.deepEqual(restored.result.inventory, { chat: { backup: 3, existing: 0 }, gallery: { backup: 3, existing: 0 } });
  assert.equal(restored.result.audit.chat.imported, 3); assert.equal(restored.result.audit.chat.visible, 2);
  assert.equal(restored.result.audit.chat.hidden, 1); assert.equal(restored.result.audit.gallery.visible, 2);
  assert.equal(restored.result.audit.gallery.hidden, 1, 'only Safe-specific deletion hides a restored Safe image');
  assert.equal(restored.retry.audit.chat.backup, 3); assert.equal(restored.retry.audit.chat.existing, 3);
  assert.equal(restored.retry.audit.chat.imported, 0); assert.equal(restored.retry.audit.chat.available, 2);
  const readback = await page.evaluate(async () => {
    const f = window.fixture; await f.setup(); await f.restore();
    const { auditRestoredHistory, historyRecordDigest } = await import('/src/lib/history-restore-audit.ts');
    const expected = new Map([[1, { digest: await historyRecordDigest(f.messages[0]), chat: true, gallery: false, missing: true }]]);
    const name = (await indexedDB.databases()).find(item => item.name.includes('quiet'))?.name;
    if (!name) throw new Error('fixture database missing');
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open(name);
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('history', 'readwrite');
        tx.objectStore('history').delete(`${f.target().vault.roomId}:1`);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
    let rejected = false;
    try { await auditRestoredHistory(f.target(), expected, new Set([1]), new AbortController().signal); }
    catch (error) { rejected = error.message.includes('未能全部从本机读回'); }
    // Prior successful restores and an advanced backup cursor cannot substitute for local rows.
    f.target().vault.backup.cursor = 9999;
    const repaired = await f.restore();
    return { rejected, repaired, present: (await f.history()).some(m => m.seq === 1 && m.payload.text === f.messages[0].payload.text) };
  });
  assert.equal(readback.rejected, true, 'missing local ciphertext prevents successful readback');
  assert.equal(readback.repaired.chat.total, 1); assert.equal(readback.repaired.audit.chat.visible, 1);
  assert.equal(readback.repaired.audit.chat.existing, 2); assert.equal(readback.present, true, 'retry compares actual local records and restores a missing row again');
  const hiddenOnly = await page.evaluate(async () => {
    const f = window.fixture; await f.setup();
    const v = await import('/src/lib/vault.ts');
    const { QuietRoomApp } = await import('/src/app.ts');
    await v.importArchivedMessages(f.target(), [f.messages[0], f.messages[1], f.messages[4]], 'all');
    await v.saveUiPreferences(f.target(), { hiddenChatMessageIds: [f.messages[2].clientMsgId] });
    const result = await f.restore();
    const app = new QuietRoomApp(document.querySelector('#app'));
    app.session = f.target(); app.uiPreferences = await f.preferences();
    app.messages = new Map((await f.history()).map(m => [m.seq, m]));
    app.messageEventHistory = new Map((await v.loadMessageEventHistory(f.target())).map(m => [m.seq, m]));
    return { result, visibleChat: app.orderedMessages().map(m => m.seq), stored: (await f.history()).length };
  });
  assert.equal(hiddenOnly.result.chat.total, 2); assert.equal(hiddenOnly.result.audit.chat.imported, 2);
  assert.equal(hiddenOnly.result.audit.chat.visible, 0); assert.equal(hiddenOnly.result.audit.gallery.visible, 1);
  assert.equal(hiddenOnly.result.audit.chat.hidden, 2); assert.equal(hiddenOnly.result.audit.gallery.hidden, 1);
  assert.deepEqual(hiddenOnly.visibleChat, [1], 'real chat projection agrees with the zero-visible-additions report');
  assert.equal(hiddenOnly.stored, 5, 'hidden content remains durably stored rather than disappearing');
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
  assert.equal(cancelled.interrupted, true); assert.equal(cancelled.deletionFirst, true); assert.equal(cancelled.count, 5); assert.equal(cancelled.final.percent, 100); assert.deepEqual(cancelled.final.chat, { restored: 2, total: 2 }); assert.deepEqual(cancelled.final.gallery, { restored: 2, total: 2 });
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
  for (const autoHide of [false, true]) {
    const expression = await page.evaluate(async autoHide => {
      const f = window.fixture; await f.setup();
      const code = await f.extraCode({ expressionAutoHide: autoHide });
      const result = await f.restore(code);
      const message = (await f.history()).find(record => record.seq === 6);
      return { result, autoHide: message.payload.expressionAutoHide, presentation: message.payload.presentation };
    }, autoHide);
    assert.equal(expression.result.percent, 100);
    assert.equal(expression.result.chat.total, 4);
    assert.equal(expression.result.gallery.total, 3, 'expressions stay outside Safe');
    assert.equal(expression.autoHide, autoHide);
    assert.equal(expression.presentation, autoHide ? 'expression-hidden' : 'expression');
  }
  for (const [malformed, expected] of [['payload', '不支持或格式不正确'], ['sequence', '序号与索引不一致'], ['count', '条数与索引不一致']]) {
    const rejected = await page.evaluate(async malformed => {
      const f = window.fixture; await f.setup(); let error;
      try { await f.restore(await f.extraCode({ malformed })); } catch (cause) { error = cause.message; }
      return { error, count: (await f.history()).length };
    }, malformed);
    assert(rejected.error.includes(expected)); assert.equal(rejected.count, 0, 'malformed archive fails before writes');
  }
  const waited = await page.evaluate(async () => {
    const f = window.fixture; await f.setup(); f.rateLimit = true;
    const updates = [];
    const result = await f.restore(f.code, undefined, value => updates.push(value));
    return { result, waited: updates.some(value => value.waitingForService), count: (await f.history()).length };
  });
  assert.equal(waited.waited, true); assert.equal(waited.result.percent, 100); assert.equal(waited.count, 5);
  const fragmented = await page.evaluate(async () => {
    const f = window.fixture; await f.setup();
    const code = await f.fragmentedCode(121); f.requests = 0;
    const result = await f.restore(code);
    const requests = f.requests;
    await f.setup(); f.batchLimit = 2;
    const prefix = await f.restore(); f.batchLimit = undefined;
    return { result, requests, prefix };
  });
  assert.equal(fragmented.result.chat.restored, 121); assert.equal(fragmented.requests, 8, '121 tiny parts use seven batches plus one recovery request');
  assert.equal(fragmented.prefix.chat.restored, 3, 'bounded partial batch responses continue at the next unread part');
  for (const [route, expected] of [['/api/recovery-backups/', '新生成的恢复码'], ['/api/history-archives/', '历史片段无法取回']]) {
    const error = await page.evaluate(async route => {
      const f = window.fixture; await f.setup(); f.unavailable = route;
      try { await f.restore(); } catch (cause) { return cause.message; } finally { f.unavailable = null; }
    }, route);
    assert(error.includes(expected));
  }
  await page.evaluate(async () => { await window.fixture.setup(); window.fixture.delay = 350; });
  await page.evaluate(() => {
    window.fixture.clipboardReads = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { window.fixture.clipboardReads++; throw new Error('no clipboard access'); } } });
  });
  await page.locator('[data-restore]').click();
  assert.equal(await page.locator('[data-paste], [data-clipboard-hint], .history-restore-form .field-hint').count(), 0);
  assert.equal(await page.evaluate(() => window.fixture.clipboardReads), 0);
  assert.equal(await page.locator('.history-restore-sheet:not(.is-closing) textarea').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('[type=submit]').isDisabled(), true);
  await page.locator('.history-restore-sheet:not(.is-closing) textarea').fill('   '); assert.equal(await page.locator('[type=submit]').isDisabled(), true);
  for (const [name, width, height, colorScheme] of [['light', 390, 844, 'light'], ['narrow-dark', 320, 740, 'dark'],
    ['keyboard-light', 390, 320, 'light'], ['keyboard-dark', 320, 320, 'dark'], ['keyboard-short', 390, 280, 'dark']]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme });
    await page.locator('textarea').fill(await page.evaluate(() => window.fixture.code));
    await page.waitForFunction(() => document.querySelector('.history-restore-sheet').style.height === `${visualViewport.height}px`);
    const geometry = await page.locator('.history-restore-panel').evaluate(node => {
      const r = node.getBoundingClientRect(), input = node.querySelector('textarea'), wrapper = input.parentElement;
      const ir = input.getBoundingClientRect(), wr = wrapper.getBoundingClientRect(), button = node.querySelector('[type=submit]').getBoundingClientRect();
      return { fits: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight,
        scroll: node.scrollHeight - node.clientHeight, buttonVisible: button.top >= r.top && button.bottom <= r.bottom,
        topGap: ir.top - wr.top, bottomGap: wr.bottom - ir.bottom, textFits: input.scrollHeight <= input.clientHeight + 1, inputHeight: input.clientHeight, contentHeight: input.scrollHeight, inputWidth: input.clientWidth, font: getComputedStyle(input).font, letterSpacing: getComputedStyle(input).letterSpacing };
    });
    assert(geometry.fits && geometry.buttonVisible && geometry.scroll <= 1, `${name}: entire form fits ${JSON.stringify(geometry)}`);
    assert(Math.abs(geometry.topGap - geometry.bottomGap) <= 1 && geometry.topGap >= 12, `${name}: equal input inset`);
    if (height >= 320) assert(geometry.textFits, `${name}: complete single code fits without input scrolling ${JSON.stringify(geometry)}`);
    if (screenshots) await page.screenshot({ path: `${screenshots}/input-${name}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.history-restore-sheet:not(.is-closing) textarea').fill(await page.evaluate(() => window.fixture.code));
  await page.evaluate(() => {
    const f = window.fixture; f.batchLimit = 1; f.rateLimit = true; f.rateLimitAt = f.requests + 3; f.retryAfter = 1;
  });
  await page.locator('[type=submit]').click();
  assert.equal(await page.locator('.history-restore-sheet.is-closing textarea').inputValue(), '', 'code is cleared during exit animation');
  await page.getByText('备份服务繁忙，等待后自动继续', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-count=chat]').textContent(), '待恢复 1 条');
  assert.equal(await page.locator('[data-count=gallery]').textContent(), '待恢复 1 条');
  await page.locator('[data-dismiss]').click();
  assert.match(await page.locator('[data-restore]').textContent(), /正在恢复中/);
  await page.locator('[data-restore]').click();
  await page.getByRole('heading', { name: '恢复完成', exact: true }).waitFor();
  assert.equal(await page.locator('[data-count=gallery]').count(), 1);
  assert.match(await page.locator('[data-inventory=chat]').textContent(), /备份共 3 条 · 本机原有 0 条/);
  assert.match(await page.locator('[data-audit=chat]').textContent(), /本次补入 3 条：可见 2 条，隐藏 1 条/);
  assert.match(await page.locator('[data-audit=gallery]').textContent(), /本次补入 3 条：可见 2 条，隐藏 1 条/);
  if (screenshots) await page.screenshot({ path: `${screenshots}/progress-dark.png` });
  await page.locator('[data-dismiss]').click();
  const participant = await page.evaluate(async () => { window.fixture.delay = 0; await window.fixture.setup('joiner'); const result = await window.fixture.restore(); return { result, direct: (await window.fixture.history()).some(m => m.payload.kind === 'gallery-image') }; });
  assert.equal(participant.result.gallery, undefined); assert.equal(participant.direct, false);
  await page.locator('[data-restore]').click();
  await page.locator('.history-restore-sheet:not(.is-closing) textarea').fill(await page.evaluate(() => window.fixture.code));
  await page.evaluate(() => { window.fixture.fail = true; });
  await page.locator('[type=submit]').click();
  await page.getByRole('heading', { name: '恢复未完成', exact: true }).waitFor();
  assert.equal(await page.locator('[data-phase]').textContent(), '备份核验中断');
  assert.match(await page.locator('[data-detail]').textContent(), /尚未开始导入/);
  assert.equal(await page.locator('[data-count=gallery]').count(), 0);
  assert.equal(await page.locator('[data-retry]').isVisible(), true);
  await page.locator('[data-dismiss]').click();
  await page.locator('[data-restore]').click();
  assert.equal(await page.locator('textarea').count(), 0, 'reopening a failed task does not request the code again');
  await page.locator('[data-retry]').click();
  await page.getByRole('heading', { name: '恢复未完成', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => Boolean(window.fixture.target().vault.historyRestoreTask)), true);
  await page.evaluate(() => window.fixture.reopen());
  await page.locator('[data-restore]').click();
  assert.equal(await page.locator('textarea').count(), 0, 'task resumes from the encrypted vault after reauthentication');
  await page.evaluate(() => { window.fixture.fail = false; });
  await page.locator('[data-retry]').click();
  await page.getByRole('heading', { name: '恢复完成', exact: true }).waitFor();
  await page.waitForFunction(() => !window.fixture.target().vault.historyRestoreTask);
  await page.locator('[data-dismiss]').click();
  await page.locator('[data-restore]').click();
  await page.locator('textarea').fill(await page.evaluate(() => window.fixture.code));
  await page.evaluate(() => { window.fixture.delay = 350; });
  await page.locator('[type=submit]').click();
  await page.waitForFunction(() => Boolean(window.fixture.target().vault.historyRestoreTask));
  await page.evaluate(() => window.fixture.abort());
  assert.equal(await page.locator('.history-restore-sheet').count(), 0, 'lock removes dialogs synchronously and pauses the durable task');
  await page.evaluate(() => window.fixture.reopen());
  await page.locator('[data-restore]').click();
  await page.locator('[data-cancel]').click();
  await page.waitForFunction(() => !window.fixture.target().vault.historyRestoreTask);
  // The in-memory task clears before the encrypted vault save resolves.
  await page.locator('.history-restore-sheet').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.history-restore-sheet').count(), 0);
  assert.equal(await page.evaluate(async () => (await window.fixture.history()).length), 4, 'cancel keeps already restored participant history');
  await page.evaluate(() => window.fixture.reopen());
  await page.locator('[data-restore]').click();
  assert.equal(await page.locator('textarea').count(), 1, 'explicit cancellation ends the stored task');
  console.log('Unified restore passed: all records, direct Safe uploads, durable deletions, retry/dedup, abort, unchanged cursor, exact totals, focus, error, roles, themes and narrow layout.');
} finally { await browser?.close(); await vite?.close(); }
