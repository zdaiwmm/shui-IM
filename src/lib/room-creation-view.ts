import { chamberBrand } from './entry-art';
import { mountDialog } from './dialog';

/** Visual completion and actual creation are separate gates. No timer asserts success. */
export function mountRoomCreation(root: HTMLElement, signal: AbortSignal) {
  const sheet = document.createElement('section');
  sheet.className = 'confirm-overlay room-creation-overlay';
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', '正在创建密室');
  sheet.innerHTML = `<div class="confirm-dialog room-creation-dialog">${chamberBrand()}<h2>正在创建密室</h2><p role="status">正在准备私密空间</p><ol><li data-step="keys">准备本机密钥</li><li data-step="save">加密保存密室</li><li data-step="connect">建立安全连接</li></ol><div class="creation-track" aria-hidden="true"><span></span></div></div>`;
  root.append(sheet);
  const dialog = mountDialog(sheet, { signal, isActive: () => !signal.aborted, beforeClose: () => false });
  const text = sheet.querySelector('p')!;
  const finished = new Promise<void>(resolve => {
    const timer = window.setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1600);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  return {
    finished,
    step(step: 'keys' | 'save' | 'connect', message: string) {
      if (signal.aborted || !sheet.isConnected) return;
      text.textContent = message;
      const order = ['keys', 'save', 'connect'];
      for (const row of sheet.querySelectorAll<HTMLElement>('[data-step]')) row.dataset.state = order.indexOf(row.dataset.step!) < order.indexOf(step) ? 'done' : row.dataset.step === step ? 'active' : 'waiting';
    },
    dispose: () => dialog.dispose(),
  };
}
