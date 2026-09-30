import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSocket } from '../src/lib/api';
import type { DeliveryReceipt, MessageEnvelope, RoomState } from '../src/lib/types';

type Listener = (event: { data?: string; code?: number }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCodes: number[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code = 1000): void {
    this.closeCodes.push(code);
    this.readyState = 3;
  }

  emit(type: string, data?: string, code?: number): void {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener({ data, code });
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RoomSocket membership ordering', () => {
  const handlers = () => ({ connection: vi.fn(), presence: vi.fn(), ready: vi.fn(), membership: vi.fn(),
    message: vi.fn(), sync: vi.fn(), receipt: vi.fn(), receiptSync: vi.fn(), ack: vi.fn(), receiptAck: vi.fn(), error: vi.fn() });
  function environment() {
    vi.stubGlobal('location', { protocol: 'http:', host: 'quiet-room.test' });
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
    vi.stubGlobal('WebSocket', FakeWebSocket);
  }
  it('paces a durable receipt backlog instead of overflowing the server input queue', () => {
    environment(); const callbacks = handlers();
    const socket = new RoomSocket('room', 'token', () => 0, () => 0, callbacks);
    socket.connect(); const transport = FakeWebSocket.instances[0]!; transport.emit('open');
    transport.emit('message', JSON.stringify({ type: 'ready', state: {} }));
    for (let index = 0; index < 40; index++) socket.sendReceipt({ clientMsgId: String(index) } as DeliveryReceipt);
    const sent = transport.sent.map(value => JSON.parse(value)).filter(frame => frame.type === 'receipt');
    socket.close();
    expect(sent.length).toBeLessThanOrEqual(8);
  });
  it('drains all 40 receipts through ACK refills, retaining no duplicate transport queue', async () => {
    environment(); const callbacks = handlers();
    const pending = new Map(Array.from({ length: 40 }, (_, index) => [String(index), { clientMsgId: String(index) } as DeliveryReceipt]));
    const refill = () => { for (const receipt of pending.values()) socket.sendReceipt(receipt); };
    const socket = new RoomSocket('room', 'token', () => 0, () => 0, {
      ...callbacks, writable: refill, receiptAck: id => { pending.delete(id); },
    });
    socket.connect(); const transport = FakeWebSocket.instances[0]!; transport.emit('open');
    transport.emit('message', JSON.stringify({ type: 'ready', state: {} })); refill();
    for (let batch = 0; batch < 5; batch++) {
      const sent = transport.sent.map(value => JSON.parse(value)).filter(frame => frame.type === 'receipt');
      expect(sent).toHaveLength((batch + 1) * 8);
      for (const frame of sent.slice(batch * 8)) transport.emit('message', JSON.stringify({ type: 'receiptAck', clientMsgId: frame.receipt.clientMsgId, receiptSeq: 1 }));
      await vi.waitFor(() => expect(pending.size).toBe(40 - (batch + 1) * 8));
      await Promise.resolve(); await Promise.resolve();
    }
    expect(new Set(transport.sent.map(value => JSON.parse(value)).filter(frame => frame.type === 'receipt').map(frame => frame.receipt.clientMsgId)).size).toBe(40);
    expect(transport.closeCodes).toEqual([]); socket.close();
  });
  it('shares byte capacity across message and receipt sends and abandons ACK work after locking', async () => {
    environment(); const callbacks = handlers(); let finish!: () => void;
    const writable = vi.fn();
    const socket = new RoomSocket('room', 'token', () => 0, () => 0, { ...callbacks, writable,
      ack: () => new Promise<void>(resolve => { finish = resolve; }),
    });
    socket.connect(); const transport = FakeWebSocket.instances[0]!; transport.emit('open');
    transport.emit('message', JSON.stringify({ type: 'ready', state: {} }));
    const envelope = { clientMsgId: 'large', ciphertext: 'a'.repeat(400 * 1024) } as MessageEnvelope;
    expect(socket.sendEnvelope(envelope)).toBe(true);
    expect(socket.sendEnvelope(envelope)).toBe(true);
    expect(socket.sendReceipt({ clientMsgId: 'receipt', signature: 'a'.repeat(120 * 1024) } as DeliveryReceipt)).toBe(false);
    expect(transport.sent.filter(value => JSON.parse(value).type === 'send')).toHaveLength(1);
    transport.emit('message', JSON.stringify({ type: 'ack', clientMsgId: 'large', seq: 1 }));
    await Promise.resolve(); socket.close(); finish();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(writable).not.toHaveBeenCalled();
  });
  it('reconnects on an unacknowledged send and clears the old generation reservation', () => {
    vi.useFakeTimers(); environment(); const callbacks = handlers();
    const socket = new RoomSocket('room', 'token', () => 0, () => 0, callbacks);
    socket.connect(); const first = FakeWebSocket.instances[0]!; first.emit('open');
    first.emit('message', JSON.stringify({ type: 'ready', state: {} }));
    socket.sendReceipt({ clientMsgId: 'same-id' } as DeliveryReceipt);
    vi.advanceTimersByTime(15_000); expect(first.closeCodes).toContain(4000);
    first.emit('close', undefined, 4000); vi.advanceTimersByTime(1000);
    const next = FakeWebSocket.instances[1]!; next.emit('open');
    next.emit('message', JSON.stringify({ type: 'ready', state: {} }));
    expect(socket.sendReceipt({ clientMsgId: 'same-id' } as DeliveryReceipt)).toBe(true);
    expect(next.sent.some(value => JSON.parse(value).type === 'receipt')).toBe(true); socket.close();
  });
  it('uses explicit hasMore and falls back to the legacy 500-count rule', async () => {
    environment(); const callbacks = handlers();
    const socket = new RoomSocket('room', 'token', () => 7, () => 4, callbacks);
    socket.connect(); const transport = FakeWebSocket.instances[0]!; transport.emit('open');
    expect(JSON.parse(transport.sent[0]!)).toMatchObject({ syncProtocol: 'byte-pages-v1', afterSeq: 7, afterReceiptSeq: 4 });
    transport.emit('message', JSON.stringify({ type: 'sync', messages: [{ seq: 8 }], hasMore: true, nextSeq: 9999 }));
    await vi.waitFor(() => expect(callbacks.sync).toHaveBeenCalledWith([{ seq: 8 }], true));
    transport.emit('message', JSON.stringify({ type: 'sync', messages: Array.from({ length: 500 }, () => ({ seq: 9 })) }));
    transport.emit('message', JSON.stringify({ type: 'receiptSync', receipts: [], hasMore: false }));
    await vi.waitFor(() => expect(callbacks.receiptSync).toHaveBeenCalledWith([], false));
    expect(callbacks.sync.mock.calls[1]![1]).toBe(true);
    socket.close();
  });
  it('abandons queued frames after close and reconnects with the durable cursor and jitter', async () => {
    vi.useFakeTimers(); environment(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const callbacks = handlers(); let cursor = 10, finish!: () => void;
    callbacks.ready.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const socket = new RoomSocket('room', 'token', () => cursor, () => 0, callbacks);
    socket.connect(); const first = FakeWebSocket.instances[0]!; first.emit('open');
    first.emit('message', JSON.stringify({ type: 'ready', state: {} })); await Promise.resolve();
    first.emit('message', JSON.stringify({ type: 'sync', messages: [{ seq: 11 }], hasMore: false }));
    first.emit('close', undefined, 4413); cursor = 12;
    finish(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(callbacks.sync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(749); expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); const second = FakeWebSocket.instances[1]!; second.emit('open');
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ afterSeq: 12 }); socket.close();
  });
  it('bounds frames waiting on membership and releases them without late delivery', async () => {
    environment(); const callbacks = handlers(); let finish!: () => void;
    callbacks.ready.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const socket = new RoomSocket('room', 'token', () => 0, () => 0, callbacks);
    socket.connect(); const transport = FakeWebSocket.instances[0]!; transport.emit('open');
    transport.emit('message', JSON.stringify({ type: 'ready', state: {} })); await Promise.resolve();
    for (let index = 0; index < 130; index++) transport.emit('message', JSON.stringify({ type: 'message', seq: index + 1 }));
    expect(transport.closeCodes).toContain(4413);
    socket.close(); finish();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(callbacks.message).not.toHaveBeenCalled();
  });
  it('holds messages and receipts until async membership verification completes', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'quiet-room.test' });
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);

    let finishMembership!: () => void;
    const membershipVerified = new Promise<void>((resolve) => { finishMembership = resolve; });
    const calls: string[] = [];
    const roomId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const state = { roomId, members: [] } as unknown as RoomState;
    const socket = new RoomSocket(roomId, 'a'.repeat(43), () => 0, () => 0, {
      connection: () => undefined,
      presence: () => undefined,
      ready: async () => {
        calls.push('membership:start');
        await membershipVerified;
        calls.push('membership:verified');
      },
      membership: () => undefined,
      message: () => { calls.push('message'); },
      sync: () => { calls.push('sync'); },
      receipt: () => { calls.push('receipt'); },
      receiptSync: () => { calls.push('receiptSync'); },
      ack: () => undefined,
      receiptAck: () => undefined,
      error: (message, code, clientMsgId) => { calls.push(`error:${code}:${clientMsgId}:${message}`); },
    }, deviceId, ['image-album-v1']);

    socket.connect();
    const transport = FakeWebSocket.instances[0]!;
    transport.emit('open');
    expect(JSON.parse(transport.sent[0]!)).toMatchObject({
      type: 'auth',
      roomId,
      deviceId,
      capabilities: ['image-album-v1'],
    });
    transport.emit('message', JSON.stringify({ type: 'ready', state }));
    transport.emit('message', JSON.stringify({ type: 'message', seq: 1 }));
    transport.emit('message', JSON.stringify({ type: 'sync', messages: [] }));
    transport.emit('message', JSON.stringify({ type: 'receipt', receiptSeq: 1 }));
    transport.emit('message', JSON.stringify({ type: 'receiptSync', receipts: [] }));
    transport.emit('message', JSON.stringify({
      type: 'error', code: 'MLS_EPOCH_STALE', clientMsgId: 'queued-message', message: 'rekey',
    }));

    await Promise.resolve();
    expect(calls).toEqual(['membership:start']);

    finishMembership();
    await vi.waitFor(() => {
      expect(calls).toEqual([
        'membership:start',
        'membership:verified',
        'message',
        'sync',
        'receipt',
        'receiptSync',
        'error:MLS_EPOCH_STALE:queued-message:rekey',
      ]);
    });

    socket.close();
  });

  it('recovers the membership queue after one handler failure', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'quiet-room.test' });
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const calls: string[] = [];
    let membershipCalls = 0;
    const roomId = crypto.randomUUID();
    const state = { roomId, members: [] } as unknown as RoomState;
    const socket = new RoomSocket(roomId, 'a'.repeat(43), () => 0, () => 0, {
      connection: () => undefined,
      presence: () => undefined,
      ready: () => undefined,
      membership: () => {
        membershipCalls += 1;
        calls.push(`membership:${membershipCalls}`);
        if (membershipCalls === 1) throw new Error('一次性成员处理失败');
      },
      message: () => { calls.push('message'); },
      sync: () => undefined,
      receipt: () => undefined,
      receiptSync: () => undefined,
      ack: () => undefined,
      receiptAck: () => undefined,
      error: (message) => { calls.push(`error:${message}`); },
    });

    socket.connect();
    const transport = FakeWebSocket.instances[0]!;
    transport.emit('open');
    transport.emit('message', JSON.stringify({ type: 'ready', state }));
    transport.emit('message', JSON.stringify({ type: 'membership', state }));
    transport.emit('message', JSON.stringify({ type: 'membership', state }));
    transport.emit('message', JSON.stringify({ type: 'message', seq: 1 }));

    await vi.waitFor(() => {
      expect(calls).toEqual([
        'membership:1',
        'error:一次性成员处理失败',
        'membership:2',
        'message',
      ]);
    });
    socket.close();
  });
});

