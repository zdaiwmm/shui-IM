import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { orderedChatMessages, privateTimelineItems } from '../src/lib/message-timeline.ts';

// Synthetic view-model measurements only. No network, browser store, vault or
// production data. Run with --expose-gc for comparable retained-heap samples.
const args = process.argv.slice(2);
let soakMs = 0;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--soak-ms' || !/^\d+$/.test(args[1])) throw Error('Usage: node --expose-gc scripts/benchmark-timeline.mjs [--soak-ms <0..1800000>]');
  soakMs = Number(args[1]);
  if (!Number.isSafeInteger(soakMs) || soakMs > 1_800_000) throw Error('SOAK_DURATION_INVALID');
}
const roomId = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-25T00:00:00.000Z';
const id = value => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
function fixture(size) {
  const messages = Array.from({ length: size }, (_, i) => ({ seq: size - i, clientMsgId: id(i + 10), senderId: 'synthetic', status: 'delivered', acceptedAt: timestamp,
    payload: { v: 1, kind: i % 10 === 0 ? 'file' : i % 10 === 1 ? 'image' : i % 10 === 2 ? 'reaction' : 'text', sentAt: timestamp, text: 'synthetic' } }));
  const items = Array.from({ length: size }, (_, i) => ({ originRoomId: i % 3 === 0 ? 'another-room' : roomId, message: { ...messages[i], clientMsgId: id(i % 2 ? i + 10 : size + i + 10) }, self: false, sourceScope: 'synthetic' }));
  return { messages, items };
}
const legacy = (items, messages) => items.filter(item => item.originRoomId !== roomId || !messages.some(message => message.clientMsgId === item.message.clientMsgId));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const cases = [];
for (const size of [1_000, 10_000]) {
  const { messages, items } = fixture(size);
  const visible = orderedChatMessages(messages, [], [], new Set());
  const expected = legacy(items, visible);
  const actual = privateTimelineItems(items, visible, roomId);
  assert.deepEqual(actual, expected);
  const measure = fn => {
    fn();
    return median(Array.from({ length: 5 }, () => { globalThis.gc?.(); const start = performance.now(); fn(); return performance.now() - start; }));
  };
  const beforeMs = measure(() => legacy(items, visible));
  const afterMs = measure(() => privateTimelineItems(items, visible, roomId));
  cases.push({ size, visible: visible.length, privateRows: actual.length, beforeMedianMs: +beforeMs.toFixed(3), afterMedianMs: +afterMs.toFixed(3), speedup: +(beforeMs / afterMs).toFixed(2) });
}
console.log(JSON.stringify({ kind: 'synthetic-timeline-projection', node: process.version, gcAvailable: Boolean(globalThis.gc), cases }));
if (soakMs) {
  globalThis.gc?.();
  const started = performance.now(), initialHeap = process.memoryUsage().heapUsed;
  let cycles = 0, worstMs = 0;
  while (performance.now() - started < soakMs) {
    {
      const { messages, items } = fixture(10_000);
      const start = performance.now();
      const visible = orderedChatMessages(messages, [], [], new Set());
      const projected = privateTimelineItems(items, visible, roomId);
      assert.equal(visible.length, 9_000);
      assert.equal(projected.length, cases.at(-1).privateRows);
      worstMs = Math.max(worstMs, performance.now() - start);
    }
    cycles++;
    await delay(Math.min(5_000, Math.max(0, soakMs - (performance.now() - started))));
  }
  globalThis.gc?.();
  console.log(JSON.stringify({ kind: 'synthetic-timeline-projection-soak', durationMs: Math.round(performance.now() - started), cycles, initialHeap, finalHeap: process.memoryUsage().heapUsed, worstCycleMs: +worstMs.toFixed(3), gcAvailable: Boolean(globalThis.gc) }));
}
