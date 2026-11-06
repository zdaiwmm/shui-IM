import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { harness, send, durable, protect, outputDirectory, outputReady } from './harness.mjs';

await outputReady();
const duration = Number(process.env.AUDIT_SOAK_MS ?? 1_800_000);
assert.ok(Number.isInteger(duration) && duration >= 30_000 && duration <= 1_800_000);
const attachmentBytes = duration >= 60_000 ? 2 * 1024 * 1024 + 125 : 64 * 1024;
const results = { startedAt: new Date().toISOString(), duration, attachmentBytes, scope: 'Real two-device new-room MLS, automatic backup, input, verified scroll displacement, reconnect, original file upload and complete archive restore; Chromium mobile simulation', samples: [], events: [], errors: [] };
const h = await harness({ mobile: true });
const nodeLoop = monitorEventLoopDelay({ resolution: 20 });
const save = () => writeFile(path.join(outputDirectory, 'mixed-soak.json'), JSON.stringify(results, null, 2));
try {
  const [sender, reader] = await h.pair();
  const latest = async () => {
    for (let step = 0; step < 2; step++) {
      const control = reader.locator('#chat-bottom-control');
      if (await control.getAttribute('aria-hidden') !== 'false') break;
      await control.click();
      await reader.waitForFunction(() => !auditApp.chatBottomControl?.scrolling);
    }
  };
  await protect(reader);
  await reader.evaluate(() => auditApp.renderChat());
  let archiveWrites = 0;
  reader.on('request', request => {
    if (['PUT', 'POST'].includes(request.method()) && request.url().includes('/private-archives/')) archiveWrites++;
  });
  for (const page of [sender, reader]) page.on('pageerror', error => results.errors.push(error.message));
  const cdp = await reader.context().newCDPSession(reader);
  await cdp.send('Performance.enable');
  await reader.screenshot({ path: path.join(outputDirectory, 'mixed-start.png') });
  await reader.evaluate(() => {
    window.auditMetrics = { renderCalls: 0, renderMs: 0, encryptBytes: 0, idbPuts: 0, objectUrls: new Set(),
      gcWindows: [], longTasks: { supported: PerformanceObserver.supportedEntryTypes.includes('longtask'), count: 0, totalMs: 0, maxMs: 0, over200: 0 } };
    if (auditMetrics.longTasks.supported) {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (auditMetrics.gcWindows.some(([start, end]) => entry.startTime <= end && entry.startTime + entry.duration >= start)) continue;
          const m = auditMetrics.longTasks; m.count++; m.totalMs += entry.duration; m.maxMs = Math.max(m.maxMs, entry.duration);
          if (entry.duration > 200) m.over200++;
        }
      }).observe({ type: 'longtask' });
    }
    const a = auditApp, render = a.renderMessages.bind(a);
    a.renderMessages = function (...args) { const start = performance.now(); try { return render(...args); } finally { auditMetrics.renderCalls++; auditMetrics.renderMs += performance.now() - start; } };
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = function (...args) { auditMetrics.encryptBytes += args[2].byteLength; return encrypt(...args); };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { auditMetrics.idbPuts++; return put.apply(this, args); };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (...args) { const url = create(...args); auditMetrics.objectUrls.add(url); return url; };
    URL.revokeObjectURL = function (url) { auditMetrics.objectUrls.delete(url); return revoke(url); };
  });
  const collectGarbage = async () => {
    await reader.evaluate(() => auditMetrics.gcWindows.push([performance.now(), Infinity]));
    await cdp.send('HeapProfiler.collectGarbage');
    await reader.evaluate(() => { auditMetrics.gcWindows.at(-1)[1] = performance.now(); });
  };
  const started = Date.now(); let cycles = 0;
  nodeLoop.enable();
  while (Date.now() - started < duration) {
    const cycleStart = Date.now(); cycles++;
    // Use the existing unread/latest control before waiting for the next
    // arriving row. A reading window intentionally does not mount every arrival.
    await latest();
    let reconnect = false, uploadMs = null;
    if (cycles === 2 || cycles % 20 === 0) {
      reconnect = true;
      await reader.context().setOffline(true);
      for (let n = 0; n < (duration >= 60_000 ? 20 : 1); n++) await send(sender, `synthetic-offline-${cycles}-${n}`);
      await reader.waitForTimeout(1000); await reader.context().setOffline(false);
      await reader.locator('#message-input').fill('重连期间保留的草稿');
      await Promise.all([h.ready(reader), reader.locator('#message-input').pressSequentially('abc', { delay: 15 })]);
      assert.equal(await reader.locator('#message-input').inputValue(), '重连期间保留的草稿abc');
    }
    const text = `synthetic-soak-${cycles}`;
    const sent = Date.now(); await send(sender, text);
    await reader.getByText(text, { exact: true }).waitFor();
    const arrivalMs = Date.now() - sent;
    const draft = `持续输入草稿 ${cycles}`;
    const inputStart = Date.now(); await reader.locator('#message-input').fill(draft);
    await reader.locator('#message-input').pressSequentially('abc', { delay: 15 });
    const inputMs = Date.now() - inputStart;
    assert.equal(await reader.locator('#message-input').inputValue(), draft + 'abc');
    const scroll = await reader.evaluate(async () => {
      const app = auditApp, before = app.chatScrollTop;
      app.chatScrollIntent = 'up'; app.chatPinnedToBottom = false;
      app.setChatScrollTop(Math.max(0, before - 160));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { owner: app.usesListScrolling ? 'list' : 'document', before, after: app.chatScrollTop };
    });
    if (scroll.before > 160) assert.ok(scroll.before - scroll.after >= 100, 'Actual scroll owner must move, not just receive an event');
    if (cycles === 1 || cycles % 40 === 0) {
      await sender.bringToFront();
      const [chooser] = await Promise.all([sender.waitForEvent('filechooser'), sender.locator('#file-input').evaluate(input => input.click())]);
      const uploadStart = Date.now();
      await chooser.setFiles({ name: `synthetic-soak-${cycles}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(attachmentBytes, 90) });
      await sender.waitForFunction(name => auditApp.imageBatchUploading || [...auditApp.messages.values()]
        .some(row => row.payload.kind === 'file' && row.payload.file.originalName === name), `synthetic-soak-${cycles}.bin`);
      await reader.bringToFront();
      await Promise.all([reader.waitForFunction(name => [...auditApp.messages.values()].some(row => row.payload.kind === 'file' && row.payload.file.originalName === name), `synthetic-soak-${cycles}.bin`),
        reader.locator('#message-input').pressSequentially('并发', { delay: 15 })]);
      assert.equal(await reader.locator('#message-input').inputValue(), draft + 'abc并发');
      await latest();
      await reader.locator('.file-attachment').filter({ hasText: `synthetic-soak-${cycles}.bin` }).waitFor();
      uploadMs = Date.now() - uploadStart;
    }
    results.events.push({ cycles, elapsedMs: Date.now() - started, arrivalMs, inputAutomationMs: inputMs, reconnect, uploadMs, scroll });
    if (cycles === 1 || cycles % 12 === 0) {
      await collectGarbage();
      const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
      const state = await reader.evaluate(() => ({ seq: auditApp.session.vault.lastSeq, rows: document.querySelectorAll('#message-list > .message').length,
        messages: auditApp.messages.size, queued: auditApp.serverQueue.size, backupCursor: auditApp.session.vault.archiveState?.cursor ?? 0,
        backupRevision: auditApp.session.vault.archiveState?.revision ?? 0, activeImages: auditApp.activeImageLoads, imageWaiters: auditApp.imageLoadWaiters.length,
        cachedImages: auditApp.imageCache.size, urls: auditMetrics.objectUrls.size, renderCalls: auditMetrics.renderCalls, renderMs: auditMetrics.renderMs,
        encryptBytes: auditMetrics.encryptBytes, idbPuts: auditMetrics.idbPuts, longTasks: { ...auditMetrics.longTasks },
        profile: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints, coarse: matchMedia('(pointer:coarse)').matches } }));
      const sample = { elapsedMs: Date.now() - started, cycles, arrivalMs, inputAutomationMs: inputMs, archiveWrites,
        jsHeapUsed: metrics.JSHeapUsedSize, nodes: metrics.Nodes, listeners: metrics.JSEventListeners,
        localServerAndHarness: { memory: process.memoryUsage(), eventLoopP99Ms: nodeLoop.percentile(99) / 1e6, eventLoopMaxMs: nodeLoop.max / 1e6 }, ...state };
      nodeLoop.reset();
      results.samples.push(sample); console.log('MIXED_SOAK', JSON.stringify(sample)); await save();
      assert.ok(sample.rows <= 200, 'Mixed soak mounted too many rows');
      assert.ok(sample.nodes <= 5000, `Detached DOM growth during mixed soak: ${sample.nodes} total nodes after GC`);
    }
    const wait = Math.min(5000 - (Date.now() - cycleStart), duration - (Date.now() - started));
    if (wait > 0) await reader.waitForTimeout(wait);
  }
  results.cycles = cycles; results.actualDurationMs = Date.now() - started;
  for (const page of [sender, reader]) await page.waitForFunction(() => !auditApp.outbox.size && !auditApp.serverQueue.size);
  await reader.waitForTimeout(1000);
  const senderState = await durable(sender), readerState = await durable(reader);
  results.finalDurable = { senderSeq: senderState.seq, readerSeq: readerState.seq, senderRows: senderState.rows.length, readerRows: readerState.rows.length };
  assert.deepEqual(readerState.rows, senderState.rows, 'Two endpoints must persist the identical ordered event sequence');
  const backupWait = Date.now();
  // Let the actual 15-second automatic scheduler drain after input stops.
  // Cursor progress alone does not establish a latest complete recovery point.
  await reader.bringToFront();
  await reader.waitForFunction(() => {
    const app = auditApp, state = app.session.vault.archiveState;
    return state?.cursor >= app.session.vault.lastSeq && state?.lastComplete?.sharedThrough === app.session.vault.lastSeq
      && !state.preparing && !state.pending && !app.backupRun && !app.backupError;
  }, undefined, { timeout: 600000, polling: 1000 });
  results.backup = await reader.evaluate(() => ({ cursor: auditApp.session.vault.archiveState?.cursor ?? 0,
    latestSeq: auditApp.session.vault.lastSeq, sharedThrough: auditApp.session.vault.archiveState?.lastComplete?.sharedThrough,
    revision: auditApp.session.vault.archiveState?.revision ?? 0, error: auditApp.backupError }));
  results.backup.convergenceMs = Date.now() - backupWait;
  const coverage = await reader.evaluate(async () => {
    const { readArchiveBackupSnapshot } = await import('/src/lib/archive-backup-state.ts');
    return readArchiveBackupSnapshot(auditApp.session, auditApp.runtimeAbort.signal, auditApp.archiveBackup.snapshot);
  });
  assert.equal(coverage.coverage, 'complete');
  results.backup.coverage = coverage.coverage; results.backup.counts = coverage.counts;
  console.log('BACKUP_CONVERGED', JSON.stringify(results.backup));
  await save();
  const finalSender = await durable(sender), finalReader = await durable(reader);
  assert.deepEqual(finalReader.rows, finalSender.rows, 'Quiescent backup must retain identical durable events');
  results.finalDurable = { senderSeq: finalSender.seq, readerSeq: finalReader.seq, senderRows: finalSender.rows.length, readerRows: finalReader.rows.length };
  results.backup.archiveWrites = archiveWrites;
  if (duration >= 60_000) assert.ok(results.backup.cursor > 0 && archiveWrites > 0, 'Formal soak must actually exercise automatic backup');
  if (duration >= 60000) assert.ok(results.events.filter(event => event.scroll.before - event.scroll.after >= 100).length > 10);
  const source = await reader.evaluate(async () => {
    const { loadHistory } = await import('/src/lib/vault.ts');
    const rows = await loadHistory(auditApp.session);
    return { key: auditApp.session.vault.roomArchiveV2.key,
      ids: rows.filter(row => ['text', 'file'].includes(row.payload.kind)).map(row => row.clientMsgId).sort() };
  });
  // An unpaired invitation page owns no active chat runtime. Finish the normal
  // new-room pairing flow before exercising restoration into a fresh runtime.
  const [recovered, recoveryPeer] = await h.pair();
  console.log('ARCHIVE_RESTORE_STARTED');
  results.restore = await recovered.evaluate(async ({ key, ids, attachmentBytes }) => {
    const vault = await import('/src/lib/vault.ts'), archive = await import('/src/lib/room-archive.ts'), fileCrypto = await import('/src/lib/file-crypto.ts');
    const app = auditApp, signal = app.runtimeAbort.signal;
    await archive.restoreRoomArchive(app.session, key, signal, () => {});
    const items = await vault.loadPrivateArchiveItems(app.session, signal);
    const actualIds = items.filter(item => ['text', 'file'].includes(item.message.payload.kind)).map(item => item.message.clientMsgId).sort();
    if (JSON.stringify(ids) !== JSON.stringify(actualIds)) throw Error('Restored archive does not include every latest visible message');
    let files = 0, verifiedBytes = 0;
    for (const item of items) {
      if (item.message.payload.kind !== 'file') continue;
      const manifest = item.message.payload.file;
      const original = await fileCrypto.decryptFileAttachment(manifest, (id, index) => vault.loadPrivateMediaChunk(archive.privateItemSession(app.session, item), id, index,
        Math.min(manifest.chunkSize, manifest.originalSize - index * manifest.chunkSize) + 16));
      const bytes = new Uint8Array(await original.arrayBuffer());
      if (bytes.length !== attachmentBytes || !bytes.every(value => value === 90)) throw Error('Restored original attachment bytes differ');
      files++; verifiedBytes += bytes.length;
    }
    if ((await vault.loadHistory(app.session)).length || (await vault.loadOutbox(app.session)).length
      || (await vault.loadPendingReceipts(app.session)).length) throw Error('Private restoration entered shared message state');
    return { visibleMessages: actualIds.length, files, verifiedBytes, exactLatestIds: true, originalsMatch: true, privateOnly: true };
  }, { ...source, attachmentBytes });
  assert.equal(results.restore.files, results.events.filter(event => event.uploadMs !== null).length);
  console.log('ARCHIVE_RESTORED', JSON.stringify(results.restore));
  await save();
  await recovered.context().close(); await recoveryPeer.context().close(); await reader.bringToFront();
  await reader.screenshot({ path: path.join(outputDirectory, 'mixed-end.png') });
  results.beforeLock = results.samples.at(-1);
  await reader.evaluate(() => auditApp.lockNow()); await reader.waitForTimeout(500); await collectGarbage();
  const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
  results.afterLock = { jsHeapUsed: after.JSHeapUsedSize, nodes: after.Nodes, listeners: after.JSEventListeners,
    ...await reader.evaluate(() => ({ messages: auditApp.messages.size, images: auditApp.imageCache.size,
      urls: auditMetrics.objectUrls.size, session: Boolean(auditApp.session), input: Boolean(document.querySelector('#message-input')) })) };
  assert.equal(results.afterLock.messages, 0); assert.equal(results.afterLock.images, 0); assert.equal(results.afterLock.session, false);
  assert.deepEqual(results.errors, []);
} catch (error) { results.failure = String(error); throw error; }
finally { nodeLoop.disable(); await save(); await h.close(); }
