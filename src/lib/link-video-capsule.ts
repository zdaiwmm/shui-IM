import { latestPaint } from './latest-paint';

export type LinkVideoPhase = 'download' | 'prepare' | 'upload' | 'done' | 'failed';
export type LinkVideoProgress = { text: string; phase: LinkVideoPhase; ratio?: number };

export function mountLinkVideoCapsule(button: HTMLButtonElement) {
  const ring = document.createElement('span'); ring.className = 'link-task-ring';
  ring.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="link-task-track" cx="12" cy="12" r="9"/><circle class="link-task-progress" cx="12" cy="12" r="9"/></svg><i></i>';
  ring.setAttribute('role', 'progressbar'); ring.setAttribute('aria-valuemin', '0'); ring.setAttribute('aria-valuemax', '100');
  const label = document.createElement('strong'); label.className = 'link-task-label';
  const arrow = document.createElement('span'); arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
  button.append(ring, label, arrow);
  const view = latestPaint<LinkVideoProgress>(state => {
    label.textContent = state.text; button.setAttribute('aria-label', state.text);
    button.dataset.phase = state.phase;
    const determinate = state.ratio !== undefined && Number.isFinite(state.ratio) && ['download','upload'].includes(state.phase);
    button.dataset.determinate = String(determinate);
    const ratio = Math.max(0, Math.min(1, state.ratio ?? 0));
    ring.style.setProperty('--task-progress', String(ratio));
    button.style.setProperty('--task-fill', `${Math.round(ratio * 100)}%`);
    ring.setAttribute('aria-label', state.text);
    if (determinate) ring.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    else ring.removeAttribute('aria-valuenow');
    ring.querySelector('i')!.textContent = state.phase === 'done' ? '✓' : state.phase === 'failed' ? '!' : '↓';
  });
  return { update(state: LinkVideoProgress) { view.update(state, state.phase === 'failed' || state.phase === 'done'); }, dispose: () => view.dispose() };
}
