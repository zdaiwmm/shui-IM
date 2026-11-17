import { describe, expect, it, vi } from 'vitest';
import { acceptReleaseWorkerMessage, currentRelease, pendingReleaseUpdate, collectReleaseNotes, prepareReleaseVisit, startReleaseUpdateDetection } from '../src/lib/release-update';

describe('worker update startup', () => {
  for (const readyState of ['complete', 'loading']) it(`registers when startup is ${readyState}`, async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ update });
    const windowEvents = new EventTarget();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ id: currentRelease.id })));
    vi.stubGlobal('window', Object.assign(windowEvents, { setInterval: vi.fn() }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { readyState, hidden: false }));
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { register, addEventListener: vi.fn() } });
    try {
      startReleaseUpdateDetection();
      if (readyState === 'loading') {
        expect(register).not.toHaveBeenCalled();
        windowEvents.dispatchEvent(new Event('load'));
        windowEvents.dispatchEvent(new Event('load'));
      }
      await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
      expect(register).toHaveBeenCalledExactlyOnceWith('/sw.js', { updateViaCache: 'none' });
      expect(update).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('foreground version checks', () => {
  it('detects an update without workers and checks on foreground events', async () => {
    const windowEvents = Object.assign(new EventTarget(), { setInterval: vi.fn() });
    const documentEvents = Object.assign(new EventTarget(), { readyState: 'complete', hidden: false });
    let id = currentRelease.id;
    const fetcher = vi.fn(async () => Response.json({ id }));
    vi.stubGlobal('window', windowEvents); vi.stubGlobal('document', documentEvents);
    vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('fetch', fetcher);
    try {
      startReleaseUpdateDetection();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      for (const event of ['pageshow', 'focus', 'online']) {
        const before = fetcher.mock.calls.length;
        await vi.waitFor(() => { windowEvents.dispatchEvent(new Event(event)); expect(fetcher.mock.calls.length).toBeGreaterThan(before); });
      }
      documentEvents.hidden = true;
      const before = fetcher.mock.calls.length;
      documentEvents.dispatchEvent(new Event('visibilitychange'));
      expect(fetcher).toHaveBeenCalledTimes(before);
      id = '2099.01.01.1'; documentEvents.hidden = false;
      await vi.waitFor(() => { documentEvents.dispatchEvent(new Event('visibilitychange')); expect(pendingReleaseUpdate()).toBe(id); });
      expect(fetcher.mock.calls[0]).toEqual(['/release.json', expect.objectContaining({ cache: 'no-store' })]);
      expect(windowEvents.setInterval).toHaveBeenCalledWith(expect.any(Function), 60000);
      expect(acceptReleaseWorkerMessage({ type: 'quiet-room-release-ready', releaseId: '2000.01.01.1' })).toBe(false);
      expect(pendingReleaseUpdate()).toBe(id);
    } finally { vi.unstubAllGlobals(); }
  });

  it('retries a failed worker registration when the page returns', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    const register = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ update, active: { postMessage } });
    const windowEvents = Object.assign(new EventTarget(), { setInterval: vi.fn() });
    vi.stubGlobal('window', windowEvents);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { readyState: 'complete', hidden: false }));
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { register, addEventListener: vi.fn() } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: currentRelease.id })));
    try {
      startReleaseUpdateDetection();
      await vi.waitFor(() => {
        if (register.mock.calls.length < 2) windowEvents.dispatchEvent(new Event('online'));
        expect(update).toHaveBeenCalledOnce();
      });
      expect(register).toHaveBeenCalledTimes(2);
      expect(postMessage).toHaveBeenCalledWith({ type: 'quiet-room-release-query' });
    } finally { vi.unstubAllGlobals(); }
  });

  for (const pending of ['register', 'update']) it(`keeps manifest checks alive while worker ${pending} stays pending`, async () => {
    const never = new Promise<never>(() => {});
    const update = vi.fn(() => pending === 'update' ? never : Promise.resolve());
    const register = vi.fn(() => pending === 'register' ? never : Promise.resolve({ update }));
    const windowEvents = Object.assign(new EventTarget(), { setInterval: vi.fn() });
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Error('offline'))
      .mockImplementation(async () => Response.json({ id: currentRelease.id }));
    vi.stubGlobal('window', windowEvents);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { readyState: 'complete', hidden: false }));
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { register, addEventListener: vi.fn() } });
    vi.stubGlobal('fetch', fetcher);
    try {
      startReleaseUpdateDetection();
      await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
      for (const event of ['online', 'focus', 'pageshow']) {
        const before = fetcher.mock.calls.length;
        await vi.waitFor(() => {
          windowEvents.dispatchEvent(new Event(event));
          expect(fetcher.mock.calls.length).toBeGreaterThan(before);
        });
      }
      const before = fetcher.mock.calls.length;
      await vi.waitFor(() => {
        windowEvents.setInterval.mock.calls[0]![0]();
        expect(fetcher.mock.calls.length).toBeGreaterThan(before);
      });
      expect(register).toHaveBeenCalledOnce();
      expect(update).toHaveBeenCalledTimes(pending === 'update' ? 1 : 0);
    } finally { vi.unstubAllGlobals(); }
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

describe('release visit tracking', () => {
  it('does not call a fresh install an update', () => {
    const storage = memoryStorage();
    expect(prepareReleaseVisit(storage, '2')).toBe(false);
    expect(storage.values.get('quiet-room.current-release')).toBe('2');
  });

  it('shows notes once after moving from an older release', () => {
    const storage = memoryStorage({ 'quiet-room.current-release': '1' });
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
    storage.setItem('quiet-room.seen-release-notes', '2');
    expect(prepareReleaseVisit(storage, '2')).toBe(false);
  });

  it('keeps notes pending across reloads until chat has shown them', () => {
    const storage = memoryStorage({ 'quiet-room.current-release': '1' });
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
    expect(storage.values.get('quiet-room.pending-release-notes')).toBe('2');
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
  });

  it('fails quietly when durable storage is unavailable', () => {
    const storage = { getItem: vi.fn(() => { throw new Error('blocked'); }), setItem: vi.fn() };
    expect(prepareReleaseVisit(storage, '2')).toBe(false);
  });

  it('retains the last seen baseline through multiple cover-only upgrades', () => {
    const storage = memoryStorage({ 'quiet-room.current-release': '1' });
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
    expect(prepareReleaseVisit(storage, '3')).toBe(true);
    expect(storage.getItem('quiet-room.release-notes-base')).toBe('1');
    const releases = [
      { id: '1', title: 'Update', notes: ['already read'] },
      { id: '2', title: 'Update', notes: ['keyboard', 'media'] },
      { id: '3', title: 'Update', notes: ['media', 'stickers'] },
    ];
    expect(collectReleaseNotes(storage.getItem('quiet-room.release-notes-base'), releases)).toEqual(['keyboard', 'media', 'stickers']);
    expect(collectReleaseNotes('2', releases)).toEqual(['media', 'stickers']);
    expect(collectReleaseNotes('3', releases)).toEqual([]);
    expect(collectReleaseNotes('older-unknown', releases)).toEqual(['already read', 'keyboard', 'media', 'stickers']);
  });
});
