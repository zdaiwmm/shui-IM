import type { CallEnvelope } from './call-types';
import { NetworkOperationError } from './network-operation';
type Pending = { envelope: CallEnvelope; resolve: () => void; reject: (error: Error) => void; promise: Promise<void>; attempts: number; nextAt: number; deadline: number };
/** A bounded, memory-only queue of the original signed ciphertext, never a newly sealed retry. */
export class CallSignalQueue {
  private pending = new Map<string, Pending>();
  private confirmed = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private write: (envelope: CallEnvelope) => boolean) {}
  send(envelope: CallEnvelope): Promise<void> {
    for (const [key, expiry] of this.confirmed) if (expiry <= Date.now()) this.confirmed.delete(key);
    const key = `${envelope.callId}:${envelope.eventId}`;
    if (this.confirmed.has(key)) return Promise.resolve();
    if (this.pending.has(key)) return this.pending.get(key)!.promise;
    if (this.pending.size >= 256) return Promise.reject(new NetworkOperationError('WS_BACKPRESSURE', '信令发送队列已满'));
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
    this.pending.set(key, { envelope, promise, resolve, reject, attempts: 0, nextAt: 0, deadline: Math.min(envelope.expiresAt, Date.now() + 30_000) });
    this.flush();
    return promise;
  }
  acknowledge(callId: string, eventId: string) {
    const key = `${callId}:${eventId}`, pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (this.confirmed.size >= 512) this.confirmed.delete(this.confirmed.keys().next().value!);
    this.confirmed.set(key, pending.envelope.expiresAt);
    pending.resolve();
    this.schedule();
  }
  reject(callId: string, eventId: string, code: string) {
    const key = `${callId}:${eventId}`, pending = this.pending.get(key);
    if (!pending) return;
    if (['CALL_PEER_RECONNECTING', 'CALL_BACKPRESSURE', 'CALL_RATE_LIMITED'].includes(code)) { pending.nextAt = Date.now() + 2000; return; }
    this.pending.delete(key);
    pending.reject(new NetworkOperationError(code, '服务端拒绝通话信令'));
    this.schedule();
  }
  flush(reconnected = false) {
    for (const [key, pending] of this.pending) {
      if (Date.now() >= pending.deadline) {
        this.pending.delete(key);
        pending.reject(new NetworkOperationError('SIGNAL_ACK_TIMEOUT', '通话信令确认超时'));
      } else if (reconnected || Date.now() >= pending.nextAt) {
        let sent = false;
        try { sent = this.write(pending.envelope); } catch { /* Retry the same envelope after transport recovery. */ }
        if (sent) pending.attempts += 1;
        pending.nextAt = Date.now() + (sent ? Math.min(1000 * 2 ** Math.min(3, pending.attempts - 1), 8000) : 250);
      }
    }
    this.schedule();
  }
  cancel(callId: string) {
    for (const [key, pending] of this.pending) if (pending.envelope.callId === callId) {
      this.pending.delete(key); pending.reject(new DOMException('通话已结束', 'AbortError'));
    }
    this.schedule();
  }
  close() { for (const pending of [...this.pending.values()]) this.cancel(pending.envelope.callId); this.confirmed.clear(); }
  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.pending.size ? setTimeout(() => { this.timer = null; this.flush(); }, 250) : null;
  }
}
