import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { createRoomAnalytics } from './admin-room-analytics.mjs';

const db = new DatabaseSync(workerData.database, { readOnly: true, timeout: 1000 });
let report;
try {
  db.exec('BEGIN');
  report = createRoomAnalytics(db)(workerData.period);
} finally {
  db.close();
}
parentPort.postMessage(report);
