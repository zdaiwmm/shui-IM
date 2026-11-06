import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { outputReady, outputDirectory } from './harness.mjs';

// Reuse the existing three-device fixture without mutating the registered
// regression. Only its scale-dependent assertion/readback are expanded.
await outputReady();
const original = await readFile('tests/helpers/sync-performance.mjs', 'utf8');
let source = original;
const replaceOnce = (from, to) => { assert.equal(source.split(from).length, 2, 'Fixture changed; review the audit adapter'); source = source.replace(from, to); };
replaceOnce("const rows=await v.loadHistoryPageAfter(app.session,{afterSeq:0,limit:1000});", `const rows=[];let cursor=0;
      while(true){const page=await v.loadHistoryPageAfter(app.session,{afterSeq:cursor,limit:200});if(!page.length)break;rows.push(...page);const next=page.at(-1).seq;if(next<=cursor)throw Error('Non-progressing audit page');cursor=next;}`);
replaceOnce('measured.encryptBytes < 32 * 1024 ** 2', 'measured.encryptBytes < 32 * 1024 ** 2 * Math.max(1,count/270)');
const generated = path.join(outputDirectory, 'sync-fixture.mjs');
await writeFile(generated, source);
const results = { startedAt: new Date().toISOString(), fixtureSha256: createHash('sha256').update(original).digest('hex'),
  limitations: 'Existing synthetic three-device fixture; does not execute concurrent archive uploading or complete onboarding.', cases: [] };
const repeats = Number(process.env.AUDIT_REPEATS ?? 5);
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 20);
try {
  for (const [engine, mobile] of [['chromium', '0'], ['chromium', '1'], ['webkit', '1']]) {
    for (const [count, heavy] of [[270, '0'], [270, '1'], [1000, '1']]) {
      for (let trial = 0; trial < repeats; trial++) {
        const started = Date.now();
        const raw = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [generated], { cwd: process.cwd(), env: { ...process.env,
            SYNC_ENGINE: engine, SYNC_MOBILE: mobile, SYNC_COUNT: String(count), SYNC_HEAVY: heavy } });
          let out = '', err = '';
          child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
          const timeout = setTimeout(() => child.kill('SIGTERM'), 300_000);
          child.on('error', reject);
          child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve(out) : reject(Error(`Sync matrix exited ${code}: ${err.slice(-4000)} ${out.slice(-1000)}`)); });
        });
        const line = String(raw).split('\n').find(line => line.startsWith('SYNC_PROFILE ')); assert.ok(line);
        const sample = { trial, ...JSON.parse(line.slice(13)), runMs: Date.now() - started };
        results.cases.push(sample); console.log('SYNC_MATRIX', JSON.stringify(sample));
        await writeFile(path.join(outputDirectory, 'sync-matrix.json'), JSON.stringify(results, null, 2));
      }
    }
  }
} finally { await rm(generated, { force: true }); }
