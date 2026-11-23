import { Worker } from 'node:worker_threads';

function query(database, period) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./admin-room-analytics-worker.mjs', import.meta.url), {
      workerData: { database, period },
    });
    const timeout = setTimeout(() => { void worker.terminate(); }, 10_000);
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('ADMIN_ANALYTICS_UNAVAILABLE'));
    });
  });
}

export function createRoomAnalyticsReader(database) {
  const pending = new Map();
  let queue = Promise.resolve();
  return (period) => {
    const existing = pending.get(period);
    if (existing) return existing;
    const result = queue.then(() => query(database, period)).finally(() => pending.delete(period));
    pending.set(period, result);
    queue = result.catch(() => {});
    return result;
  };
}
