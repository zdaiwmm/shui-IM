import type { Vault } from './types';
import { confirmedSpaceNotification, notificationCapability, notificationRegistration, registerSpaceNotification, subscribeBrowserNotifications, unregisterSpaceNotification, type NotificationCapability } from './push';
import { readNotificationPolicy, saveNotificationPolicy, setNotificationGate, spaceNotificationEnabled, withNotificationLock, type NotificationPolicy } from './notification-policy';
export type NotificationSpace = { roomId: string; name: string; unavailable?: string };
export type SpaceNotificationState = 'on' | 'off' | 'paused' | 'unknown' | 'unavailable';
export type NotificationSnapshot = { capability: NotificationCapability; policy: NotificationPolicy; spaces: Record<string, SpaceNotificationState> };
export type NotificationVaultAccess = <T>(roomId: string, verify: boolean, action: (vault: Vault) => Promise<T>) => Promise<T>;
function cancellablePermission(permission: Promise<NotificationPermission>, signal: AbortSignal): Promise<NotificationPermission> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    permission.then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
const initial = (): NotificationPolicy => ({ v: 1, enabled: false, spaces: {} });
export class DeviceNotifications {
  constructor(readonly spaces: NotificationSpace[], readonly access: NotificationVaultAccess, readonly signal: AbortSignal) {}
  private scopedPolicy(policy: NotificationPolicy): NotificationPolicy {
    const known = new Set(this.spaces.map(space => space.roomId));
    return { ...policy, spaces: Object.fromEntries(Object.entries(policy.spaces).filter(([id]) => known.has(id))) };
  }
  async snapshot(): Promise<NotificationSnapshot> {
    let capability = await notificationCapability(this.signal);
    let policy = readNotificationPolicy();
    let subscription: PushSubscription | null = null;
    if (capability === 'available' && Notification.permission === 'granted') {
      try { subscription = await (await notificationRegistration(this.signal)).pushManager.getSubscription(); }
      catch { this.signal.throwIfAborted(); capability = 'unknown'; }
    }
    this.signal.throwIfAborted();
    if (!policy) {
      // Preserve an already opted-in legacy browser; never request permission here.
      await withNotificationLock(this.signal, async () => {
        policy = readNotificationPolicy();
        if (!policy) { policy = { ...initial(), enabled: Boolean(subscription) }; await setNotificationGate(policy.enabled); this.signal.throwIfAborted(); saveNotificationPolicy(policy); }
      });
    }
    const result: NotificationSnapshot = { capability, policy: policy!, spaces: {} };
    for (const space of this.spaces) {
      this.signal.throwIfAborted();
      if (space.unavailable) { result.spaces[space.roomId] = 'unavailable'; continue; }
      if (!result.policy.enabled) { result.spaces[space.roomId] = 'paused'; continue; }
      if (capability !== 'available' || !subscription) { result.spaces[space.roomId] = 'unknown'; continue; }
      try {
        const enabled = await this.access(space.roomId, false, vault => confirmedSpaceNotification(vault, subscription.endpoint, this.signal));
        result.spaces[space.roomId] = enabled ? 'on' : 'off';
      } catch { this.signal.throwIfAborted(); result.spaces[space.roomId] = 'unknown'; }
    }
    return result;
  }
  /** Called directly from a settings click, before any await/lock consumes activation. */
  setMaster(enabled: boolean): Promise<void> {
    this.signal.throwIfAborted();
    const permission: Promise<NotificationPermission> = enabled && 'Notification' in window && Notification.permission === 'default'
      ? Notification.requestPermission() : Promise.resolve('Notification' in window ? Notification.permission : 'denied');
    // Observe immediately even if lock acquisition is cancelled by privacy shutdown.
    void permission.catch(() => undefined);
    return withNotificationLock(this.signal, async () => {
      const previous = this.scopedPolicy(readNotificationPolicy() ?? initial());
      if (!enabled) {
        await setNotificationGate(false);
        // Explicit opt-out remains durable even if privacy shutdown follows the gate write.
        // This only closes delivery; it cannot enable or touch a replacement vault.
        saveNotificationPolicy({ ...previous, enabled: false });
        this.signal.throwIfAborted();
        if ('serviceWorker' in navigator) {
          const registration = await notificationRegistration(this.signal);
          const subscription = await registration.pushManager.getSubscription();
          this.signal.throwIfAborted();
          // The persisted gate also suppresses already queued wakes after opt-out.
          if (subscription && !(await subscription.unsubscribe())) throw new Error('本机通知已关闭；系统订阅清理暂未完成');
          await Promise.all((await registration.getNotifications()).map(notification => notification.close()));
        }
        return;
      }
      const granted = await cancellablePermission(permission, this.signal);
      this.signal.throwIfAborted();
      if (granted !== 'granted') throw new Error(granted === 'denied' ? '系统已阻止通知，请在浏览器或系统设置中允许后重试' : '尚未允许通知，可再次开启时选择允许');
      const available = this.spaces.filter(space => !space.unavailable);
      if (!available.length) throw new Error('本机还没有可接收通知的空间');
      // Keep delivery closed until every selected space is server-confirmed.
      await setNotificationGate(false);
      let created: PushSubscription | undefined;
      try {
        const browser = await subscribeBrowserNotifications(this.signal);
        if (browser.created) created = browser.subscription;
        for (const space of available) {
          this.signal.throwIfAborted();
          await this.access(space.roomId, true, vault => spaceNotificationEnabled(previous, space.roomId)
            ? registerSpaceNotification(vault, browser.subscription, this.signal)
            : unregisterSpaceNotification(vault, browser.subscription.endpoint, this.signal));
        }
        this.signal.throwIfAborted();
        await setNotificationGate(true);
        this.signal.throwIfAborted();
        saveNotificationPolicy({ ...previous, enabled: true });
      } catch (error) {
        await setNotificationGate(false);
        saveNotificationPolicy({ ...previous, enabled: false });
        await created?.unsubscribe().catch(() => false);
        throw error;
      }
    });
  }
  setSpace(roomId: string, enabled: boolean): Promise<void> {
    return withNotificationLock(this.signal, async () => {
      const policy = this.scopedPolicy(readNotificationPolicy() ?? initial());
      const space = this.spaces.find(item => item.roomId === roomId);
      if (!policy.enabled || !space || space.unavailable) throw new Error('请先开启本机通知并完成空间访问');
      const subscription = await (await notificationRegistration(this.signal)).pushManager.getSubscription();
      if (!subscription) throw new Error('本机通知订阅已失效，请重新开启总开关');
      await this.access(roomId, true, vault => enabled ? registerSpaceNotification(vault, subscription, this.signal) : unregisterSpaceNotification(vault, subscription.endpoint, this.signal));
      this.signal.throwIfAborted();
      saveNotificationPolicy({ ...policy, spaces: { ...policy.spaces, [roomId]: enabled } });
    });
  }
}
/** Reconcile only an already unlocked space, with no permission or device prompt. */
export async function reconcileSpaceNotifications(vault: Vault, signal: AbortSignal): Promise<void> {
  await withNotificationLock(signal, async () => {
    const policy = readNotificationPolicy();
    if (!policy?.enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const subscription = await (await notificationRegistration(signal)).pushManager.getSubscription();
    if (!subscription) return;
    if (spaceNotificationEnabled(policy, vault.roomId)) await registerSpaceNotification(vault, subscription, signal);
    else await unregisterSpaceNotification(vault, subscription.endpoint, signal);
  });
}
