import { cancelComposerPanel } from './composer-panel-motion';
import { chatKeyboardLayoutProgress } from './chat-keyboard-layout';
import { reducedMotion } from './motion';

type Options = {
  row: HTMLElement; shell: HTMLElement; list: HTMLElement; signal: AbortSignal;
  from: number; closedHeight: number; panelFrom?: number;
  target: (baseRowTop: number, elapsed: number) => number | null;
  panel: () => HTMLElement | null;
  reference: HTMLElement | null; follow: boolean; gap: number;
  referenceTop?: number;
  holdReference: () => boolean; beforeComplete: () => void; release: () => void;
  active: () => boolean; settled: () => boolean; complete: () => void;
};

/** One screen-coordinate owner while native viewport and panel occupancy exchange.
 * Layout stays with the existing viewport controller. Compensating translations
 * prevent its parent motion from being added to an independent child animation. */
export function coordinateComposerHandoff(options: Options) {
  const { row, shell, list, signal } = options;
  const rowStyle = row.style.translate, listStyle = list.style.translate;
  const referenceTop = options.referenceTop ?? options.reference?.getBoundingClientRect().top;
  const underlay = document.createElement('div');
  underlay.className = 'chat-panel-underlay'; underlay.setAttribute('aria-hidden', 'true');
  underlay.style.height = `${options.closedHeight}px`; shell.append(underlay);
  cancelComposerPanel(row);
  let frame = 0, live = true, offset = 0, listOffset = 0, panelOffset = 0;
  let ownedPanel: HTMLElement | null = null, panelStyle = '';
  let desired = options.from, from = desired, goal: number | null = null;
  const started = performance.now(); let retargeted = started, sampled = started;
  const cancel = (complete = false, preservePanel = false) => {
    if (!live) return;
    live = false; cancelAnimationFrame(frame);
    signal.removeEventListener('abort', abort);
    if (complete) options.beforeComplete();
    row.style.translate = rowStyle; list.style.translate = listStyle;
    if (ownedPanel) {
      const top = ownedPanel.getBoundingClientRect().top;
      ownedPanel.style.translate = panelStyle;
      if (preservePanel) ownedPanel.style.translate = `0 ${top - ownedPanel.getBoundingClientRect().top}px`;
    }
    underlay.remove();
    options.release();
    if (complete) options.complete();
  };
  const abort = () => cancel();
  const update = (now = performance.now()) => {
    if (!live) return;
    now = sampled = Math.max(sampled, now);
    if (signal.aborted || !row.isConnected || !options.active()) { cancel(); return; }
    const baseTop = row.getBoundingClientRect().top - offset;
    const target = options.target(baseTop, Math.max(0, now - started));
    if (target !== null && (goal === null || Math.abs(target - goal) > .5)) {
      from = desired; goal = target; retargeted = now;
    }
    const progress = reducedMotion() ? 1 : chatKeyboardLayoutProgress(now - retargeted);
    if (goal !== null) desired = from + (goal - from) * progress;
    offset += desired - row.getBoundingClientRect().top;
    row.style.translate = `0 ${offset}px`;
    const panel = options.panel();
    if (panel && panel !== ownedPanel) {
      ownedPanel = panel; panelStyle = panel.style.translate; panelOffset = 0;
      cancelComposerPanel(panel);
    }
    if (panel) {
      const finalTop = desired + row.offsetHeight + 8;
      const source = options.panelFrom ?? options.closedHeight;
      const panelTop = source + (finalTop - source) * progress;
      panelOffset += panelTop - panel.getBoundingClientRect().top;
      panel.style.translate = `0 ${panelOffset}px`;
    }
    const reference = options.reference;
    if (reference?.isConnected && options.holdReference()) {
      const bounds = reference.getBoundingClientRect();
      const targetEdge = options.follow ? desired - options.gap : referenceTop!;
      const edge = options.follow ? bounds.bottom + (parseFloat(getComputedStyle(reference).marginBottom) || 0) : bounds.top;
      listOffset += targetEdge - edge;
      list.style.translate = `0 ${listOffset}px`;
    }
    underlay.style.transform = `translateY(${desired + row.offsetHeight - shell.getBoundingClientRect().top}px)`;
    if ((goal !== null && progress === 1 && options.settled()) || now - started >= 1800) cancel(true);
  };
  const tick = (now: number) => { update(now); if (live) frame = requestAnimationFrame(tick); };
  signal.addEventListener('abort', abort, { once: true });
  // First paint is the captured source, never a later same-frame timestamp.
  update(started); if (live) frame = requestAnimationFrame(tick);
  return { update, cancel };
}
