import { createElement, Smartphone } from 'lucide';

export function mountPortraitOrientation(root: HTMLElement): () => void {
  const controller = new AbortController();
  const signal = controller.signal;
  const guard = document.createElement('aside');
  guard.className = 'portrait-orientation-guard'; guard.hidden = true;
  guard.setAttribute('role', 'status');
  const label = document.createElement('p'); label.textContent = '请将设备转回竖屏';
  guard.append(createElement(Smartphone), label); document.body.append(guard);
  const orientation = screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> };
  const mobile = matchMedia('(pointer: coarse)');
  let blocked = false;
  let previousInert = false;
  const sync = () => {
    // Screen orientation is independent of the soft keyboard's viewport height.
    const angle = (window as Window & { orientation?: number }).orientation;
    const landscape = typeof angle === 'number' ? Math.abs(angle) === 90
      : screen.width > screen.height && (!orientation?.type || orientation.type.startsWith('landscape'));
    const next = mobile.matches && landscape;
    if (next === blocked) return;
    blocked = next; guard.hidden = !next;
    if (next) { previousInert = root.inert; root.inert = true; }
    else root.inert = previousInert;
    root.classList.toggle('portrait-blocked', next);
    root.dispatchEvent(new Event('portraitvisibilitychange'));
  };
  const lock = () => {
    if (!mobile.matches || document.hidden) return;
    try { void orientation?.lock?.('portrait').catch(() => undefined); } catch { /* Unsupported browser. */ }
  };
  orientation?.addEventListener('change', sync, { signal });
  window.addEventListener('orientationchange', sync, { signal });
  mobile.addEventListener('change', sync, { signal });
  document.addEventListener('fullscreenchange', lock, { signal });
  document.addEventListener('pointerup', lock, { signal, once: true, passive: true });
  sync(); lock();
  return () => { controller.abort(); guard.remove(); root.classList.remove('portrait-blocked'); if (blocked) root.inert = previousInert; };
}
