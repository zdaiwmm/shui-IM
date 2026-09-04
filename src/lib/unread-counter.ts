import { randomBase64Url } from './base64';
import type { Vault } from './types';

const STORAGE_KEY = 'quiet-room-unread-v1';
type CounterState = { roomId: string; deviceId: string; token: string; count: number };
const validCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The persisted observer can read a number only; it cannot open the vault or fetch messages. */
export class UnreadCounter {
  private state: CounterState | null = null;
  private version = 0;
  private requestId = 0;
  private appliedRequest = 0;
  private refreshingVersion: number | null = null;
  private configuringVersion: number | null = null;
  private registered = false;
  private readSeq = -1;
  private readPending = false;
  private pendingReadSeq = -1;

  constructor(private readonly changed: (count: number) => void) {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (value && typeof value.roomId === 'string' && /^[0-9a-f-]{36}$/i.test(value.roomId)
        && typeof value.deviceId === 'string' && /^[0-9a-f-]{36}$/i.test(value.deviceId)
        && typeof value.token === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value.token) && validCount(value.count)) {
        this.state = { roomId: value.roomId, deviceId: value.deviceId, token: value.token, count: value.count };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      }
    } catch { /* An unavailable local store does not prevent unlock. */ }
  }

  get count(): number { return this.state?.count ?? 0; }

  /** Call again on online/visible ticks after an offline registration failure. */
  async ensureConfigured(vault: Vault, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const matches = () => this.state?.roomId === vault.roomId && this.state.deviceId === vault.identity.publicBundle.deviceId;
    if (this.registered && matches()) return true;
    if (this.configuringVersion === this.version) return false;
    try { await this.configure(vault, signal); }
    catch { return false; }
    return !signal?.aborted && this.registered && matches();
  }

  private path(state: CounterState): string {
    return `/api/rooms/${state.roomId}/unread/${state.deviceId}`;
  }

  private apply(count: unknown, state: CounterState, version: number, request: number): void {
    if (this.state !== state || version !== this.version || request < this.appliedRequest || !validCount(count)) return;
    this.appliedRequest = request;
    state.count = count;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Memory remains usable. */ }
    this.changed(state.count);
  }

  async configure(vault: Vault, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const deviceId = vault.identity.publicBundle.deviceId;
    const existing = this.state?.roomId === vault.roomId && this.state.deviceId === deviceId;
    const state = existing ? this.state! : { roomId: vault.roomId, deviceId, token: randomBase64Url(32), count: 0 };
    this.state = state;
    if (!existing) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Best effort removal of the previous room's observer. */ }
      this.changed(0);
    }
    // The server can commit registration even if lock or a network failure hides
    // its response. Keep the count-only token so a locked reload can still poll.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Memory remains usable. */ }
    const version = ++this.version;
    this.configuringVersion = version;
    this.registered = false;
    this.readSeq = -1;
    this.readPending = false;
    this.pendingReadSeq = -1;
    const request = ++this.requestId;
    this.appliedRequest = request;
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    try {
      const response = await fetch(this.path(state), {
        method: 'POST', cache: 'no-store', signal: requestSignal,
        headers: { Authorization: `Bearer ${vault.accessToken}`, 'Content-Type': 'application/json' },
        // lastSeq tracks downloaded ciphertext, not visible chat. Registration
        // must preserve the server cursor (or its device join boundary).
        body: JSON.stringify({ token: state.token }),
      });
      if (version !== this.version || requestSignal.aborted) return;
      if (response.status === 401) this.clear();
      if (!response.ok) throw new Error('未读状态暂时无法同步');
      const result = await response.json();
      if (version !== this.version || requestSignal.aborted) return;
      if (!validCount(result.count)) throw new Error('未读状态暂时无法同步');
      this.registered = true;
      this.apply(result.count, state, version, request);
    } finally {
      if (this.configuringVersion === version) this.configuringVersion = null;
    }
  }

  async refresh(): Promise<void> {
    const state = this.state;
    const version = this.version;
    if (!state || this.refreshingVersion === version || this.configuringVersion === version || this.readPending) return;
    this.refreshingVersion = version;
    const request = ++this.requestId;
    try {
      const response = await fetch(this.path(state), { cache: 'no-store', headers: { Authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(10_000) });
      if (response.status === 401 && this.state === state && version === this.version && request >= this.appliedRequest) { this.clear(); return; }
      if (!response.ok) return;
      this.apply((await response.json()).count, state, version, request);
    } catch { /* Offline: retain the last server-confirmed count. */ }
    finally { if (this.refreshingVersion === version) this.refreshingVersion = null; }
  }

  async markRead(vault: Vault, seq: number, signal?: AbortSignal): Promise<void> {
    const state = this.state;
    if (!this.registered || !state || seq <= this.readSeq || !Number.isSafeInteger(seq) || seq < 0 || signal?.aborted
      || state.roomId !== vault.roomId || state.deviceId !== vault.identity.publicBundle.deviceId) return;
    this.pendingReadSeq = Math.max(this.pendingReadSeq, seq);
    if (this.readPending) return;
    const version = this.version;
    this.readPending = true;
    try {
      while (version === this.version && this.state === state && !signal?.aborted && this.pendingReadSeq > this.readSeq) {
        const target = this.pendingReadSeq;
        const request = ++this.requestId;
        // A GET started before this write may contain the previous unread count.
        this.appliedRequest = request;
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
        const response = await fetch(this.path(state), {
          method: 'POST', cache: 'no-store', signal: requestSignal,
          headers: { Authorization: `Bearer ${vault.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ readSeq: target }),
        });
        if (version !== this.version || requestSignal.aborted) return;
        if (response.status === 401) { this.clear(); return; }
        if (!response.ok) return;
        const result = await response.json();
        if (version !== this.version || requestSignal.aborted || !validCount(result.count)) return;
        this.readSeq = Math.max(this.readSeq, target);
        this.apply(result.count, state, version, request);
      }
    } catch { /* Retry from the next visible-chat observation. */ }
    finally { if (version === this.version) this.readPending = false; }
  }

  clear(): void {
    this.version++;
    this.state = null;
    this.registered = false;
    this.readPending = false;
    this.pendingReadSeq = -1;
    this.readSeq = -1;
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Best effort cleanup. */ }
    this.changed(0);
  }
}
