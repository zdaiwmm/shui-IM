import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, devices } from 'playwright';
import { startChatRenderHarness } from '../../tests/helpers/chat-render-harness.mjs';

const output = '.artifacts/audit-remediation';
await mkdir(output, { recursive: true });
const harness = await startChatRenderHarness();
const result = { kind: 'synthetic-model-real-renderer', startedAt: new Date().toISOString(), cases: [] };
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
try {
  for (const [engine, mobile] of [[chromium, false], [chromium, true], [webkit, true]]) {
    const browser = await engine.launch(engine === chromium && !process.env.CI ? { channel: 'chrome' } : {});
    try {
      for (const size of [100, 1000, 10000]) for (let trial = 0; trial < 5; trial++) {
        const context = await browser.newContext({ locale: 'zh-CN', ...(mobile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }) });
        try {
          const page = await context.newPage();
          const initial = await harness.setup(page, size);
          const sample = await page.evaluate(async () => {
            const app = chatTest, nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
            await nextFrame(); await nextFrame();
            const unchanged = [], routine = [];
            for (let n = 0; n < 100; n++) {
              let started = performance.now(); app.renderMessages(); unchanged.push(performance.now() - started);
              // Actual ACK decoration changes on a mounted message, not a no-op.
              const source = app.messages.get(app.messages.size);
              source.status = n % 2 ? 'delivered' : 'stored';
              started = performance.now(); app.renderMessages(); routine.push(performance.now() - started);
              await nextFrame();
            }
            const rows = document.querySelectorAll('#message-list > .message').length;
            const nodes = document.querySelectorAll('*').length;
            const profile = { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints,
              coarse: matchMedia('(pointer:coarse)').matches, ua: navigator.userAgent, scrollOwner: app.usesListScrolling ? 'list' : 'document' };
            app.lockNow();
            return { unchangedRenderMs: unchanged, routineUpdateMs: routine, rows, nodes, profile,
              lockedRows: document.querySelectorAll('#message-list > .message').length,
              messagesAfterLock: app.messages.size, windowAfterLock: app.chatRenderWindow.length };
          });
          assert.ok(sample.rows <= 200); assert.ok(sample.nodes <= 5000);
          assert.equal(sample.lockedRows, 0); assert.equal(sample.messagesAfterLock, 0); assert.equal(sample.windowAfterLock, 0);
          if (mobile) { assert.equal(sample.profile.width, 390); assert.equal(sample.profile.dpr, 3); assert.ok(sample.profile.coarse); }
          const row = { engine: engine.name(), mobile, size, trial, ...initial, ...sample };
          result.cases.push(row);
          await writeFile(`${output}/history-render.json`, JSON.stringify(result, null, 2));
          console.log('HISTORY_RENDER', JSON.stringify({ engine: row.engine, mobile, size, trial, initialRenderMs: row.initialRenderMs, routineP95: percentile(row.routineUpdateMs, .95), nodes: row.nodes }));
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  for (const [engine, mobile] of [['chromium', false], ['chromium', true], ['webkit', true]]) {
    const rows = result.cases.filter(row => row.engine === engine && row.mobile === mobile && row.size === 10000);
    const values = rows.map(row => row.initialRenderMs);
    assert.equal(rows.length, 5);
    assert.ok(percentile(values, .5) <= 100 && Math.max(...values) <= 200, `${engine}/${mobile}: initial window exceeds budget`);
    assert.ok(rows.every(row => percentile(row.routineUpdateMs, .95) < 50), `${engine}/${mobile}: routine update exceeds budget`);
  }
} finally { await harness.close(); }
