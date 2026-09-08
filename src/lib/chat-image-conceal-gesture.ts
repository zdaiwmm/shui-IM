type Point = { x: number; y: number };
type Pull = {
  id: number;
  source: 'pointer' | 'touch';
  origin: Point;
  latest: Point;
  target: HTMLElement | null;
  intent: 'undecided' | 'pull' | 'native';
  displaced: number;
  moved: boolean;
};

/** Move only the picked media bubble; message/anchor geometry stays unchanged. */
export function bindChatImageConcealGesture(options: {
  list: HTMLElement;
  active: () => boolean;
  canStart: () => boolean;
  conceal: () => void;
  moving: () => void;
  suppressClick: () => void;
}): { reset: () => void; destroy: () => void } {
  const { list } = options;
  const events = new AbortController();
  let pull: Pull | null = null;
  let touchActive = false;
  let settling: { target: HTMLElement; animation: Animation } | null = null;
  const clearTarget = (target: HTMLElement | null) => {
    target?.classList.remove('is-media-pulling', 'is-media-returning');
    target?.style.removeProperty('--media-pull-offset');
  };
  const reset = () => {
    clearTarget(pull?.target ?? null);
    pull = null;
    touchActive = false;
    if (settling) {
      settling.animation.cancel();
      clearTarget(settling.target);
      settling = null;
    }
  };
  const start = (id: number, source: Pull['source'], point: Point, origin: EventTarget | null) => {
    reset();
    touchActive = source === 'touch';
    if (!options.active() || !options.canStart()) return;
    const preview = origin instanceof Element ? origin.closest<HTMLElement>('.image-preview[data-revealed="true"]') : null;
    pull = {
      id, source, origin: point, latest: point,
      target: preview?.closest<HTMLElement>('.message-bubble') ?? null,
      intent: 'undecided', displaced: 0, moved: false,
    };
  };
  const move = (point: Point, event: Event) => {
    const current = pull;
    if (!current) return;
    if (!options.active() || !options.canStart()) { reset(); return; }
    current.latest = point;
    const dx = point.x - current.origin.x;
    const dy = point.y - current.origin.y;
    if (Math.hypot(dx, dy) >= 6) {
      current.moved = true;
      options.moving();
      options.suppressClick();
      if (current.intent === 'undecided') current.intent = current.target && dy > Math.abs(dx) ? 'pull' : 'native';
    }
    if (current.source === 'touch' && event.type === 'touchmove' && !event.cancelable) current.intent = 'native';
    if (current.intent !== 'pull') return;
    // Reserve downward media pulls before native scrolling begins. Upward and
    // horizontal gestures keep their normal document scrolling behavior.
    if (event.cancelable) event.preventDefault();
    current.displaced = 76 * Math.log1p(Math.max(0, dy) / 100);
    current.target!.classList.add('is-media-pulling');
    current.target!.style.setProperty('--media-pull-offset', `${current.displaced}px`);
  };
  const finish = (cancelled: boolean) => {
    const ended = pull;
    if (!ended) { reset(); return; }
    pull = null;
    touchActive = false;
    if (ended.moved || cancelled) options.suppressClick();
    const dx = ended.latest.x - ended.origin.x;
    const dy = ended.latest.y - ended.origin.y;
    // Only an owned, completed media pull hides previews. Native scrolling and
    // pointer cancellation carry no conceal intent; privacy teardown is separate.
    if (!cancelled && ended.intent === 'pull' && dy >= 24 && dy > Math.abs(dx)) options.conceal();
    clearTarget(ended.target);
    if (cancelled || !options.active() || !ended.target?.isConnected || ended.displaced < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = ended.target;
    target.classList.add('is-media-returning');
    const animation = target.animate(
      [{ transform: `translate3d(0, ${ended.displaced}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 240, easing: 'cubic-bezier(.2, .72, .2, 1)' },
    );
    settling = { target, animation };
    const release = () => {
      if (settling?.animation !== animation) return;
      clearTarget(target);
      settling = null;
    };
    void animation.finished.then(release, release);
  };
  list.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary && event.pointerType !== '') return;
    // Touchstart takes over in browsers. Keeping a pointer path also supports
    // pen/mouse input and engines that expose pointer events without Touch.
    start(event.pointerId, 'pointer', { x: event.clientX, y: event.clientY }, event.target);
  }, { passive: true, signal: events.signal });
  window.addEventListener('pointermove', event => {
    if (pull?.source === 'pointer' && pull.id === event.pointerId) move({ x: event.clientX, y: event.clientY }, event);
  }, { passive: false, signal: events.signal });
  window.addEventListener('pointerup', event => {
    if (pull?.source !== 'pointer' || pull.id !== event.pointerId) return;
    move({ x: event.clientX, y: event.clientY }, event);
    finish(false);
  }, { signal: events.signal });
  window.addEventListener('pointercancel', event => {
    if (touchActive) return;
    if (pull?.source === 'pointer' && pull.id === event.pointerId) finish(true);
  }, { signal: events.signal });
  list.addEventListener('touchstart', event => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (!touch) { finish(true); return; }
    start(touch.identifier, 'touch', { x: touch.clientX, y: touch.clientY }, event.target);
  }, { passive: true, signal: events.signal });
  list.addEventListener('touchmove', event => {
    if (pull?.source !== 'touch') return;
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (!touch || touch.identifier !== pull.id) { finish(true); return; }
    move({ x: touch.clientX, y: touch.clientY }, event);
  }, { passive: false, signal: events.signal });
  list.addEventListener('touchend', event => {
    if (pull?.source !== 'touch') { touchActive = false; return; }
    const touch = [...event.changedTouches].find(touch => touch.identifier === pull?.id);
    if (touch) move({ x: touch.clientX, y: touch.clientY }, event);
    finish(false);
  }, { signal: events.signal });
  list.addEventListener('touchcancel', () => finish(true), { signal: events.signal });
  return { reset, destroy: () => { reset(); events.abort(); } };
}
