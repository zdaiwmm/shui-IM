import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceNotifications, reconcileSpaceNotifications } from '../src/lib/device-notifications';
import { readNotificationPolicy, saveNotificationPolicy, spaceNotificationEnabled } from '../src/lib/notification-policy';
import * as push from '../src/lib/push';
import type { Vault } from '../src/lib/types';
vi.mock('../src/lib/push', () => ({ notificationCapability: vi.fn(), notificationRegistration: vi.fn(), confirmedSpaceNotification: vi.fn(), registerSpaceNotification: vi.fn(), unregisterSpaceNotification: vi.fn(), subscribeBrowserNotifications: vi.fn() }));
const first = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', second = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const vault = (roomId: string) => ({ roomId } as Vault);
let gate: string, subscription: PushSubscription, abort: AbortController, prompts: number;
beforeEach(() => {
  vi.resetAllMocks();
  gate = ''; prompts = 0; abort = new AbortController();
  const storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const notification = { permission: 'granted', requestPermission: vi.fn(async () => { prompts++; return 'granted'; }) };
  vi.stubGlobal('Notification', notification); vi.stubGlobal('window', { Notification: notification });
  vi.stubGlobal('caches', { open: async () => ({ put: async (_key: string, value: Response) => { gate = await value.text(); } }) });
  let writer = Promise.resolve();
  vi.stubGlobal('navigator', { serviceWorker: {}, locks: { request: (_name: string, options: {signal: AbortSignal}, action: () => Promise<void>) => {
    const result = writer.then(() => { options.signal.throwIfAborted(); return action(); }); writer = result.catch(() => {}); return result;
  } } });
  subscription = { endpoint: 'https://push.example.test/shared', unsubscribe: vi.fn(async () => true) } as unknown as PushSubscription;
  vi.mocked(push.notificationCapability).mockResolvedValue('available');
  vi.mocked(push.notificationRegistration).mockResolvedValue({ pushManager: { getSubscription: async () => subscription }, getNotifications: async () => [] } as unknown as ServiceWorkerRegistration);
  vi.mocked(push.subscribeBrowserNotifications).mockResolvedValue({ subscription, created: false });
  vi.mocked(push.confirmedSpaceNotification).mockResolvedValue(true);
  saveNotificationPolicy({ v: 1, enabled: false, spaces: { [second]: false } });
});
afterEach(() => vi.unstubAllGlobals());
const manager = () => new DeviceNotifications([{ roomId: first, name: '空间一' }, { roomId: second, name: '空间二' }], async (id, _verify, action) => action(vault(id)), abort.signal);
describe('device-wide notification control', () => {
  it('enables selected spaces and removes opted-out rows before opening the delivery gate', async () => {
    vi.mocked(push.registerSpaceNotification).mockImplementation(async () => { expect(gate).toBe('off'); expect(readNotificationPolicy()?.enabled).toBe(false); });
    await manager().setMaster(true);
    expect(push.registerSpaceNotification).toHaveBeenCalledWith(vault(first), subscription, abort.signal);
    expect(push.unregisterSpaceNotification).toHaveBeenCalledWith(vault(second), subscription.endpoint, abort.signal);
    expect(gate).toBe('on'); expect(readNotificationPolicy()?.enabled).toBe(true); expect(prompts).toBe(0);
  });
  it('keeps the shared endpoint when one space is disabled', async () => {
    saveNotificationPolicy({ v: 1, enabled: true, spaces: {} });
    await manager().setSpace(first, false);
    expect(push.unregisterSpaceNotification).toHaveBeenCalledTimes(1);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
    expect(spaceNotificationEnabled(readNotificationPolicy()!, first)).toBe(false);
    expect(spaceNotificationEnabled(readNotificationPolicy()!, second)).toBe(true);
  });
  it('closes delivery and unsubscribes globally while preserving room selections, even offline', async () => {
    saveNotificationPolicy({ v: 1, enabled: true, spaces: { [second]: false } });
    await manager().setMaster(false);
    expect(gate).toBe('off'); expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(readNotificationPolicy()).toEqual({ v: 1, enabled: false, spaces: { [second]: false } });
    expect(push.registerSpaceNotification).not.toHaveBeenCalled();
  });
  it('does not claim enabled after a partial server failure or unsubscribe an existing shared endpoint', async () => {
    vi.mocked(push.unregisterSpaceNotification).mockRejectedValue(new Error('offline'));
    await expect(manager().setMaster(true)).rejects.toThrow('offline');
    expect(gate).toBe('off'); expect(readNotificationPolicy()?.enabled).toBe(false);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
  it('rolls back a newly created endpoint after cancelled/later server confirmation', async () => {
    vi.mocked(push.subscribeBrowserNotifications).mockResolvedValue({ subscription, created: true });
    vi.mocked(push.registerSpaceNotification).mockImplementation(async () => { abort.abort(); });
    await expect(manager().setMaster(true)).rejects.toThrow();
    expect(gate).toBe('off'); expect(readNotificationPolicy()?.enabled).toBe(false);
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(push.unregisterSpaceNotification).not.toHaveBeenCalled();
  });
  it('requests permission in the synchronous click stack and retains off after rejection', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'default', configurable: true });
    vi.mocked(Notification.requestPermission).mockResolvedValue('denied');
    const pending = manager().setMaster(true);
    expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toThrow('阻止');
    expect(push.subscribeBrowserNotifications).not.toHaveBeenCalled(); expect(readNotificationPolicy()?.enabled).toBe(false);
  });
  it('releases the cross-tab writer even when a cancelled native permission never settles', async () => {
    Object.defineProperty(Notification, 'permission', { value: 'default', configurable: true });
    vi.mocked(Notification.requestPermission).mockImplementation(() => new Promise(() => {}));
    const pending = manager().setMaster(true);
    await Promise.resolve(); await Promise.resolve(); abort.abort();
    await expect(pending).rejects.toThrow();
    abort = new AbortController(); await manager().setMaster(false);
    expect(readNotificationPolicy()?.enabled).toBe(false); expect(push.subscribeBrowserNotifications).not.toHaveBeenCalled();
  });
  it('reports unknown for unconfirmed rooms rather than inferring success from a browser subscription', async () => {
    saveNotificationPolicy({ v: 1, enabled: true, spaces: {} });
    vi.mocked(push.confirmedSpaceNotification).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('offline'));
    expect((await manager().snapshot()).spaces).toEqual({ [first]: 'off', [second]: 'unknown' });
  });
  it('leaves the master accessible for opt-out when the worker status cannot be confirmed', async () => {
    saveNotificationPolicy({ v: 1, enabled: true, spaces: {} });
    vi.mocked(push.notificationRegistration).mockRejectedValue(new Error('worker unavailable'));
    const value = await manager().snapshot();
    expect(value.capability).toBe('unknown'); expect(value.policy.enabled).toBe(true);
    expect(value.spaces).toEqual({ [first]: 'unknown', [second]: 'unknown' });
  });
  it('serializes competing tabs so a later master-off wins over pending registration', async () => {
    let release!: () => void;
    vi.mocked(push.registerSpaceNotification).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const on = manager().setMaster(true);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const off = manager().setMaster(false); release();
    await Promise.all([on, off]); expect(gate).toBe('off'); expect(readNotificationPolicy()?.enabled).toBe(false);
  });
  it('reconciles new/current spaces without asking for permission and respects master and per-space opt-out', async () => {
    await reconcileSpaceNotifications(vault(first), abort.signal);
    expect(push.registerSpaceNotification).not.toHaveBeenCalled();
    saveNotificationPolicy({ v: 1, enabled: true, spaces: { [first]: false } });
    await reconcileSpaceNotifications(vault(first), abort.signal);
    expect(push.unregisterSpaceNotification).toHaveBeenCalledWith(vault(first), subscription.endpoint, abort.signal);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });
});
