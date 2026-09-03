import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomSocket } from '../src/lib/api';
import type { RoomState } from '../src/lib/types';

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
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

  close(): void {
    this.readyState = 3;
  }

  emit(type: string, data?: string): void {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RoomSocket membership ordering', () => {
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
