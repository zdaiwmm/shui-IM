import { IDLE_WARNING_MS } from './idle-lock';
import '../idle-lock.css';

/** One global, out-of-flow control, moved into the current modal's focus tree. */
export class IdleLockPrompt {
  readonly element = document.createElement('button');
  private fill: HTMLElement;
  private label: HTMLElement;
  private action: HTMLElement;
  constructor(private readonly root: HTMLElement, extend: () => void) {
    const button = this.element;
    button.type = 'button'; button.className = 'idle-lock-prompt'; button.hidden = true;
    button.innerHTML = '<span class="idle-lock-capsule"><i class="idle-lock-fill" aria-hidden="true"></i><span class="idle-lock-label">即将锁定</span><span class="idle-lock-extend" aria-hidden="true">延期</span></span>';
    this.fill = button.querySelector('i')!;
    this.label = button.querySelector('.idle-lock-label')!;
    this.action = button.querySelector('.idle-lock-extend')!;
    button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (button.getAttribute('aria-disabled') !== 'true') extend(); });
    button.setAttribute('aria-label', '即将锁定，延期使用');
  }
  hide(): void { this.element.hidden = true; this.element.remove(); }
  update(remaining: number, renewable: boolean): void {
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > IDLE_WARNING_MS) { this.hide(); return; }
    const modal = [...document.querySelectorAll<HTMLElement>('.dialog-surface, [aria-modal="true"]')]
      .filter(node => node.isConnected && !node.inert && !node.hidden && !node.classList.contains('is-closing') && node.getClientRects().length).at(-1);
    const owner = modal ?? this.root;
    if (this.element.parentElement !== owner) owner.append(this.element);
    this.element.inert = false;
    this.element.hidden = false;
    this.element.setAttribute('aria-disabled', String(!renewable));
    this.element.tabIndex = renewable ? 0 : -1;
    this.element.setAttribute('aria-label', renewable ? '即将锁定，延期使用' : '恢复码即将锁定，需重新验证');
    this.label.textContent = renewable ? '即将锁定' : '恢复码即将锁定，需重新验证';
    this.action.hidden = !renewable;
    this.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, remaining / IDLE_WARNING_MS))})`;
    this.position(modal);
  }
  private position(modal?: HTMLElement): void {
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const composer = modal ? null : this.root.querySelector<HTMLElement>('#composer');
    const anchor = composer?.getBoundingClientRect();
    let bottom = top + height - 12;
    if (anchor && anchor.top > top && anchor.top < bottom) bottom = anchor.top - 6;
    if (modal) {
      const controls = modal.querySelector<HTMLElement>('.dialog-actions, .welcome-actions, .modal-actions, footer');
      const bounds = controls?.getBoundingClientRect();
      if (bounds && bounds.top > top + 64 && bounds.top < bottom) bottom = bounds.top - 6;
    }
    let x = left + width / 2, y = Math.max(top + 8, bottom - 44);
    if (bottom - top < 100) y = top + 8;
    // A transformed modal establishes the fixed-position containing block.
    let containing: HTMLElement | null = this.element.parentElement;
    while (containing) {
      const style = getComputedStyle(containing);
      if (style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none' || style.contain.includes('paint')) {
        const rect = containing.getBoundingClientRect();
        x -= rect.left + containing.clientLeft; y -= rect.top + containing.clientTop; break;
      }
      containing = containing.parentElement;
    }
    this.element.style.left = `${x}px`; this.element.style.top = `${y}px`;
  }
}
