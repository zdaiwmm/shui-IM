// Synthetic, local-only observations. Does not read production or deployment config.
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/storage.mjs';
import { mergeHistoryProjection } from '../src/lib/history-projection.ts';

const observations = [];
for (const rooms of [10, 100, 1000]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiet-room-architecture-'));
  let store, database;
  try {
    store = await createStore({ dataDir });
    let selected;
    for (let index = 0; index < rooms; index++) {
      const deviceId = crypto.randomUUID();
      selected = { deviceId, ...store.createRoom({ deviceId, signingKey: {}, encryptionKey: {} }, 'a'.repeat(43)) };
    }
    database = new DatabaseSync(path.join(dataDir, 'quiet-room.sqlite'));
    const sum = database.prepare('SELECT COALESCE(SUM(message_bytes), 0) AS bytes FROM rooms');
    for (let index = 0; index < 100; index++) sum.get();
    const start = performance.now();
    for (let index = 0; index < 1000; index++) sum.get();
    const aggregateMsPerQuery = (performance.now() - start) / 1000;
    const insertStart = performance.now();
    for (let index = 0; index < 100; index++) store.insertMessage(selected.roomId, {
      roomId: selected.roomId, senderId: selected.deviceId, clientMsgId: crypto.randomUUID(), ciphertext: 'a'.repeat(1024),
    });
    observations.push({ rooms, aggregateMsPerQuery, insertMsPerMessage: (performance.now() - insertStart) / 100 });
  } finally { database?.close(); store?.close(); await rm(dataDir, { recursive: true, force: true }); }
}

const N = 50_000, pageSize = 200;
let livePages = 0, peakPageObjects = 0;
async function* pagedSource() {
  for (let start = 1; start <= N; start += pageSize) {
    const page = Array.from({ length: Math.min(pageSize, N - start + 1) }, (_, i) => ({
      seq: start + i, clientMsgId: String(start + i), event: (start + i) % 100 === 0,
    }));
    livePages += page.length; peakPageObjects = Math.max(peakPageObjects, livePages);
    try { yield* page; } finally { livePages -= page.length; }
  }
}
const start = performance.now();
const events = await mergeHistoryProjection([pagedSource(), pagedSource(), pagedSource()], {
  same: (a, b) => a.seq === b.seq, event: message => message.event, live: () => {},
});
process.stdout.write(`${JSON.stringify({ kind: 'synthetic-observations', node: process.version,
  sqlite: observations, history: { rowsPerStream: N, pageSize, peakPageObjects, retainedEvents: events.length,
    conservativeRetainedObjectBound: peakPageObjects + events.length, elapsedMs: performance.now() - start },
  limitations: 'Synthetic warm queries and object counts; excludes production room distribution, SQLite contention, AEAD, browser RSS and chat latency.' }, null, 2)}\n`);
