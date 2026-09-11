import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallSignalQueue } from '../src/lib/call-signal-queue';
import type { CallEnvelope } from '../src/lib/call-types';
const envelope = () => ({ callId: crypto.randomUUID(), eventId: crypto.randomUUID(), expiresAt: Date.now() + 60_000, ciphertext: 'test-ciphertext' }) as CallEnvelope;
afterEach(() => vi.useRealTimers());
describe('acknowledged signaling retry queue', () => {
  it('retransmits identical eventId/ciphertext after lost ack and never retransmits confirmed frames', async () => {
    vi.useFakeTimers(); const write = vi.fn(() => true); const queue = new CallSignalQueue(write); const frame = envelope();
    const sent = queue.send(frame); expect(queue.send(frame)).toBe(sent);
    await vi.advanceTimersByTimeAsync(1000); expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls.every(call => call[0] === frame)).toBe(true);
    queue.acknowledge('old-call', frame.eventId); expect(vi.getTimerCount()).toBe(1);
    queue.acknowledge(frame.callId, frame.eventId); await sent;
    await queue.send(frame); queue.flush(true); expect(write).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0); queue.close();
  });
  for (const duration of [1000, 5000, 15000]) it(`keeps an unsent candidate through ${duration}ms disconnect`, async () => {
    vi.useFakeTimers(); let connected = false; const sent: CallEnvelope[] = [];
    const queue = new CallSignalQueue(frame => { if (!connected) return false; sent.push(frame); return true; });
    const frame = envelope(), pending = queue.send(frame); await vi.advanceTimersByTimeAsync(duration); expect(sent).toHaveLength(0);
    connected = true; queue.flush(true); expect(sent).toEqual([frame]); queue.acknowledge(frame.callId, frame.eventId); await pending; queue.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels old queued frames before a new call and bounds missing acknowledgment', async () => {
    vi.useFakeTimers(); const write = vi.fn(() => false); const queue = new CallSignalQueue(write); const old = envelope();
    const canceled = expect(queue.send(old)).rejects.toMatchObject({ name: 'AbortError' }); queue.cancel(old.callId); await canceled;
    const fresh = envelope(); const timeout = expect(queue.send(fresh)).rejects.toMatchObject({ code: 'SIGNAL_ACK_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30_000); await timeout; queue.close(); expect(vi.getTimerCount()).toBe(0);
  });
});
