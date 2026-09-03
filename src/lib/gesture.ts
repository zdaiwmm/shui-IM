export const MIN_GESTURE_POINTS = 4;
export const RECOMMENDED_GESTURE_POINTS = 6;

function midpointBetween(from: number, to: number): number | null {
  const fromRow = Math.floor(from / 3);
  const fromColumn = from % 3;
  const toRow = Math.floor(to / 3);
  const toColumn = to % 3;
  const rowSum = fromRow + toRow;
  const columnSum = fromColumn + toColumn;
  if (rowSum % 2 !== 0 || columnSum % 2 !== 0) return null;
  const midpoint = (rowSum / 2) * 3 + columnSum / 2;
  return midpoint === from || midpoint === to ? null : midpoint;
}

export function normalizeGesturePath(points: number[]): number[] {
  const normalized: number[] = [];
  for (const point of points) {
    if (!Number.isInteger(point) || point < 0 || point > 8 || normalized.includes(point)) continue;
    const previous = normalized.at(-1);
    if (previous !== undefined) {
      const midpoint = midpointBetween(previous, point);
      if (midpoint !== null && !normalized.includes(midpoint)) normalized.push(midpoint);
    }
    normalized.push(point);
  }
  return normalized;
}

export function gestureSecret(points: number[]): string {
  const normalized = normalizeGesturePath(points);
  if (normalized.length < MIN_GESTURE_POINTS) throw new Error(`请至少连接 ${MIN_GESTURE_POINTS} 个点`);
  return `quiet-room-gesture-v1:${normalized.join('.')}`;
}

export class GesturePad {
  private readonly pad: HTMLElement;
  private readonly path: SVGPolylineElement;
  private readonly livePath: SVGLineElement;
  private readonly points: HTMLButtonElement[];
  private readonly controller = new AbortController();
  private pattern: number[] = [];
  private drawing = false;
  private pointerId: number | null = null;
  private pointerPosition: { x: number; y: number } | null = null;

  constructor(
    host: HTMLElement,
    private readonly onComplete: (pattern: number[]) => void,
    label = '绘制手势',
  ) {
    host.innerHTML = `
      <div class="gesture-pad" role="group" aria-label="${label}">
        <svg class="gesture-trace" viewBox="0 0 300 300" aria-hidden="true">
          <polyline></polyline>
          <line></line>
        </svg>
        ${Array.from({ length: 9 }, (_, index) => `
          <button type="button" class="gesture-point" data-point="${index}" aria-label="点 ${index + 1}"><span></span></button>
        `).join('')}
      </div>
      <div class="gesture-actions">
        <button type="button" data-gesture-clear>重新绘制</button>
        <button type="button" data-gesture-complete>完成手势</button>
      </div>
    `;
    this.pad = host.querySelector<HTMLElement>('.gesture-pad')!;
    this.path = host.querySelector<SVGPolylineElement>('polyline')!;
    this.livePath = host.querySelector<SVGLineElement>('line')!;
    this.points = [...host.querySelectorAll<HTMLButtonElement>('.gesture-point')];
    const signal = this.controller.signal;

    this.pad.addEventListener('pointerdown', (event) => this.handlePointerDown(event), { signal });
    this.pad.addEventListener('pointermove', (event) => this.handlePointerMove(event), { signal });
    this.pad.addEventListener('pointerup', (event) => this.handlePointerUp(event), { signal });
    this.pad.addEventListener('pointercancel', () => this.clear(), { signal });
    for (const point of this.points) {
      point.addEventListener('click', (event) => {
        if (event.detail !== 0) return;
        this.drawing = true;
        this.addPoint(Number(point.dataset.point));
      }, { signal });
    }
    host.querySelector('[data-gesture-clear]')?.addEventListener('click', () => this.clear(), { signal });
    host.querySelector('[data-gesture-complete]')?.addEventListener('click', () => this.finish(), { signal });
  }

  destroy(): void {
    this.controller.abort();
    this.clear();
  }

  clear(): void {
    this.pattern.fill(-1);
    this.pattern.length = 0;
    this.drawing = false;
    this.pointerId = null;
    this.pointerPosition = null;
    this.render();
  }

  private handlePointerDown(event: PointerEvent): void {
    if (!event.isPrimary || event.button > 0) return;
    event.preventDefault();
    this.clear();
    this.drawing = true;
    this.pointerId = event.pointerId;
    this.pad.setPointerCapture?.(event.pointerId);
    this.updatePointerPosition(event);
    this.addNearestPoint(event);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.drawing || event.pointerId !== this.pointerId) return;
    event.preventDefault();
    this.updatePointerPosition(event);
    this.addNearestPoint(event);
    this.render();
  }

  private handlePointerUp(event: PointerEvent): void {
    if (!this.drawing || event.pointerId !== this.pointerId) return;
    event.preventDefault();
    this.addNearestPoint(event);
    this.finish();
  }

  private updatePointerPosition(event: PointerEvent): void {
    const rect = this.pad.getBoundingClientRect();
    this.pointerPosition = {
      x: ((event.clientX - rect.left) / rect.width) * 300,
      y: ((event.clientY - rect.top) / rect.height) * 300,
    };
  }

  private addNearestPoint(event: PointerEvent): void {
    let nearest = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const point of this.points) {
      const rect = point.getBoundingClientRect();
      const distance = Math.hypot(event.clientX - (rect.left + rect.width / 2), event.clientY - (rect.top + rect.height / 2));
      if (distance < nearestDistance && distance <= Math.max(rect.width, rect.height) * 0.68) {
        nearest = Number(point.dataset.point);
        nearestDistance = distance;
      }
    }
    if (nearest >= 0) this.addPoint(nearest);
  }

  private addPoint(point: number): void {
    this.pattern = normalizeGesturePath([...this.pattern, point]);
    this.render();
  }

  private finish(): void {
    if (!this.drawing && this.pattern.length === 0) return;
    const completed = [...this.pattern];
    this.clear();
    this.onComplete(completed);
    completed.fill(-1);
  }

  private pointCenter(index: number): { x: number; y: number } {
    return {
      x: 50 + (index % 3) * 100,
      y: 50 + Math.floor(index / 3) * 100,
    };
  }

  private render(): void {
    const centers = this.pattern.map((point) => this.pointCenter(point));
    this.path.setAttribute('points', centers.map(({ x, y }) => `${x},${y}`).join(' '));
    this.points.forEach((point, index) => point.classList.toggle('is-active', this.pattern.includes(index)));
    const last = centers.at(-1);
    if (this.drawing && last && this.pointerPosition) {
      this.livePath.removeAttribute('visibility');
      this.livePath.setAttribute('x1', String(last.x));
      this.livePath.setAttribute('y1', String(last.y));
      this.livePath.setAttribute('x2', String(this.pointerPosition.x));
      this.livePath.setAttribute('y2', String(this.pointerPosition.y));
    } else {
      this.livePath.setAttribute('visibility', 'hidden');
    }
  }
}
