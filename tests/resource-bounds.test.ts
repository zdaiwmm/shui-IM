import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createByteBudget } from '../server/byte-budget.mjs';
import { createSocketBudget } from '../server/socket-budget.mjs';
import { createStore } from '../server/storage.mjs';
import { backupStateHealth, readBackupState, writeBackupState } from '../scripts/backup-state.mjs';
import { assertBackupCapacity } from '../scripts/backup-capacity.mjs';
import { mergeHistoryProjection } from '../src/lib/history-projection';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), 'resource-bound-')); directories.push(dir); return dir; }

describe('whole-operation byte reservations', () => {
  it('bounds a burst, admits FIFO and releases idempotently', async () => {
    const budget = createByteBudget(10);
    const first = await budget.acquire(8);
    let admitted = false;
    const second = budget.acquire(4).then(release => { admitted = true; return release; });
    await Promise.resolve(); expect(admitted).toBe(false);
    expect(budget.snapshot()).toMatchObject({ used: 8, waiting: 1 });
    first(); first(); const release = await second;
    expect(budget.snapshot()).toMatchObject({ used: 4, peak: 8 }); release();
    expect(budget.snapshot().used).toBe(0);
    await expect(budget.acquire(11)).rejects.toThrow('BYTE_BUDGET_EXCEEDED');
  });
  it('cancels a waiting large operation without blocking later work', async () => {
    const budget = createByteBudget(10), abort = new AbortController();
    const release = await budget.acquire(6);
    const waiting = budget.acquire(8, abort.signal).catch(cause => cause);
    const next = budget.acquire(4);
    abort.abort('cancelled'); expect(await waiting).toBe('cancelled');
    const releaseNext = await next;
    expect(budget.snapshot()).toMatchObject({ used: 10, waiting: 0 });
    release(); releaseNext(); expect(budget.snapshot().used).toBe(0);
  });
});

class SlowSocket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; codes: number[] = []; callbacks: ((error?: Error) => void)[] = [];
  send(_value: string, callback: (error?: Error) => void) { this.callbacks.push(callback); }
  close(code: number) { this.codes.push(code); this.readyState = 3; this.emit('close'); }
}
describe('socket budgets', () => {
  const limits = { outputPerSocket: 100, outputTotal: 150, inputPerSocket: 100, inputTotal: 150, inputFrames: 2 };
  it('closes a slow socket before adding more output and frees global bytes once', () => {
    const budget = createSocketBudget(limits), a = new SlowSocket(), b = new SlowSocket();
    expect(budget.send(a, 'x'.repeat(80))).toBe(true);
    expect(budget.send(b, 'x'.repeat(80))).toBe(false);
    expect(b.codes).toEqual([4413]); expect(budget.snapshot().output).toBe(82);
    a.close(1000); a.callbacks[0]!(); expect(budget.snapshot().output).toBe(0);
  });
  it('counts UTF-8 bytes and catches send errors and callback failures', () => {
    const budget = createSocketBudget(limits), socket = new SlowSocket();
    socket.bufferedAmount = 90; expect(budget.send(socket, '🙂🙂🙂')).toBe(false);
    const throwing = new SlowSocket(); throwing.send = () => { throw Error('write'); };
    expect(budget.send(throwing, 'data')).toBe(false); expect(budget.snapshot().output).toBe(0);
    const failed = new SlowSocket(); budget.send(failed, 'data'); failed.callbacks[0]!(Error('write'));
    expect(failed.codes).toEqual([4413]); expect(budget.snapshot().output).toBe(0);
  });
  it('bounds incoming bytes globally and also bounds tiny queued frames', () => {
    const budget = createSocketBudget(limits), a = new SlowSocket(), b = new SlowSocket();
    const release = budget.reserveInput(a, 90)!;
    expect(budget.reserveInput(b, 61)).toBe(null);
    const small = budget.reserveInput(a, 1)!;
    expect(budget.reserveInput(a, 1)).toBe(null);
    release(); small(); release(); expect(budget.snapshot().input).toBe(0);
  });
  it('bounds tiny frames globally before byte limits, with one close listener per socket', () => {
    const budget = createSocketBudget({ ...limits, outputFrames: 2, outputFramesTotal: 3, inputFramesTotal: 2 });
    const a = new SlowSocket(), b = new SlowSocket(), c = new SlowSocket();
    expect(budget.send(a, '')).toBe(true); expect(budget.send(a, '')).toBe(true);
    expect(a.listenerCount('close')).toBe(1);
    expect(budget.send(b, '')).toBe(true); expect(budget.send(c, '')).toBe(false);
    const releaseA = budget.reserveInput(a, 0)!, releaseB = budget.reserveInput(b, 0)!;
    expect(budget.reserveInput(a, 0)).toBe(null);
    releaseA(); releaseB(); a.close(1000); b.close(1000);
    expect(budget.snapshot()).toEqual({ input: 0, output: 0 });
  });
});

