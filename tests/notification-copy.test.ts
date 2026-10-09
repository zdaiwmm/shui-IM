import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFICATION_COPY, normalizeNotificationCopy, notificationCopyLength, NOTIFICATION_COPY_URL, readNotificationCopy, saveNotificationCopy } from '../src/lib/notification-copy';
import { NOTIFICATION_POLICY_URL } from '../src/lib/notification-policy';

describe('device-local fixed notification copy', () => {
  let records: Map<string, Response>;
  let put: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    records = new Map();
    put = vi.fn(async (key: string, value: Response) => { records.set(key, value); });
    vi.stubGlobal('caches', { open: async () => ({ match: async (key: string) => records.get(key)?.clone(), put }) });
    let chain = Promise.resolve();
    vi.stubGlobal('navigator', { locks: { request: (_name: string, options: { signal: AbortSignal }, action: () => Promise<unknown>) => {
      const task = chain.then(() => { options.signal.throwIfAborted(); return action(); });
      chain = task.then(() => undefined, () => undefined); return task;
    } } });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('uses defaults for missing, incompatible, malformed and invalid stored records', async () => {
    expect(await readNotificationCopy()).toEqual(DEFAULT_NOTIFICATION_COPY);
    for (const raw of ['{', '{}', '{"v":2,"title":"x","body":"y"}', JSON.stringify({ v: 1, title: 'x'.repeat(25), body: 'y' })]) {
      records.set(NOTIFICATION_COPY_URL, new Response(raw));
      expect(await readNotificationCopy()).toEqual(DEFAULT_NOTIFICATION_COPY);
    }
    expect(normalizeNotificationCopy({ title: '  ', body: '\n' })).toEqual(DEFAULT_NOTIFICATION_COPY);
  });
  it('counts composed emoji as one character and rejects overflow and control characters', () => {
    const emoji = '👨‍👩‍👧‍👦';
    expect(notificationCopyLength(emoji + 'e\u0301')).toBe(2);
    expect(normalizeNotificationCopy({ title: emoji.repeat(24), body: '好'.repeat(80) }).title).toBe(emoji.repeat(24));
    expect(() => normalizeNotificationCopy({ title: emoji.repeat(25), body: '' })).toThrow('24');
    expect(() => normalizeNotificationCopy({ title: '', body: 'x\u0000y' })).toThrow('不可显示');
  });
  it('persists one complete record while the notification gate is off, without enabling it', async () => {
    records.set(NOTIFICATION_POLICY_URL, new Response('off'));
    await saveNotificationCopy({ title: ' 提醒 ', body: ' 打开查看 ' }, new AbortController().signal);
    expect(await readNotificationCopy()).toEqual({ v: 1, title: '提醒', body: '打开查看' });
    expect(await records.get(NOTIFICATION_POLICY_URL)!.text()).toBe('off');
    expect(put).toHaveBeenCalledTimes(1);
  });
  it('retains the previous record on storage failure and refuses unsupported or aborted writers', async () => {
    await saveNotificationCopy({ title: '旧标题', body: '旧正文' }, new AbortController().signal);
    put.mockRejectedValueOnce(new Error('quota'));
    await expect(saveNotificationCopy({ title: '新标题', body: '新正文' }, new AbortController().signal)).rejects.toThrow('quota');
    expect((await readNotificationCopy()).title).toBe('旧标题');
    const abort = new AbortController(); abort.abort();
    await expect(saveNotificationCopy({ title: '', body: '' }, abort.signal)).rejects.toThrow();
    vi.stubGlobal('navigator', {});
    await expect(saveNotificationCopy({ title: '', body: '' }, new AbortController().signal)).rejects.toThrow('安全保存');
    expect(put).toHaveBeenCalledTimes(2);
  });
  it('serializes two editors so the worker never reads a mixed title/body pair', async () => {
    let release!: () => void;
    put.mockImplementationOnce(async (key: string, value: Response) => { await new Promise<void>(resolve => { release = resolve; }); records.set(key, value); });
    const first = saveNotificationCopy({ title: 'A', body: 'A' }, new AbortController().signal);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = saveNotificationCopy({ title: 'B', body: 'B' }, new AbortController().signal);
    expect(await readNotificationCopy()).toEqual(DEFAULT_NOTIFICATION_COPY);
    release(); await Promise.all([first, second]);
    expect(await readNotificationCopy()).toEqual({ v: 1, title: 'B', body: 'B' });
  });
});
