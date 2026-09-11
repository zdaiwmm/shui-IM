import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('probe collects only numeric fields, replaces prior capture, and releases listeners', () => {
  const listeners = new Map();
  const timers = new Map();
  let next = 0;
  let tick;
  let priorStopped = false;
  const input = { value: 'PRIVATE_DRAFT_NEVER_EXPORT', scrollTop: 0, scrollHeight: 40, clientHeight: 40 };
  const context = vm.createContext({
    window: { __iphoneDebug: { stop() { priorStopped = true; } } },
    document: {
      querySelector(selector) {
        return selector.includes('textarea') ? input : { getBoundingClientRect: () => ({ top: 1, bottom: 41, height: 40 }) };
      },
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: name => listeners.delete(name),
    },
    performance: { now: () => 5 }, Date, scrollY: 0, innerHeight: 852,
    visualViewport: { height: 500, offsetTop: 0 },
    requestAnimationFrame: handler => { tick = handler; return 1; },
    cancelAnimationFrame: () => { tick = null; },
    setTimeout: handler => { timers.set(++next, handler); return next; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
  });
  vm.runInContext(readFileSync(new URL('./viewport-probe.js', import.meta.url), 'utf8'), context);
  tick();
  listeners.get('input')();
  const result = context.window.__iphoneDebug.result;
  assert.equal(priorStopped, true);
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[0].length, result.columns.length);
  assert.ok(result.samples.every(row => row.every(value => typeof value === 'number')));
  assert.ok(!JSON.stringify(result).includes(input.value));
  context.window.__iphoneDebug.stop();
  assert.equal(listeners.size, 0);
  assert.equal(timers.size, 0);
  assert.equal(tick, null);
});
