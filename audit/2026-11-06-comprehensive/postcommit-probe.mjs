import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { harness, send, durable, outputDirectory, outputReady } from './harness.mjs';

await outputReady();
const results = { startedAt: new Date().toISOString(), baseline: '2e37ddde838541cccc44fd4002a182a7ddc7edc5', cases: [] };
for (const engine of ['chromium', 'webkit']) {
  const h = await harness({ engine });
  try {
    const [sender, peer] = await h.pair();
    await send(sender, 'synthetic reaction target');
    await peer.getByText('synthetic reaction target', { exact: true }).waitFor();
    await sender.waitForFunction(() => !auditApp.outbox.size && !auditApp.serverQueue.size);
    const observed = await sender.evaluate(async () => {
      const app = auditApp;
      const target = [...app.messages.values()].find(row => row.payload.text === 'synthetic reaction target');
      const marker = crypto.randomUUID();
      const faults = []; let injected = false;
      const remove = IDBObjectStore.prototype.delete;
      const error = app.operationalError.bind(app);
      app.operationalError = function (...args) {
        faults.push({ error: String(args[0]), injected, seq: app.session?.vault.lastSeq,
          controls: [...(app.session?.vault.mls?.window?.controls ?? [])],
          queued: [...app.serverQueue.keys()] });
        return error(...args);
      };
      IDBObjectStore.prototype.delete = function (...args) {
        const request = remove.apply(this, args);
        if (!injected && this.name === 'outbox' && String(args[0]).endsWith(':' + marker)) {
          injected = true;
          request.addEventListener('success', () => this.transaction.abort(), { once: true });
        }
        return request;
      };
      window.auditProbe = { marker, faults, restore: () => { IDBObjectStore.prototype.delete = remove; app.operationalError = error; } };
      // Send through the application's normal enqueue/ratchet/outbox path.
      await app.enqueuePayload({ v: 1, kind: 'reaction', emoji: '❤️', target: {
        clientMsgId: target.clientMsgId, serverSeq: target.seq, senderId: target.senderId,
      }, sentAt: new Date().toISOString() }, marker);
      return { targetSeq: target.seq };
    });
    await sender.waitForFunction(() => auditProbe.faults.length > 0, undefined, { timeout: 15_000 });
    const atFailure = await sender.evaluate(() => auditProbe.faults);
    const savedAfterFailure = await durable(sender);
    await sender.evaluate(async () => { auditProbe.restore(); await auditApp.drainServerQueue(); });
    const after = await durable(sender);
    const snapshot = await sender.evaluate(() => ({ liveSeq: auditApp.session?.vault.lastSeq,
      controls: auditApp.session?.vault.mls?.window?.controls ?? [], fatal: Boolean(document.querySelector('#fatal-message')) }));
    const duplicates = after.controls.length !== new Set(after.controls).size;
    const boundaryCheck = await sender.evaluate(async () => {
      const w = await import('/src/lib/message-window.ts');
      const valid = w.validRetentionBoundary(w.retentionBoundary(auditApp.session.vault));
      try { await auditApp.ensureMessageWindow(true); return { valid, rotation: 'completed' }; }
      catch (error) { return { valid, rotation: 'rejected', error: String(error) }; }
    });
    const finding = { engine, ...observed, atFailure, savedAfterFailure, after, snapshot, duplicateControls: duplicates, boundaryCheck };
    results.cases.push(finding);
    console.log('POSTCOMMIT_PROBE', JSON.stringify(finding));
    // Diagnostic observations are saved even if the hypothesised defect does not reproduce.
    assert.ok(atFailure.some(x => x.injected), 'Fault injector must hit the intended storage abort');
  } catch (error) {
    results.cases.push({ engine, error: String(error) }); throw error;
  } finally {
    await writeFile(path.join(outputDirectory, 'postcommit-probe.json'), JSON.stringify(results, null, 2));
    await h.close();
  }
}
