import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnreadCounter } from '../src/lib/unread-counter';
import type { Vault } from '../src/lib/types';

const key = 'quiet-room-unread-v1';
const roomId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const observer = { roomId, deviceId, token: 'o'.repeat(43), count: 3 };
const vault = {
  roomId, accessToken: 'device-credential-must-not-be-persisted', lastSeq: 12,
  identity: { publicBundle: { deviceId }, signingPrivateKey: { secret: 'private-key-must-not-be-retained' } },
} as unknown as Vault;
const otherVault = { ...vault, roomId: '33333333-3333-4333-8333-333333333333' };
const reply = (count: unknown, status = 200) => new Response(JSON.stringify({ count }), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let stored: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => { stored.set(name, value); },
    removeItem: (name: string) => { stored.delete(name); },
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function restored() {
  stored.set(key, JSON.stringify(observer));
  const changed = vi.fn();
  return { counter: new UnreadCounter(changed), changed };
}
async function configured() {
  const result = restored();
  fetchMock.mockResolvedValueOnce(reply(3));
  await result.counter.configure(vault);
  fetchMock.mockClear();
  return result;
}

describe('unread counter lifecycle', () => {
  it('restores only count-observer fields and keeps locked refresh read-only', async () => {
    stored.set(key, JSON.stringify({ ...observer, accessToken: vault.accessToken, identity: vault.identity }));
    const counter = new UnreadCounter(vi.fn());
    expect(JSON.parse(stored.get(key)!)).toEqual(observer);
    expect(counter.count).toBe(3);
    await counter.markRead(vault, 12);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(reply(5));
    await counter.refresh();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/rooms/${roomId}/unread/${deviceId}`);
    expect(options).toMatchObject({ cache: 'no-store', headers: { Authorization: `Bearer ${observer.token}` } });
    expect(options.method).toBeUndefined();
    expect(options.body).toBeUndefined();
    expect(JSON.parse(stored.get(key)!)).toEqual({ ...observer, count: 5 });
    expect(JSON.stringify(counter)).not.toContain(vault.accessToken);
    expect(JSON.stringify(counter)).not.toContain('private-key-must-not-be-retained');
  });

  it('registers with the initial history boundary and preserves the existing cursor on later unlocks', async () => {
    const counter = new UnreadCounter(vi.fn());
    fetchMock.mockResolvedValueOnce(reply(0));
    await counter.configure(vault);
    const options = fetchMock.mock.calls[0]![1];
    const body = JSON.parse(options.body);
    expect(body).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), readSeq: 12 });
    expect(options.headers.Authorization).toBe(`Bearer ${vault.accessToken}`);
    const saved = JSON.parse(stored.get(key)!);
    expect(saved).toEqual({ roomId, deviceId, token: body.token, count: 0 });
    fetchMock.mockResolvedValueOnce(reply(2));
    await counter.configure(vault);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({ token: body.token });
    expect(JSON.stringify(counter)).not.toContain(vault.accessToken);
  });

  it('retries an unconfirmed initial registration with its history boundary', async () => {
    const counter = new UnreadCounter(vi.fn());
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(counter.configure(vault)).rejects.toThrow();
    expect(stored.has(key)).toBe(false);
    fetchMock.mockResolvedValueOnce(reply(0));
    await counter.configure(vault);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ readSeq: 12 });
  });

  it('can retry configuration from visible or online ticks without retaining vault credentials or duplicating pending requests', async () => {
    const counter = new UnreadCounter(vi.fn());
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await counter.ensureConfigured(vault)).toBe(false);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const retry = counter.ensureConfigured(vault);
    expect(await counter.ensureConfigured(vault)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending.resolve(reply(0));
    expect(await retry).toBe(true);
    expect(await counter.ensureConfigured(vault)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(counter)).not.toContain(vault.accessToken);
    expect(await counter.ensureConfigured(vault, AbortSignal.abort())).toBe(false);
  });

  it('coalesces newer visible read positions while the first read update is pending', async () => {
    const { counter } = await configured();
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(reply(0));
    const update = counter.markRead(vault, 12);
    await counter.markRead(vault, 17);
    await counter.markRead(vault, 14);
    await counter.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    first.resolve(reply(2));
    await update;
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([{ readSeq: 12 }, { readSeq: 17 }]);
    expect(counter.count).toBe(0);
    await counter.markRead(vault, 17);
    await counter.markRead(vault, -1);
    await counter.markRead(vault, Number.NaN);
    await counter.markRead(otherVault, 30);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a GET started before a read update overwrite its result or clear its observer', async () => {
    const { counter } = await configured();
    const oldGet = deferred<Response>();
    const write = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldGet.promise).mockReturnValueOnce(write.promise);
    const refresh = counter.refresh();
    const update = counter.markRead(vault, 12);
    write.resolve(reply(0));
    await update;
    oldGet.resolve(reply(8));
    await refresh;
    expect(counter.count).toBe(0);
    const unauthorized = deferred<Response>();
    fetchMock.mockReturnValueOnce(unauthorized.promise).mockResolvedValueOnce(reply(0));
    const oldUnauthorized = counter.refresh();
    await counter.markRead(vault, 13);
    unauthorized.resolve(reply(null, 401));
    await oldUnauthorized;
    expect(stored.has(key)).toBe(true);
  });

  it('ignores old room responses and allows a new room refresh before the old one settles', async () => {
    const { counter } = await configured();
    const oldGet = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldGet.promise);
    const oldRefresh = counter.refresh();
    fetchMock.mockResolvedValueOnce(reply(1));
    await counter.configure(otherVault);
    fetchMock.mockResolvedValueOnce(reply(2));
    await counter.refresh();
    expect(counter.count).toBe(2);
    oldGet.resolve(reply(null, 401));
    await oldRefresh;
    expect(counter.count).toBe(2);
    expect(JSON.parse(stored.get(key)!).roomId).toBe(otherVault.roomId);
  });

  it('suppresses refresh during configure and discards stale registration results after clear or replacement', async () => {
    const { counter } = restored();
    const first = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise);
    const oldConfigure = counter.configure(vault);
    await counter.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(reply(1));
    await counter.configure(otherVault);
    first.resolve(reply(40));
    await oldConfigure;
    expect(counter.count).toBe(1);
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const newConfigure = counter.configure(otherVault);
    counter.clear();
    pending.resolve(reply(20));
    await newConfigure;
    expect(counter.count).toBe(0);
    expect(stored.has(key)).toBe(false);
  });

  it('ignores aborted writes and retries the read cursor instead of treating it as acknowledged', async () => {
    const { counter } = await configured();
    const controller = new AbortController();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const update = counter.markRead(vault, 12, controller.signal);
    controller.abort();
    pending.resolve(reply(0));
    await update;
    expect(counter.count).toBe(3);
    fetchMock.mockResolvedValueOnce(reply(0));
    await counter.markRead(vault, 12);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(counter.count).toBe(0);
  });

  it('retains the confirmed count offline or on malformed responses and clears current unauthorized observers', async () => {
    const { counter, changed } = restored();
    for (const result of [reply(-1), reply('5'), reply(null), reply(0, 503)]) {
      fetchMock.mockResolvedValueOnce(result);
      await counter.refresh();
      expect(counter.count).toBe(3);
    }
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await counter.refresh();
    expect(counter.count).toBe(3);
    fetchMock.mockResolvedValueOnce(reply(null, 401));
    await counter.refresh();
    expect(counter.count).toBe(0);
    expect(changed).toHaveBeenLastCalledWith(0);
    expect(stored.has(key)).toBe(false);
  });

  it('rejects malformed observer state and remains usable when local persistence is unavailable', async () => {
    for (const state of [{ ...observer, roomId: [roomId] }, { ...observer, token: 'short' }, { ...observer, count: -1 }]) {
      stored.set(key, JSON.stringify(state));
      expect(new UnreadCounter(vi.fn()).count).toBe(0);
    }
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } });
    const counter = new UnreadCounter(vi.fn());
    fetchMock.mockResolvedValueOnce(reply(2));
    await counter.configure(vault);
    expect(counter.count).toBe(2);
    counter.clear();
    expect(counter.count).toBe(0);
  });
});
