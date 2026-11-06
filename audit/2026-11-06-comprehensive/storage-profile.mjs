import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createStore } from '../../server/storage.mjs';
import { outputDirectory, outputReady } from './harness.mjs';

// Query microbenchmark. Synthetic envelopes are seeded directly, so this is
// explicitly not an end-to-end cryptographic / network throughput measurement.
await outputReady();
const directory = await mkdtemp(path.join(tmpdir(), 'qr-audit-storage-'));
const store = await createStore({ dataDir: directory });
const filename = path.join(directory, 'quiet-room.sqlite');
const db = new DatabaseSync(filename);
const results = { kind: 'real-sqlite-synthetic-envelope-query-profile', cases: [] };
const bundle = deviceId => ({ deviceId,
  encryptionKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: [], ext: true },
  signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', key_ops: ['verify'], ext: true } });
const timings = operation => {
  operation(); // one unreported warm-up, then 50 independent timed calls
  return Array.from({ length: 50 }, () => { const start = performance.now(); operation(); return performance.now() - start; });
};
try {
  for (const count of [100, 1000, 10000, 100000]) {
    const creator = crypto.randomUUID(), peer = crypto.randomUUID();
    const { roomId } = store.createRoom(bundle(creator), 'a'.repeat(43));
    store.joinRoom(roomId, bundle(peer), 'synthetic-proof', 'b'.repeat(43));
    const insert = db.prepare('INSERT INTO messages(room_id, server_seq, client_msg_id, sender_device_id, envelope, accepted_at, count_unread) VALUES(?,?,?,?,?,?,1)');
    db.exec('BEGIN');
    for (let seq = 1; seq <= count; seq++) insert.run(roomId, seq, `synthetic-${seq}`, peer,
      JSON.stringify({ v: 1, roomId, clientMsgId: `synthetic-${seq}`, senderId: peer, ciphertext: 'A'.repeat(1024) }), '2026-11-06T00:00:00Z');
    db.prepare('UPDATE rooms SET next_seq=?,message_count=? WHERE room_id=?').run(count, count, roomId);
    db.exec('COMMIT');
    store.saveUnreadObserver(roomId, creator, { token: 'c'.repeat(43), readSeq: 0 });
    const page = store.messagePage(roomId, 0, creator, 128 * 1024);
    assert.ok(page.messages.length > 0 && page.messages.length <= 500);
    assert.equal(page.nextSeq, page.messages.length);
    assert.equal(page.hasMore, page.nextSeq < count);
    assert.equal(store.unreadCount(roomId, creator, 'c'.repeat(43)).count, count);
    assert.equal(store.messagePage(roomId, count, creator).messages.length, 0);
    const queryPlan = db.prepare('EXPLAIN QUERY PLAN SELECT server_seq,envelope,accepted_at FROM messages WHERE room_id=? AND server_seq>? AND server_seq>? ORDER BY server_seq LIMIT ?')
      .all(roomId, 0, 0, 501).map(row => row.detail);
    assert.ok(queryPlan.some(detail => /SEARCH messages USING INDEX/.test(detail)));
    results.cases.push({ count, rowsAt128KiB: page.messages.length, queryPlan,
      firstPageMs: timings(() => store.messagePage(roomId, 0, creator)),
      tailPageMs: timings(() => store.messagePage(roomId, Math.max(0, count - 100), creator)),
      unreadCountMs: timings(() => store.unreadCount(roomId, creator, 'c'.repeat(43))),
      sixSequentialPagesMs: timings(() => { for (let i = 0; i < 6; i++) store.messagePage(roomId, 0, creator); }),
      rss: process.memoryUsage().rss, sqliteBytes: (await stat(filename)).size });
    console.log('STORAGE_PROFILE', JSON.stringify({ count, rowsAt128KiB: page.messages.length, queryPlan }));
    await writeFile(path.join(outputDirectory, 'storage-profile.json'), JSON.stringify(results, null, 2));
  }
} finally { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
