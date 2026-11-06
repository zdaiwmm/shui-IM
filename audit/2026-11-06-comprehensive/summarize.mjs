import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const dir = path.resolve('.artifacts/comprehensive-audit');
const read = async name => { try { return JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const q = (values, fraction) => { const a = values.filter(Number.isFinite).sort((a, b) => a - b); return a.length ? a[Math.ceil(fraction * a.length) - 1] : null; };
const stats = values => ({ n: values.filter(Number.isFinite).length, min: q(values, .00001), median: q(values, .5), p95: q(values, .95), max: q(values, 1) });
const group = (rows, key) => Object.entries(Object.groupBy(rows, key));
const history = await read('history-render.json'), sync = await read('sync-matrix.json');
const storage = await read('storage-profile.json'), soak = await read('mixed-soak.json');
const postcommit = await read('postcommit-probe.json');
const allAudit = await read('dependency-audit-all.json'), prodAudit = await read('dependency-audit.json');
const baselineLog = await readFile(path.join(dir, 'check-full.log'), 'utf8');
const privateLog = await readFile(path.join(dir, 'private-archive-perf.log'), 'utf8');
const privateResult = privateLog.split('\n').find(line => line.startsWith('Private pagination passed (chromium): '));
const privateMetrics = privateResult ? JSON.parse(privateResult.slice(privateResult.indexOf('{'))).metrics : [];
const timelineLog = await readFile(path.join(dir, 'timeline-model.log'), 'utf8');
const timelineResult = timelineLog.split('\n').find(line => line.startsWith('{"kind":"synthetic-timeline-projection"'));
const callsLog = await readFile(path.join(dir, 'calls.log'), 'utf8');
const restoreLog = await readFile(path.join(dir, 'restore-drill.log'), 'utf8');
const summary = {
  baseline: '2e37ddde838541cccc44fd4002a182a7ddc7edc5', generatedAt: new Date().toISOString(),
  baselineResults: { browser: baselineLog.match(/\[browser\] TOTAL[^\n]+/)?.[0] ?? 'not completed',
    unitFiles: baselineLog.match(/Test Files[^\n]+/)?.[0] ?? null, unitTests: baselineLog.match(/\s+Tests\s+[^\n]+/)?.[0]?.trim() ?? null },
  history: history ? group(history.cases, row => `${row.engine}/${row.mobile ? 'mobile' : 'desktop'}/${row.size}`).map(([profile, rows]) => ({
    profile, runs: rows.length, initialRenderMs: stats(rows.map(row => row.initialRenderMs)),
    unchangedRenderMs: stats(rows.flatMap(row => row.unchangedRenderMs)),
    syntheticInputToTwoRafMs: stats(rows.flatMap(row => row.syntheticInputToTwoRafMs)),
    nodes: stats(rows.map(row => row.nodes)), heap: stats(rows.map(row => row.heap)),
    allClearedOnLock: rows.every(row => row.lockedRows === 0 && row.messagesAfterLock === 0), device: rows[0].profile,
  })) : null,
  sync: sync ? group(sync.cases, row => `${row.engine}/${row.mobile ? 'mobile' : 'desktop'}/${row.count}/${row.heavy ? 'heavy' : 'light'}`).map(([profile, rows]) => ({
    profile, runs: rows.length, elapsedMs: stats(rows.map(row => row.elapsedMs)), firstRowMs: stats(rows.map(row => row.firstRowMs)),
    encryptBytes: stats(rows.map(row => row.encryptBytes)), renderMs: stats(rows.map(row => row.renderMs)),
    frameP95: stats(rows.map(row => row.frameP95)), frameMax: stats(rows.map(row => row.frameMax)),
    httpRecords: stats(rows.map(row => row.httpRecords)), httpPages: stats(rows.map(row => row.httpPages)),
    idbPuts: stats(rows.map(row => row.idbPuts)), vaultBytes: stats(rows.map(row => row.vaultBytes)),
  })) : null,
  storage: storage?.cases.map(row => ({ count: row.count, rowsAt128KiB: row.rowsAt128KiB, queryPlan: row.queryPlan,
    firstPageMs: stats(row.firstPageMs), tailPageMs: stats(row.tailPageMs), unreadCountMs: stats(row.unreadCountMs), sixSequentialPagesMs: stats(row.sixSequentialPagesMs) })) ?? null,
  soak: soak ? { duration: soak.duration, actualDurationMs: soak.actualDurationMs, cycles: soak.cycles, attachmentBytes: soak.attachmentBytes,
    sampleCount: soak.samples.length, arrivalMs: stats(soak.events?.map(row => row.arrivalMs) ?? []),
    inputAutomationMs: stats(soak.events?.map(row => row.inputAutomationMs) ?? []),
    reconnects: soak.events?.filter(row => row.reconnect).length, uploads: soak.events?.filter(row => row.uploadMs !== null).length,
    backup: soak.backup, first: soak.samples[0], last: soak.samples.at(-1), finalDurable: soak.finalDurable,
    resourceSamples: {
      gcHeapBytes: stats(soak.samples.map(row => row.jsHeapUsed)), domNodes: stats(soak.samples.map(row => row.nodes)),
      listeners: stats(soak.samples.map(row => row.listeners)), receiveQueue: stats(soak.samples.map(row => row.queued)),
      backupCursorLag: stats(soak.samples.map(row => row.seq - row.backupCursor)),
      localServerAndHarnessHeapBytes: stats(soak.samples.map(row => row.localServerAndHarness?.memory.heapUsed)),
      localServerAndHarnessLoopP99Ms: stats(soak.samples.map(row => row.localServerAndHarness?.eventLoopP99Ms)),
    },
    afterLock: soak.afterLock, pageErrors: soak.errors, failure: soak.failure ?? null } : null,
  postcommit: postcommit?.cases.map(row => ({ engine: row.engine, duplicateControls: row.duplicateControls,
    boundaryCheck: row.boundaryCheck, failure: row.error ?? null })) ?? null,
  dependencies: { production: prodAudit?.metadata?.vulnerabilities ?? null, all: allAudit?.metadata?.vulnerabilities ?? null },
  supplementalResults: {
    privatePagination: privateMetrics.map(row => ({ size: row.size, buildMs: row.buildMs,
      modes: group(row.runs, run => run.mode).map(([mode, runs]) => ({ mode, durationMs: stats(runs.map(run => run.ms)),
        returnedRows: stats(runs.map(run => run.rows)), retainedBodies: stats(runs.map(run => run.retainedBodies)) })) })),
    timelineModel: timelineResult ? JSON.parse(timelineResult) : null,
    calls: { nativePassed: callsLog.includes('Native call E2E passed:'), authenticatedRelayMedia: callsLog.includes('"authenticatedRelayMedia":true'),
      viewPassed: callsLog.includes('Call UI passed:'), weakNetwork: callsLog.match(/WEAK_NETWORK_BROWSER_PASS[^\n]+/)?.[0] ?? null },
    restoreDrill: { files: restoreLog.match(/Test Files[^\n]+/)?.[0] ?? null, tests: restoreLog.match(/\s+Tests\s+[^\n]+/)?.[0]?.trim() ?? null },
  },
  supplementalSteps: await read('remaining-status.json'), historyRetry: await read('history-render-retry-status.json'), evidenceHashes: {},
};
for (const name of (await readdir(dir)).filter(name => /\.(json|log|png)$/.test(name)).sort()) {
  const bytes = await readFile(path.join(dir, name));
  summary.evidenceHashes[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
const destination = path.resolve('audit/2026-11-06-comprehensive/evidence-summary.json');
await writeFile(destination, JSON.stringify(summary, null, 2) + '\n');
console.log(destination);
