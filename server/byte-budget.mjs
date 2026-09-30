/** @typedef {{bytes: number, signal?: AbortSignal, resolve: (release: () => void) => void, abort: () => void}} Waiter */
/** FIFO, whole-operation reservations: callers never hold a partial budget.
 * @param {number} limit */
export function createByteBudget(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVALID_BYTE_BUDGET');
  let used = 0;
  let peak = 0;
  /** @type {Waiter[]} */
  const waiters = [];
  function drain() {
    while (waiters.length && used + waiters[0].bytes <= limit) {
      const waiter = waiters.shift();
      if (!waiter) return;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      used += waiter.bytes; peak = Math.max(peak, used);
      let released = false;
      waiter.resolve(() => { if (!released) { released = true; used -= waiter.bytes; drain(); } });
    }
  }
  return {
    snapshot: () => ({ limit, used, peak, waiting: waiters.length }),
    /** @param {number} bytes @param {AbortSignal} [signal] @returns {Promise<() => void>} */
    acquire(bytes, signal) {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limit) return Promise.reject(new Error('BYTE_BUDGET_EXCEEDED'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const waiter = { bytes, signal, resolve, abort: () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal?.reason); drain();
        } };
        signal?.addEventListener('abort', waiter.abort, { once: true });
        waiters.push(waiter); drain();
      });
    },
  };
}
