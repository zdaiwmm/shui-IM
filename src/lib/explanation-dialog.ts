import { mountDialog } from './dialog';

/** Long-lived help belongs in an on-demand dialog, never in an error toast. */
export function showExplanation(root: HTMLElement, title: string, paragraphs: string[],
  options: { signal?: AbortSignal; active: () => boolean; closeLabel?: string; action?: { label: string; danger?: boolean; closeBeforeRun?: boolean; run: () => Promise<void> }; error?: (cause: unknown) => void }) {
  const sheet = document.createElement('section');
  sheet.className = 'confirm-overlay';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', title);
  sheet.innerHTML = '<div class="confirm-dialog simple-confirm"><h2></h2><div data-copy></div><div class="simple-confirm-actions"><button class="primary-button" data-close type="button">知道了</button></div></div>';
  sheet.querySelector('h2')!.textContent = title;
  sheet.querySelector('[data-close]')!.textContent = options.closeLabel ?? '知道了';
  for (const text of paragraphs) {
    const p = document.createElement('p'); p.textContent = text; sheet.querySelector('[data-copy]')!.append(p);
  }
  root.append(sheet);
  let busy = false;
  const dialog = mountDialog(sheet, { signal: options.signal, isActive: options.active, beforeClose: () => !busy });
  sheet.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
  if (options.action) {
    const button = document.createElement('button'); button.className = 'text-button'; button.type = 'button';
    if (options.action.danger) button.classList.add('danger-text');
    button.textContent = options.action.label; button.dataset.helpAction = '';
    sheet.querySelector('.simple-confirm-actions')!.prepend(button);
    button.addEventListener('click', () => {
      if (busy || !options.active()) return;
      busy = true; button.disabled = true;
      if (options.action!.closeBeforeRun) dialog.close({ animate: false, restoreFocus: false });
      void options.action!.run().catch(options.error).finally(() => { busy = false; button.disabled = false; });
    });
  }
  return dialog;
}