describe('query-stage byte pagination', () => {
  it('splits large ciphertext into bounded pages with lossless cursor progression', async () => {
    const store = await createStore({ dataDir: await directory() });
    try {
      const deviceId = crypto.randomUUID();
      const { roomId } = store.createRoom({ deviceId, encryptionKey: {}, signingKey: {} }, 'a'.repeat(43));
      for (let index = 0; index < 30; index++) store.insertMessage(roomId,
        { v: 2, roomId, senderId: deviceId, clientMsgId: crypto.randomUUID(), ciphertext: 'a'.repeat(128 * 1024), signature: 'test' });
      const seen: number[] = []; let after = 0;
      for (;;) {
        const page = store.messagePage(roomId, after, deviceId);
        expect(Buffer.byteLength(JSON.stringify({ type: 'sync', ...page }))).toBeLessThanOrEqual(1024 ** 2);
        expect(page.messages.length).toBeLessThan(30);
        seen.push(...page.messages.map(message => message.seq));
        after = page.nextSeq;
        if (!page.hasMore) break;
      }
      expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      expect(store.messagePage(roomId, 0, 'missing').messages).toEqual([]);
      expect(() => store.messagePage(roomId, 0, deviceId, 512)).toThrow('SYNC_RECORD_TOO_LARGE');
    } finally { store.close(); }
  });
  it('keeps the 500-record cap and legacy small page behavior', async () => {
    const store = await createStore({ dataDir: await directory() });
    try {
      const deviceId = crypto.randomUUID();
      const { roomId } = store.createRoom({ deviceId, encryptionKey: {}, signingKey: {} }, 'a'.repeat(43));
      for (let index = 0; index < 501; index++) store.insertMessage(roomId,
        { roomId, senderId: deviceId, clientMsgId: crypto.randomUUID(), ciphertext: 'small' });
      const page = store.messagePage(roomId, 0, deviceId);
      expect(page.messages).toEqual(store.messagesAfter(roomId, 0, 500, deviceId));
      expect(page.hasMore).toBe(true); expect(page.nextSeq).toBe(500);
      expect(store.messagePage(roomId, 500, deviceId)).toMatchObject({ hasMore: false, nextSeq: 501 });
    } finally { store.close(); }
  });
});

describe('backup health evidence', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const fresh = { snapshotCreatedAt: new Date(now - 1000).toISOString(), lastVerifiedAt: new Date(now).toISOString(), lastAttemptSucceeded: true };
  it('fails closed for missing, stale, future and failed attempts', () => {
    expect(backupStateHealth(fresh, now).healthy).toBe(true);
    for (const value of [null, {}, { ...fresh, lastVerifiedAt: 'invalid' }, { ...fresh, snapshotCreatedAt: new Date(now + 1).toISOString() },
      { ...fresh, lastVerifiedAt: new Date(now + 1).toISOString() }, { ...fresh, lastAttemptSucceeded: false },
      { ...fresh, snapshotCreatedAt: new Date(now - 37 * 3600_000).toISOString() }]) expect(backupStateHealth(value, now).healthy).toBe(false);
    expect(() => backupStateHealth(fresh, now, NaN)).toThrow();
  });
  it('persists only status metadata atomically and preserves capacity protections', async () => {
    const root = await directory(); await writeBackupState(root, fresh);
    expect(await readBackupState(root)).toEqual(fresh);
    const stats = { bsize: 1024 ** 3, blocks: 40, bfree: 12, bavail: 12, files: 100, ffree: 90 };
    expect(() => assertBackupCapacity(stats)).not.toThrow();
    expect(() => assertBackupCapacity({ ...stats, bfree: 4.09, bavail: 4.09 })).toThrow('BACKUP_CAPACITY_LOW');
    expect(() => assertBackupCapacity({ ...stats, bavail: NaN })).toThrow('BACKUP_CAPACITY_UNKNOWN');
  });
});

describe('bounded history projection merge', () => {
  type Message = { seq: number; clientMsgId: string; payload: string; status?: string };
  async function* stream(rows: Message[]) { yield* rows; }
  const merge = (rows: Message[][], options = {}) => mergeHistoryProjection(rows.map(stream), {
    same: (a, b) => a.seq === b.seq && a.clientMsgId === b.clientMsgId && a.payload === b.payload,
    event: message => message.payload === 'delete', live: () => {}, ...options,
  });
  it('chooses the canonical ordinary copy and deduplicates event IDs in sequence order', async () => {
    const a = { seq: 1, clientMsgId: 'event', payload: 'delete', status: 'restored' };
    const b = { ...a, status: 'ordinary' }, later = { ...b, seq: 9 };
    expect(await merge([[a], [], [b]])).toEqual([b]);
    expect(await merge([[a], [], [b, later]])).toEqual([later]);
    await expect(merge([[a], [], [{ ...b, payload: 'text' }]])).rejects.toThrow('冲突');
  });
  it('propagates corruption/coverage failures and closes all readers on cancellation', async () => {
    const closed = vi.fn(); const controller = new AbortController();
    async function* source() { try { yield { seq: 1, clientMsgId: '1', payload: 'text' }; controller.abort(); yield { seq: 2, clientMsgId: '2', payload: 'text' }; } finally { closed(); } }
    await expect(mergeHistoryProjection([source(), source(), source()], { same: () => true, event: () => false, live: () => {}, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toHaveBeenCalledTimes(3);
    await expect(merge([[], [], [{ seq: 2, clientMsgId: '2', payload: 'text' }]], { live: () => { throw Error('missing'); } })).rejects.toThrow('missing');
  });
  it('consumes 50,000 ordinary records while keeping at most one yielded row per stream', async () => {
    let outstanding = 0, peak = 0, consumed = 0;
    async function* source() {
      for (let seq = 1; seq <= 50_000; seq++) {
        outstanding++; peak = Math.max(peak, outstanding);
        yield { seq, clientMsgId: String(seq), payload: seq % 100 === 0 ? 'delete' : 'text' };
        outstanding--; consumed++;
      }
    }
    const result = await mergeHistoryProjection([source(), source(), source()], { same: () => true, event: row => row.payload === 'delete', live: () => {} });
    expect(result).toHaveLength(500); expect(consumed).toBe(150_000); expect(peak).toBe(3);
  });
});
