import { dampedStep, reducedMotion, travelFrames } from './motion';
import { CHAT_KEYBOARD_LAYOUT_MS } from './chat-keyboard-layout';

type Effect = { animation: Animation; positions: number[]; duration: number };
const effects = new WeakMap<HTMLElement, Effect>();
export function cancelComposerPanel(element: HTMLElement) { effects.get(element)?.animation.cancel(); }

export function panelVelocity(element: HTMLElement): number {
  const effect = effects.get(element);
  if (!effect || !['running', 'paused'].includes(effect.animation.playState)) return 0;
  const index = Math.min(effect.positions.length - 2, Math.max(0,
    Math.floor(Number(effect.animation.currentTime ?? 0) / effect.duration * (effect.positions.length - 1))));
  return (effect.positions[index + 1]! - effect.positions[index]!) * (effect.positions.length - 1) * 1000 / effect.duration;
}

/** Commit geometry before calling; only this bounded transform owns presentation. */
export function moveComposerPanel(element: HTMLElement, from: number, to: number, signal: AbortSignal,
  finish: () => void = () => {}, keyboard = true, velocity = panelVelocity(element)): Animation | undefined {
  effects.get(element)?.animation.cancel();
  if (signal.aborted || !element.isConnected) return;
  if (reducedMotion() || document.hidden) { finish(); return; }
  const duration = keyboard ? CHAT_KEYBOARD_LAYOUT_MS : 240;
  const positions = keyboard ? Array.from({ length: 61 }, (_, index) => index === 60 ? to
    : to + dampedStep(from - to, velocity, 0, index / 60 * duration / 1000, 25).position)
    : travelFrames(from, to, velocity, duration);
  const animation = element.animate(positions.map((position, index) => ({
    offset: index / 60, transform: `translateY(${position}px)`,
  })), { duration, easing: 'linear', fill: 'both' });
  const effect = { animation, positions, duration }; effects.set(element, effect);
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const stop = () => animation.cancel();
  const settle = () => { if (preference.matches || document.hidden) animation.finish(); };
  preference.addEventListener('change', settle); document.addEventListener('visibilitychange', settle);
  signal.addEventListener('abort', stop, { once: true });
  void animation.finished.then(() => {
    if (effects.get(element) === effect && !signal.aborted) finish();
  }, () => {}).finally(() => {
    preference.removeEventListener('change', settle); document.removeEventListener('visibilitychange', settle);
    signal.removeEventListener('abort', stop);
    if (effects.get(element) === effect) effects.delete(element);
    animation.cancel();
  });
  return animation;
}

type ToolEffect = { row?: Animation; panel?: Animation; closing: boolean; cleanup?: () => void };
const tools = new WeakMap<HTMLElement, ToolEffect>();
const pinnedProperties = ['position', 'inset', 'width', 'height', 'margin'];
const unpin = (panel: HTMLElement) => pinnedProperties.forEach(property => panel.style.removeProperty(property));

export function chatToolsClosing(panel: HTMLElement) { return tools.get(panel)?.closing ?? false; }

export function showChatTools(panel: HTMLElement, open: boolean, signal: AbortSignal,
  animate = true, previousRowTop?: number, layoutChanged: () => void = () => {}, keyboard = false): void {
  const previous = tools.get(panel), row = panel.parentElement?.querySelector<HTMLElement>('.composer-row');
  if (!open && panel.hidden) return;
  if (!open && previous?.closing && animate) return;
  const panelTop = !panel.hidden ? panel.getBoundingClientRect().top : undefined;
  const rowTop = previousRowTop ?? row?.getBoundingClientRect().top;
  const rowSpeed = row ? panelVelocity(row) : 0, panelSpeed = panelVelocity(panel);
  previous?.cleanup?.();
  previous?.row?.cancel(); previous?.panel?.cancel();
  if (row) cancelComposerPanel(row);
  cancelComposerPanel(panel);
  unpin(panel);
  panel.inert = !open;
  if (open) panel.removeAttribute('aria-hidden'); else panel.setAttribute('aria-hidden', 'true');
  if (!animate || signal.aborted) { panel.hidden = signal.aborted || !open; tools.delete(panel); layoutChanged(); return; }
  panel.hidden = false;
  if (!open && getComputedStyle(panel).position !== 'absolute') {
    const box = panel.getBoundingClientRect();
    panel.style.width = `${box.width}px`; panel.style.height = `${box.height}px`;
    panel.style.position = 'absolute'; panel.style.inset = 'auto 0 0'; panel.style.margin = '0';
  }
  layoutChanged();
  const effect: ToolEffect = { closing: !open }; tools.set(panel, effect);
  const abort = () => {
    if (tools.get(panel) !== effect) return;
    effect.row?.cancel(); effect.panel?.cancel(); panel.hidden = true; panel.inert = true;
    panel.setAttribute('aria-hidden', 'true'); unpin(panel); tools.delete(panel);
  };
  signal.addEventListener('abort', abort, { once: true });
  effect.cleanup = () => signal.removeEventListener('abort', abort);
  const finish = () => {
    if (tools.get(panel) !== effect) return;
    panel.hidden = !open;
    effect.cleanup?.(); unpin(panel);
    tools.delete(panel);
  };
  if (row && rowTop !== undefined) effect.row = moveComposerPanel(row,
    rowTop - row.getBoundingClientRect().top, 0, signal, () => {}, keyboard, rowSpeed);
  const box = panel.getBoundingClientRect();
  const from = panelTop !== undefined ? panelTop - box.top : rowTop !== undefined && row
    ? rowTop + row.getBoundingClientRect().height + 8 - box.top : box.height;
  const viewport = panel.ownerDocument.defaultView;
  const to = open ? 0 : Math.max(box.height, (viewport?.innerHeight ?? box.bottom) - box.top);
  effect.panel = moveComposerPanel(panel, from, to, signal, finish, keyboard, panelSpeed);
  if (!effect.panel) finish();
}
