import { readNotificationCopy } from './notification-copy';
import { DeviceNotifications, type NotificationSnapshot, type SpaceNotificationState } from './device-notifications';
import { spaceNotificationEnabled } from './notification-policy';
import { type NotificationCapability } from './push';
const copy: Record<NotificationCapability, [string, string]> = {
  available: ['本机支持通知', '开启后，系统会在有新消息时提醒你。'],
  'home-screen': ['添加到主屏幕后可用', '在 Safari 的分享菜单中选择“添加到主屏幕”，再从主屏幕打开 Quiet Room 并开启通知。'],
  unsupported: ['当前环境不支持通知', '请使用支持 Web Push 的浏览器，并通过安全连接打开 Quiet Room。'],
  blocked: ['系统已阻止通知', '请在浏览器或系统设置中允许 Quiet Room 使用通知，再回来开启。'],
  unavailable: ['通知服务暂不可用', '本机可以使用通知，服务暂时无法提供通知。请稍后重试。'],
  unknown: ['暂时无法确认', '请检查网络后重试。当前状态无法确认是否可以接收通知。'],
};
function errorCopy(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError' || error instanceof TypeError) return '通知设置暂未确认，请检查网络后重试';
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '系统未允许此操作，请确认通知权限或重新验证';
  return error instanceof Error ? error.message : '通知设置未保存，请重试';
}
const stateCopy: Record<SpaceNotificationState, string> = { on: '通知已开启', off: '通知已关闭', paused: '总开关已关闭，保留原有选择', unknown: '状态待确认，可重新开启总开关或稍后刷新', unavailable: '完成本机空间访问后即可设置' };
export function mountNotificationSettings(page: HTMLElement, manager: DeviceNotifications, options: {
  systemSurface: (operation: () => Promise<void>) => Promise<void>;
  openCopy?: () => void;
}): void {
  const signal = manager.signal;
  page.innerHTML = `<p class="notification-scope">本机所有空间</p><h2>通知管理</h2><p class="notification-lead">统一管理本机所有空间的新消息提醒。</p>
    <section class="notification-capability" aria-label="本机通知能力"><span>本机通知能力</span><strong id="notification-status" role="status">正在确认…</strong><p id="notification-explanation"></p><button class="notification-refresh" type="button">刷新状态</button></section>
    <section class="notification-controls" aria-label="通知总开关"><div class="notification-row"><div><strong id="notification-master-label">允许本机通知</strong><p>只影响当前浏览器或主屏幕应用。</p></div><button id="notification-master" class="notification-switch" role="switch" type="button" aria-checked="false" aria-labelledby="notification-master-label" disabled><span></span></button></div></section>
    <button id="notification-copy-entry" class="notification-copy-entry" type="button"><span><strong>通知文案</strong><span data-notification-copy-summary>标题与正文</span></span><span aria-hidden="true">›</span></button>
    <section class="notification-spaces" aria-labelledby="notification-spaces-heading"><div class="notification-section-heading"><h3 id="notification-spaces-heading">各空间通知</h3><span>共 ${manager.spaces.length} 个空间</span></div><p class="notification-space-help">总开关关闭时暂停全部通知，保留每个空间的选择。</p><div class="notification-space-list"></div></section>
    <p class="notification-feedback" role="status" aria-live="polite"></p><aside class="notification-privacy"><strong>只提醒新的聊天消息</strong><p>对方上线、已读与自动同步不提醒。不会自动加入空间名、发送者或聊天内容。点击后仍需解锁。</p><p>提醒可能受网络、系统专注模式及后台限制影响。</p></aside>`;
  const copyEntry = page.querySelector<HTMLButtonElement>('#notification-copy-entry')!;
  copyEntry.hidden = !options.openCopy;
  copyEntry.addEventListener('click', () => options.openCopy?.(), { signal });
  void readNotificationCopy().then(value => { if (!signal.aborted && page.isConnected) page.querySelector('[data-notification-copy-summary]')!.textContent = `${value.title} · ${value.body}`; }).catch(() => {});
  const master = page.querySelector<HTMLButtonElement>('#notification-master')!;
  const refresh = page.querySelector<HTMLButtonElement>('.notification-refresh')!;
  const feedback = page.querySelector<HTMLElement>('.notification-feedback')!;
  const list = page.querySelector<HTMLElement>('.notification-space-list')!;
  let snapshot: NotificationSnapshot | null = null, busy = false, revision = 0;
  const rows = manager.spaces.map((space, index) => {
    const row = document.createElement('div'); row.className = 'notification-row';
    const label = document.createElement('strong'); label.id = `notification-space-label-${index}`; label.textContent = space.name;
    const detail = document.createElement('p'); detail.textContent = '正在确认…';
    const text = document.createElement('div'); text.append(label, detail);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'notification-switch'; button.setAttribute('role', 'switch'); button.setAttribute('aria-checked', 'false'); button.setAttribute('aria-labelledby', label.id); button.dataset.notificationSpace = space.roomId; button.disabled = true; button.innerHTML = '<span></span>';
    row.append(text, button); list.append(row);
    button.addEventListener('click', () => void run(() => options.systemSurface(() => manager.setSpace(space.roomId, button.getAttribute('aria-checked') !== 'true'))), { signal });
    return { space, detail, button };
  });
  function paint() {
    master.disabled = busy || !snapshot || !snapshot.policy.enabled && snapshot.capability !== 'available';
    refresh.disabled = busy;
    master.setAttribute('aria-checked', String(snapshot?.policy.enabled ?? false));
    for (const { space, detail, button } of rows) {
      const state = snapshot?.spaces[space.roomId];
      detail.textContent = space.unavailable ?? (state ? stateCopy[state] : '正在确认…');
      // While paused, preserve the preference visually; during uncertainty do not claim delivery.
      button.setAttribute('aria-checked', String(snapshot ? state === 'on' || (state !== 'off' && spaceNotificationEnabled(snapshot.policy, space.roomId)) : false));
      button.disabled = busy || !snapshot?.policy.enabled || snapshot.capability !== 'available' || !!space.unavailable;
    }
    if (!snapshot) return;
    const [title, explanation] = copy[snapshot.capability];
    page.querySelector('#notification-status')!.textContent = title;
    page.querySelector('#notification-explanation')!.textContent = explanation;
  }
  async function load() {
    const request = ++revision;
    try {
      const value = await manager.snapshot();
      if (signal.aborted || !page.isConnected || request !== revision) return;
      snapshot = value; paint();
    } catch (error) { if (!signal.aborted && page.isConnected && request === revision) { page.querySelector('#notification-status')!.textContent = '暂时无法确认'; feedback.textContent = errorCopy(error); } }
  }
  async function run(operation: () => Promise<void>) {
    if (busy || signal.aborted) return;
    busy = true; feedback.textContent = '正在保存…'; paint();
    try { await operation(); if (!signal.aborted && page.isConnected) feedback.textContent = '通知设置已保存'; }
    catch (error) { if (!signal.aborted && page.isConnected) feedback.textContent = errorCopy(error); }
    finally { if (!signal.aborted && page.isConnected) { await load(); busy = false; paint(); } }
  }
  master.addEventListener('click', () => void run(() => options.systemSurface(() => manager.setMaster(!snapshot?.policy.enabled))), { signal });
  refresh.addEventListener('click', async () => {
    if (busy || signal.aborted) return;
    busy = true; feedback.textContent = ''; paint(); await load();
    if (!signal.aborted && page.isConnected) { busy = false; paint(); }
  }, { signal });
  window.addEventListener('storage', () => { if (!busy) void load(); }, { signal });
  window.addEventListener('focus', () => { if (!busy) void load(); }, { signal });
  window.addEventListener('online', () => { if (!busy) void load(); }, { signal });
  void load();
}
