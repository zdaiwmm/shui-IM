export const CHAT_LATEST_GAP = 64;

type BottomControlOptions = {
  button: HTMLButtonElement;
  list: HTMLElement;
  latest: () => HTMLElement | undefined;
  hasNewer: () => boolean;
  visibilityTop?: () => number;
  targetScrollTop: () => number;
  scrollTop?: () => number;
  scrollTo?: (top: number) => void;
  active: () => boolean;
  measure?: () => boolean;
  begin: () => void;
  prepare: (signal: AbortSignal) => Promise<boolean> | undefined;
  resized: () => void;
  complete: () => void;
};

export function mountChatBottomControl(options: BottomControlOptions) {
  const { button } = options;
  const scrollTop = options.scrollTop ?? (() => window.scrollY);
  const scrollTo = options.scrollTo ?? (top => window.scrollTo(0, top));
  const events = new AbortController();
  let frame: number | null = null;
  let resizeFrame: number | null = null;
  let request: AbortController | null = null;
  let destroyed = false;
  let lastGeometry = '';
  let lastMessage: HTMLElement | undefined;
  let visibleState = false;
  const setVisible = (visible: boolean) => {
    if (visible === visibleState) return;
    visibleState = visible;
    if (!visible && options.active() && document.activeElement === button) options.latest()?.focus({ preventScroll: true });
    button.classList.toggle('is-visible', visible);
    button.setAttribute('aria-hidden', String(!visible));
    button.tabIndex = visible ? 0 : -1;
  };
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    frame = null;
    resizeFrame = null;
    request?.abort(); request = null;
    delete button.dataset.scrolling;
    button.removeAttribute('aria-busy');
  };
  const update = (force = true) => {
    if (destroyed) return;
    // Keyboard viewport motion pauses passive geometry observation, but does
    // not disable a user's explicit return-to-latest click.
    if (options.measure && !options.measure()) return;
    const latest = options.latest();
    if (!options.active() || !latest?.isConnected || !button.isConnected) {
      cancel(); setVisible(false); observer.disconnect(); mutations.disconnect(); lastMessage = undefined; lastGeometry = ''; return;
    }
    const hasNewer = options.hasNewer();
    const geometry = `${scrollTop()}:${window.visualViewport?.height ?? innerHeight}:${window.visualViewport?.offsetTop ?? 0}:${hasNewer}`;
    if (!force && geometry === lastGeometry && latest === lastMessage) return;
    if (latest !== lastMessage) {
      observer.disconnect();
      observer.observe(latest);
      mutations.observe(options.list, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'hidden', 'class', 'data-image-state'] });
    }
    lastGeometry = geometry; lastMessage = latest;
    setVisible(hasNewer || latest.getBoundingClientRect().bottom > (options.visibilityTop?.() ?? button.getBoundingClientRect().top));
  };
  const scheduleResize = () => {
    if (destroyed || resizeFrame !== null) return;
    // Control measurements may update the list padding in the same observer
    // delivery. Align after that batch, never scroll/write back into it.
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      if (destroyed) return;
      if (options.measure && !options.measure()) return;
      if (options.active()) options.resized();
      update();
    });
  };
  const observer = new ResizeObserver(scheduleResize);
  // Observing the list's size feeds back into the control observer that sets
  // its padding. DOM changes and media load events cover earlier content
  // growth without adding a second geometry observer to that layout cycle.
  const mutations = new MutationObserver(records => {
    // Endpoint keyboard spacing is written on the list itself and the app
    // already performs the one settled alignment/update. Do not schedule a
    // duplicate geometry pass for that bookkeeping style mutation; child
    // insertion and message/media attribute changes still refresh normally.
    if (records.some(record => record.type !== 'attributes' || record.target !== options.list)) scheduleResize();
  });
  options.list.addEventListener('load', scheduleResize, { capture: true, signal: events.signal });
  options.list.addEventListener('error', scheduleResize, { capture: true, signal: events.signal });
  const scroll = async () => {
    if (destroyed || !options.active()) return;
    cancel(); options.begin();
    const current = new AbortController(); request = current;
    button.dataset.scrolling = 'true';
    const preparation = options.prepare(current.signal);
    if (preparation) {
      button.setAttribute('aria-busy', 'true');
      let ready = false;
      try { ready = await preparation; } catch { /* The app reports history read failures. */ }
      if (request !== current) return;
      button.removeAttribute('aria-busy');
      if (!ready || current.signal.aborted || !options.active()) { cancel(); update(); return; }
    }
    const start = scrollTop();
    // Freeze the destination for the animation. Re-reading the latest row and
    // composer's computed transform on every frame forces synchronous layout
    // during document scrolling and is especially expensive while Safari is
    // also compositing its keyboard. The completion callback performs one
    // final alignment in case media changed size while we travelled.
    const target = options.targetScrollTop();
    const distance = Math.abs(target - start);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || distance < 1) {
      scrollTo(target); request = null; delete button.dataset.scrolling; options.complete(); update(); return;
    }
    // Short travel remains deliberate; large distances cover more pixels per
    // second without stretching into a long animation.
    const duration = Math.min(760, Math.max(360, Math.sqrt(distance) * 18));
    const started = performance.now();
    const step = (now: number) => {
      frame = null;
      if (destroyed || !options.active() || !button.isConnected) { cancel(); update(); return; }
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      scrollTo(start + (target - start) * eased);
      if (progress < 1) frame = requestAnimationFrame(step);
      else { request = null; delete button.dataset.scrolling; options.complete(); update(); }
    };
    frame = requestAnimationFrame(step);
  };
  button.addEventListener('click', () => void scroll(), { signal: events.signal });
  window.addEventListener('wheel', cancel, { passive: true, signal: events.signal });
  window.addEventListener('pointerdown', event => { if (!button.contains(event.target as Node)) cancel(); }, { passive: true, signal: events.signal });
  window.addEventListener('touchstart', event => { if (!button.contains(event.target as Node)) cancel(); }, { passive: true, signal: events.signal });
  window.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Escape'].includes(event.key)) cancel();
  }, { signal: events.signal });
  return {
    update,
    cancel,
    get scrolling() { return request !== null; },
    destroy() { cancel(); events.abort(); observer.disconnect(); mutations.disconnect(); setVisible(false); destroyed = true; lastMessage = undefined; },
  };
}
