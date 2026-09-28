/** Presentation-only motion. Business operations never await these helpers. */
export const motion = {
  feedback: 180, local: 220, message: 300, panel: 320, page: 340, media: 320,
  out: 'cubic-bezier(.18,.88,.24,1)',
  settle: 'cubic-bezier(.2,.82,.22,1)',
  travel: 'cubic-bezier(.24,.72,.18,1)',
} as const;

export const reducedMotion = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Retarget a finite effect from its painted state, cancelling only its owner. */
export function retargetMotion(element: HTMLElement, previous: Animation | null | undefined,
  from: Keyframe, to: Keyframe, duration: number = motion.local, easing: string = motion.out): Animation | null {
  if (previous && previous.playState !== 'finished' && previous.playState !== 'idle') {
    const style = getComputedStyle(element);
    from = { ...from };
    for (const property of Object.keys(to)) {
      if (property === 'transform' || property === 'translate' || property === 'opacity') {
        from[property] = style.getPropertyValue(property);
      }
    }
  }
  previous?.cancel();
  if (reducedMotion() || !element.isConnected) return null;
  const animation = element.animate([from, to], { duration, easing, fill: 'backwards' });
  animation.currentTime = 0;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const finish = () => {
    if (!preference.matches && !document.hidden) return;
    try { animation.finish(); } catch { animation.cancel(); }
  };
  const release = () => {
    preference.removeEventListener('change', finish);
    document.removeEventListener('visibilitychange', finish);
  };
  preference.addEventListener('change', finish);
  document.addEventListener('visibilitychange', finish);
  void animation.finished.then(release, release);
  return animation;
}

/** Wait for finite CSS/WAAPI motion, with cancellation and a bounded fallback. */
export function afterMotion(element: HTMLElement, done: () => void, fallback = 450): () => void {
  let active = true;
  const finish = () => { if (!active) return; active = false; clearTimeout(timer); done(); };
  const timer = setTimeout(finish, fallback);
  const animations = element.getAnimations({ subtree: true }).filter(animation => {
    const timing = animation.effect?.getComputedTiming();
    return timing && Number.isFinite(Number(timing.endTime));
  });
  if (reducedMotion() || !animations.length) queueMicrotask(finish);
  else void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
  return () => { active = false; clearTimeout(timer); };
}

/** Exact critically damped step, in seconds. Shared by gesture settling/tests. */
export function dampedStep(position: number, velocity: number, target: number, seconds: number, frequency = 24) {
  seconds = Math.max(0, seconds);
  const displacement = position - target;
  const coefficient = velocity + frequency * displacement;
  const decay = Math.exp(-frequency * Math.max(0, seconds));
  return {
    position: target + (displacement + coefficient * seconds) * decay,
    velocity: (velocity - frequency * coefficient * seconds) * decay,
  };
}

/** No hidden-tab catch-up or stale callback survives a cancelled gesture. */
export function settleValue(from: number, velocity: number, paint: (value: number) => void,
  finish: () => void, active: () => boolean): () => void {
  let frame = 0;
  let cancelled = false;
  let previous = performance.now();
  const started = previous;
  let state = { position: from, velocity };
  const tick = (now: number) => {
    if (cancelled || !active()) return;
    if (reducedMotion() || document.hidden || now - started > 600
      || (Math.abs(state.position) < .15 && Math.abs(state.velocity) < 3)) {
      paint(0); finish(); return;
    }
    state = dampedStep(state.position, state.velocity, 0, Math.min(.064, (now - previous) / 1000));
    previous = now;
    // A return-to-rest must not overshoot through the opposite gesture edge.
    state.position = Math.max(0, state.position);
    paint(state.position);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}
