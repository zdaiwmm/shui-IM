type Presence = boolean | null;
type Point = readonly [number, number];

const leftWire: Point[] = [[0, 12], [15, 12], [23, 7], [31, 17], [39, 12], [40, 12]];
const rightWire: Point[] = leftWire.map(([x, y]) => [100 - x, y]);
const leftHeart = 'M0 -5 C-5 -11 -11 -7 -10 -1 C-9 3 -3 7 0 10 L-1 3 L1 0 L-1 -3 Z';
const rightHeart = 'M0 -5 C5 -11 11 -7 10 -1 C9 3 3 7 0 10 L-1 3 L1 0 L-1 -3 Z';

export const presenceCircuitMarkup = `<svg class="presence-circuit" viewBox="0 0 100 24" aria-hidden="true" focusable="false" data-phase="unknown">
  <g class="presence-wires" fill="none"><path d="M0 12 H15 L23 7 L31 17 L39 12 H40"/><path d="M100 12 H85 L77 7 L69 17 L61 12 H60"/></g>
  <g class="presence-electric" fill="none"><path data-arc="left"/><path data-arc="right"/></g>
  <g transform="translate(50 11)"><g class="presence-heart">
    <path class="presence-half" data-half="left" d="${leftHeart}" transform="translate(-2 0)"/>
    <path class="presence-half" data-half="right" d="${rightHeart}" transform="translate(2 0)"/>
    <path class="presence-whole" d="M0 -5 C-5 -11 -11 -7 -10 -1 C-9 3 -3 7 0 10 C3 7 9 3 10 -1 C11 -7 5 -11 0 -5 Z"/>
  </g></g>
</svg>`;

function along(path: Point[], progress: number): Point {
  const lengths = path.slice(1).map(([x, y], i) => Math.hypot(x - path[i]![0], y - path[i]![1]));
  let distance = Math.max(0, Math.min(1, progress)) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i]!) {
      const p = distance / lengths[i]!;
      const a = path[i]!, b = path[i + 1]!;
      return [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p];
    }
    distance -= lengths[i]!;
  }
  return path[path.length - 1]!;
}

export class PresenceCircuit {
  private self: Presence = null;
  private peer: Presence = null;
  private frame: number | null = null;
  private mode: 'connect' | 'send' | null = null;
  private started = 0;
  private queued = 0;
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly left: SVGElement;
  private readonly right: SVGElement;
  private readonly arcs: SVGElement[];

  constructor(private readonly element: SVGElement) {
    this.left = element.querySelector('[data-half="left"]')!;
    this.right = element.querySelector('[data-half="right"]')!;
    this.arcs = Array.from(element.querySelectorAll('[data-arc]'));
    this.motion.addEventListener('change', this.reset);
    document.addEventListener('visibilitychange', this.reset);
  }

  update(self: Presence, peer: Presence): void {
    if (self === this.self && peer === this.peer) return;
    this.self = self;
    this.peer = peer;
    this.reset();
    if (self === true && peer === true && !this.motion.matches && !document.hidden) {
      this.start('connect');
    }
  }

  sent(): void {
    if (this.self !== true || this.peer !== false || this.motion.matches || document.hidden) return;
    // Bound visual work during bursts; retries never call this entry point.
    if (this.mode === 'send') { this.queued = Math.min(2, this.queued + 1); return; }
    this.start('send');
  }

  destroy(): void {
    this.self = this.peer = null;
    this.reset();
    this.motion.removeEventListener('change', this.reset);
    document.removeEventListener('visibilitychange', this.reset);
  }

  private reset = (): void => {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.mode = null;
    this.queued = 0;
    this.arcs.forEach(arc => arc.removeAttribute('d'));
    this.left.setAttribute('transform', 'translate(-2 0)');
    this.right.setAttribute('transform', 'translate(2 0)');
    this.element.dataset.phase = document.hidden || this.self === null || this.peer === null ? 'unknown'
      : this.self && this.peer ? 'online' : 'offline';
  };

  private start(mode: 'connect' | 'send'): void {
    this.mode = mode;
    this.started = performance.now();
    if (mode === 'connect') this.element.dataset.phase = 'charging';
    this.frame = requestAnimationFrame(this.tick);
  }

  private arc(path: Point[], progress: number, time: number): string {
    const points: Point[] = [];
    for (let i = 0; i <= 12; i++) {
      const [x, y] = along(path, progress - .26 + i * .26 / 12);
      const jitter = i === 0 || i === 12 ? 0 : Math.sin(i * 17 + time * .07) * 1.4;
      points.push([x, y + jitter]);
    }
    let d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    for (const i of [4, 8]) {
      const [x, y] = points[i]!;
      const sign = Math.sin(time * .02 + i) > 0 ? 1 : -1;
      d += ` M${x} ${y} l1 ${sign * 2} l-2 ${sign * 1.5}`;
    }
    return d;
  }

  private tick = (now: number): void => {
    this.frame = null;
    if (!this.element.isConnected || document.hidden) { this.reset(); return; }
    const elapsed = now - this.started;
    if (elapsed < 1000) {
      this.arcs[0]!.setAttribute('d', this.arc(leftWire, elapsed / 1000, elapsed));
      if (this.mode === 'connect') this.arcs[1]!.setAttribute('d', this.arc(rightWire, elapsed / 1000, elapsed));
    } else if (this.mode === 'connect' && elapsed < 4200) {
      this.arcs.forEach(arc => arc.removeAttribute('d'));
      this.element.dataset.phase = 'fusing';
      const t = (elapsed - 1000) / 1000;
      let gap: number, shake: number, tilt: number, squeeze = 1;
      // Slow tension, accelerated attraction, then a damped collision/rebound.
      if (t < 1.8) {
        const p = t / 1.8;
        gap = 2 - .5 * p * p;
        shake = (.12 + .55 * p) * Math.sin(t * (24 + 8 * p));
        tilt = 7 * p + 3 * p * Math.sin(t * 27);
      } else if (t < 2.12) {
        const p = (t - 1.8) / .32;
        gap = 1.5 * (1 - p ** 3);
        shake = .45 * (1 - p) * Math.sin(t * 40);
        tilt = 7 * (1 - p);
      } else {
        const hit = t - 2.12;
        gap = 1.75 * Math.exp(-hit * 3.4) * Math.abs(Math.sin(hit * 12));
        shake = .48 * Math.exp(-hit * 3) * Math.sin(hit * 35);
        tilt = -10 * Math.exp(-hit * 3.5) * Math.sin(hit * 12);
        squeeze = 1 - .17 * Math.exp(-hit * 4) * Math.cos(hit * 14);
      }
      for (const [part, side] of [[this.left, -1], [this.right, 1]] as const) {
        part.setAttribute('transform', `translate(${side * Math.max(0, gap + shake)} ${side * shake * .9}) rotate(${side * tilt}) scale(${squeeze} ${2 - squeeze})`);
      }
    } else {
      const queued = this.queued;
      const send = this.mode === 'send';
      this.reset();
      if (send && queued > 0) { this.start('send'); this.queued = queued - 1; }
      return;
    }
    this.frame = requestAnimationFrame(this.tick);
  };
}