describe('RoomSocket chat presence', () => {
  it('buffers the desired view until authentication, de-duplicates updates, and delivers role snapshots immediately', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'quiet-room.test' });
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
    vi.stubGlobal('WebSocket', FakeWebSocket);

    let finishMembership!: () => void;
    const membershipVerified = new Promise<void>((resolve) => { finishMembership = resolve; });
    const presence: Array<{ creator: boolean; joiner: boolean }> = [];
    const errors: string[] = [];
    const roomId = crypto.randomUUID();
    const state = { roomId, members: [] } as unknown as RoomState;
    const socket = new RoomSocket(roomId, 'a'.repeat(43), () => 0, () => 0, {
      connection: () => undefined,
      presence: (roles) => { presence.push(roles); },
      ready: () => membershipVerified,
      membership: () => undefined,
      message: () => undefined,
      sync: () => undefined,
      receipt: () => undefined,
      receiptSync: () => undefined,
      ack: () => undefined,
      receiptAck: () => undefined,
      error: (message, code) => { errors.push(`${code}:${message}`); },
    });

    socket.setChatPresence(true);
    socket.connect();
    const transport = FakeWebSocket.instances[0]!;
    transport.emit('open');
    expect(transport.sent.map((value) => JSON.parse(value).type)).toEqual(['auth']);

    transport.emit('message', JSON.stringify({ type: 'ready', state }));
    expect(JSON.parse(transport.sent[1]!)).toEqual({ type: 'presence', view: 'chat' });

    socket.setChatPresence(true);
    expect(transport.sent).toHaveLength(2);
    socket.setChatPresence(false);
    expect(JSON.parse(transport.sent[2]!)).toEqual({ type: 'presence', view: 'away' });

    transport.emit('message', JSON.stringify({
      type: 'presence',
      roles: { creator: true, joiner: false },
    }));
    expect(presence).toEqual([{ creator: true, joiner: false }]);
    expect(errors).toEqual([]);

    finishMembership();
    socket.close();
  });

  it('replays the latest desired view after reconnecting', () => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { protocol: 'http:', host: 'quiet-room.test' });
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const roomId = crypto.randomUUID();
    const state = { roomId, members: [] } as unknown as RoomState;
    const socket = new RoomSocket(roomId, 'a'.repeat(43), () => 0, () => 0, {
      connection: () => undefined,
      presence: () => undefined,
      ready: () => undefined,
      membership: () => undefined,
      message: () => undefined,
      sync: () => undefined,
      receipt: () => undefined,
      receiptSync: () => undefined,
      ack: () => undefined,
      receiptAck: () => undefined,
      error: () => undefined,
    });

    socket.setChatPresence(true);
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.emit('open');
    first.emit('message', JSON.stringify({ type: 'ready', state }));
    expect(JSON.parse(first.sent[1]!)).toEqual({ type: 'presence', view: 'chat' });

    first.emit('close');
    socket.setChatPresence(false);
    vi.advanceTimersByTime(1000);
    const second = FakeWebSocket.instances[1]!;
    second.emit('open');
    expect(second.sent.map((value) => JSON.parse(value).type)).toEqual(['auth']);
    second.emit('message', JSON.stringify({ type: 'ready', state }));
    expect(JSON.parse(second.sent[1]!)).toEqual({ type: 'presence', view: 'away' });

    socket.close();
  });

  it('rejects malformed server presence snapshots', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'quiet-room.test' });
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval });
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const errors: string[] = [];
    const socket = new RoomSocket(crypto.randomUUID(), 'a'.repeat(43), () => 0, () => 0, {
      connection: () => undefined,
      presence: () => undefined,
      ready: () => undefined,
      membership: () => undefined,
      message: () => undefined,
      sync: () => undefined,
      receipt: () => undefined,
      receiptSync: () => undefined,
      ack: () => undefined,
      receiptAck: () => undefined,
      error: (message, code) => { errors.push(`${code}:${message}`); },
    });
    socket.connect();
    const transport = FakeWebSocket.instances[0]!;
    transport.emit('open');
    transport.emit('message', JSON.stringify({ type: 'presence', roles: { creator: true, joiner: 'yes' } }));

    await vi.waitFor(() => expect(errors).toEqual(['INVALID_SERVER_FRAME:收到无法识别的实时数据']));
    socket.close();
  });
});
