/** Presentation-only motion. Business operations never await these helpers. */
export const motion = {
  feedback: 100, local: 180, message: 180, panel: 240, page: 180, media: 280, menuOut: 140,
  out: 'cubic-bezier(.22,1,.36,1)',
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
      if (property === 'transform' || property === 'translate' || property === 'opacity' || property === 'scale') {
        from[property] = style.getPropertyValue(property);
      }
    }
  }
  previous?.cancel();
  if (reducedMotion() || document.hidden || !element.isConnected) return null;
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
  let state = { position: from, velocity: Math.max(-2000, Math.min(2000, velocity)) };
  const tick = (now: number) => {
    if (cancelled || !active()) return;
    if (reducedMotion() || document.hidden || now - started > 600
      || (Math.abs(state.position) < .15 && Math.abs(state.velocity) < 3)) {
      paint(0); finish(); return;
    }
    state = dampedStep(state.position, state.velocity, 0, Math.min(.064, (now - previous) / 1000), 32);
    previous = now;
    // A return-to-rest must not overshoot through the opposite gesture edge.
    state.position = Math.max(0, state.position);
    paint(state.position);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(frame); };
}

/** Keep one layout transaction in phase; short/repeated travel settles sooner. */
export function layoutMotionDuration(distance: number, continuing = false): number {
  const travel = Math.min(1, Math.abs(distance) / 240);
  return Math.round(Math.max(180, 220 + 100 * Math.sqrt(travel) - (continuing ? 40 : 0)));
}

/** Recent release velocity is in CSS pixels/second; reversing always cancels. */
export function dismissDraggedPanel(offset: number, velocity: number, height: number): boolean {
  if (velocity < -120) return false;
  return offset >= Math.min(120, Math.max(45, height * .18))
    || (offset >= 14 && velocity > 450);
}

const travelEffects = new WeakMap<HTMLElement, { animation: Animation; positions: number[]; duration: number }>();

/** Sample the velocity of our own linear keyframe path before replacing its DOM. */
export function travelVelocity(element: HTMLElement | null): number {
  const effect = element && travelEffects.get(element);
  if (!effect || effect.animation.playState === 'finished' || effect.animation.playState === 'idle') return 0;
  const time = Number(effect.animation.currentTime ?? 0);
  const index = Math.min(effect.positions.length - 2, Math.max(0, Math.floor(time / effect.duration * (effect.positions.length - 1))));
  return (effect.positions[index + 1]! - effect.positions[index]!) * (effect.positions.length - 1) * 1000 / effect.duration;
}

/** Bounded Hermite travel preserves the sampled start velocity and stops at rest. */
export function travelFrames(from: number, to: number, velocity: number, duration: number): number[] {
  const tangent = velocity * duration / 1000;
  return Array.from({ length: 61 }, (_, index) => {
    const t = index / 60;
    return (2*t*t*t - 3*t*t + 1)*from + (t*t*t - 2*t*t + t)*tangent + (-2*t*t*t + 3*t*t)*to;
  });
}

export function travelMotion(element: HTMLElement, from: number, to: number, velocity: number,
  duration: number, opacityFrom = 1, opacityTo = 1): Animation | null {
  if (reducedMotion() || document.hidden || !element.isConnected) return null;
  const positions = travelFrames(from, to, velocity, duration);
  const animation = element.animate(positions.map((x, index) => ({
    transform: `translate3d(${x}px,0,0)`, opacity: opacityFrom + (opacityTo - opacityFrom) * index / 60,
  })), { duration, easing: 'linear', fill: 'backwards' });
  animation.currentTime = 0;
  travelEffects.set(element, { animation, positions, duration });
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const finish = () => { if (preference.matches || document.hidden) animation.finish(); };
  preference.addEventListener('change', finish);
  document.addEventListener('visibilitychange', finish);
  const release = () => {
    preference.removeEventListener('change', finish); document.removeEventListener('visibilitychange', finish);
    if (travelEffects.get(element)?.animation === animation) travelEffects.delete(element);
  };
  void animation.finished.then(release, release);
  return animation;
}
