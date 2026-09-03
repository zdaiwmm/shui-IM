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
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
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
    const state = { roomId, members: [] } as unknown as RoomState;
    const socket = new RoomSocket(roomId, 'a'.repeat(43), () => 0, () => 0, {
      connection: () => undefined,
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
      error: (message) => { throw new Error(message); },
    });

    socket.connect();
    const transport = FakeWebSocket.instances[0]!;
    transport.emit('open');
    transport.emit('message', JSON.stringify({ type: 'ready', state }));
    transport.emit('message', JSON.stringify({ type: 'message', seq: 1 }));
    transport.emit('message', JSON.stringify({ type: 'sync', messages: [] }));
    transport.emit('message', JSON.stringify({ type: 'receipt', receiptSeq: 1 }));
    transport.emit('message', JSON.stringify({ type: 'receiptSync', receipts: [] }));

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
      ]);
    });

    socket.close();
  });
});
