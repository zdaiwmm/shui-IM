import { describe, expect, it, vi } from 'vitest';
import {
  bindImageViewerGestures,
  type ImageViewerGestureBinding,
  type ImageViewerPageGesture,
} from '../src/lib/image-viewer-gestures';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

class FakeStyle {
  transform = '';
  touchAction = '';
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  removeProperty(name: string): string {
    const previous = this.properties.get(name) ?? '';
    this.properties.delete(name);
    return previous;
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? '';
  }
}

type AnimationCall = {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: FakeAnimation;
};

class FakeAnimation {
  readonly finished: Promise<void>;
  finishCount = 0;
  cancelCount = 0;
  private resolveFinished!: () => void;

  constructor() {
    this.finished = new Promise(resolve => { this.resolveFinished = resolve; });
  }

  finish(): void {
    this.finishCount += 1;
    this.resolveFinished();
  }

  cancel(): void {
    this.cancelCount += 1;
  }
}

class FakeMedia {
  readonly style = new FakeStyle();
  readonly animationCalls: AnimationCall[] = [];
  clientWidth = 390;
  clientHeight = 844;
  naturalWidth = 1200;
  naturalHeight = 800;
  offsetWidthReads = 0;

  constructor(readonly tagName: 'IMG' | 'VIDEO') {}

  get offsetWidth(): number {
    this.offsetWidthReads += 1;
    return this.clientWidth;
  }

  animate(keyframes: Keyframe[] | PropertyIndexedKeyframes, options?: number | KeyframeAnimationOptions): Animation {
    const animation = new FakeAnimation();
    this.animationCalls.push({
      keyframes: Array.isArray(keyframes) ? keyframes : [keyframes as Keyframe],
      options: typeof options === 'number' ? { duration: options } : options ?? {},
      animation,
    });
    return animation as unknown as Animation;
  }
}

type FakeListener = {
  listener: EventListenerOrEventListenerObject;
  signal?: AbortSignal;
};

class FakePointerRoot {
  private readonly listeners = new Map<string, FakeListener[]>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void {
    const signal = typeof options === 'object' ? options.signal : undefined;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, ...(signal ? { signal } : {}) });
    this.listeners.set(type, listeners);
  }

  dispatch(type: 'pointerup' | 'pointercancel' | 'blur' | 'pagehide', init: Record<string, unknown> = {}): void {
    const event = {
      type,
      target: this,
      currentTarget: this,
      pointerId: 1,
      pointerType: 'touch',
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...init,
    };
    for (const entry of this.listeners.get(type) ?? []) {
      if (entry.signal?.aborted) continue;
      if (typeof entry.listener === 'function') entry.listener.call(this, event as unknown as Event);
      else entry.listener.handleEvent(event as unknown as Event);
    }
  }
}

class FakeStage {
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly pointerRoot = new FakePointerRoot();
  readonly ownerDocument = { defaultView: this.pointerRoot };
  clientWidth = 390;
  clientHeight = 844;
  media: FakeMedia | null;
  readonly captureFailures = new Set<number>();
  private readonly listeners = new Map<string, FakeListener[]>();
  private readonly captures = new Set<number>();

  constructor(media: FakeMedia) {
    this.media = media;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void {
    const signal = typeof options === 'object' ? options.signal : undefined;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, ...(signal ? { signal } : {}) });
    this.listeners.set(type, listeners);
  }

  querySelector<T>(): T | null {
    return this.media as T | null;
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: this.clientWidth,
      bottom: this.clientHeight,
      width: this.clientWidth,
      height: this.clientHeight,
      toJSON: () => ({}),
    } as DOMRect;
  }

  setPointerCapture(pointerId: number): void {
    if (this.captureFailures.has(pointerId)) throw new Error('capture unavailable');
    this.captures.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captures.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captures.delete(pointerId);
  }

  dispatch(type: string, init: Record<string, unknown> = {}): Record<string, unknown> & { defaultPrevented: boolean } {
    if (type === 'lostpointercapture' && typeof init.pointerId === 'number') {
      this.captures.delete(init.pointerId);
    }
    const event = {
      type,
      target: this,
      currentTarget: this,
      button: 0,
      pointerId: 1,
      pointerType: 'touch',
      clientX: 0,
      clientY: 0,
      ctrlKey: false,
      metaKey: false,
      deltaY: 0,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...init,
    };
    for (const entry of this.listeners.get(type) ?? []) {
      if (entry.signal?.aborted) continue;
      if (typeof entry.listener === 'function') entry.listener.call(this, event as unknown as Event);
      else entry.listener.handleEvent(event as unknown as Event);
    }
    return event;
  }
}

class FakeViewer {
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
}

type HarnessOptions = {
  media?: 'image' | 'video';
  itemCount?: number;
  width?: number;
  nativeVideo?: 'pending' | 'active';
  reducedMotion?: boolean;
};

type PageCall = { direction: -1 | 1; gesture?: ImageViewerPageGesture };

class GestureHarness {
  readonly media: FakeMedia;
  readonly stage: FakeStage;
  readonly viewer = new FakeViewer();
  readonly pages: PageCall[] = [];
  readonly dismissals: boolean[] = [];
  readonly binding: ImageViewerGestureBinding;
  time = 0;

  constructor(options: HarnessOptions = {}) {
    this.media = new FakeMedia(options.media === 'video' ? 'VIDEO' : 'IMG');
    this.stage = new FakeStage(this.media);
    this.stage.clientWidth = options.width ?? 390;
    this.stage.style.touchAction = 'pan-y';
    if (options.nativeVideo) this.viewer.dataset.nativeVideo = options.nativeVideo;
    this.binding = bindImageViewerGestures({
      stage: this.stage as unknown as HTMLElement,
      viewer: this.viewer as unknown as HTMLElement,
      itemCount: options.itemCount ?? 3,
      media: () => this.stage.media as unknown as HTMLImageElement | HTMLVideoElement | null,
      zoomTarget: () => this.stage.media?.tagName === 'IMG'
        ? this.stage.media as unknown as HTMLImageElement
        : null,
      now: () => this.time,
      reducedMotion: options.reducedMotion,
      dismiss: downward => { this.dismissals.push(downward); },
      page: (direction, gesture) => { this.pages.push({ direction, ...(gesture ? { gesture } : {}) }); },
    });
    this.binding.reset();
  }

  pointer(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture', init: Record<string, unknown>): ReturnType<FakeStage['dispatch']> {
    return this.stage.dispatch(type, init);
  }

  drag(fromX: number, toX: number, elapsed: number, pointerId = 1): void {
    this.time = 0;
    this.pointer('pointerdown', { pointerId, clientX: fromX, clientY: 300 });
    this.time = elapsed;
    this.pointer('pointermove', { pointerId, clientX: toX, clientY: 300 });
    this.pointer('pointerup', { pointerId, clientX: toX, clientY: 300 });
  }
}

describe('image viewer horizontal paging', () => {
  it('pages images with signed residual motion while keeping the title chrome visible', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.time = 200;
    const move = harness.pointer('pointermove', { pointerId: 1, clientX: 200, clientY: 300 });

    expect(move.defaultPrevented).toBe(true);
    expect(harness.viewer.classList.contains('is-paging')).toBe(true);
    expect(harness.viewer.classList.contains('is-dragging')).toBe(false);
    expect(harness.viewer.style.getPropertyValue('--viewer-backdrop-opacity')).toBe('');
    const visualOffset = Number(harness.media.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1]);
    expect(visualOffset).toBeLessThan(0);
    expect(Math.abs(visualOffset)).toBeLessThan(100);

    harness.pointer('pointerup', { pointerId: 1, clientX: 200, clientY: 300 });
    expect(harness.pages).toEqual([{
      direction: 1,
      gesture: {
        direction: 1,
        offsetX: visualOffset,
        velocityX: -0.5,
        elapsedMs: 200,
        stageWidth: 390,
        source: 'drag',
      },
    }]);
    // The consumer transfers the residual to its outgoing layer, then reset()
    // atomically restores the child without enabling its CSS transition early.
    expect(harness.viewer.classList.contains('is-paging')).toBe(true);
    harness.binding.reset();
    expect(harness.viewer.classList.contains('is-paging')).toBe(false);
    expect(harness.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('reports the opposite direction and positive release velocity for a rightward page', () => {
    const harness = new GestureHarness();
    harness.drag(90, 180, 180);
    expect(harness.pages).toHaveLength(1);
    expect(harness.pages[0]).toMatchObject({
      direction: -1,
      gesture: { direction: -1, velocityX: 0.5, elapsedMs: 180 },
    });
    expect(harness.pages[0]!.gesture!.offsetX).toBeGreaterThan(0);
    expect(harness.pages[0]!.gesture!.offsetX).toBeLessThan(90);
  });

  it('uses adaptive distance and a guarded flick threshold', () => {
    const slowShort = new GestureHarness();
    slowShort.drag(200, 150, 500);
    expect(slowShort.pages).toEqual([]);
    expect(slowShort.media.animationCalls.at(-1)?.options.duration).toBe(180);

    const fast = new GestureHarness();
    fast.drag(200, 170, 50);
    expect(fast.pages).toHaveLength(1);

    const tooShort = new GestureHarness();
    tooShort.drag(200, 177, 20);
    expect(tooShort.pages).toEqual([]);

    const velocityBoundary = new GestureHarness();
    velocityBoundary.drag(200, 155, 100);
    expect(velocityBoundary.pages).toEqual([]);

    const singleItem = new GestureHarness({ itemCount: 1 });
    singleItem.drag(300, 100, 100);
    expect(singleItem.pages).toEqual([]);
    expect(singleItem.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('lets a paused inline video page but never treats it as a zoom target', () => {
    const harness = new GestureHarness({ media: 'video' });
    harness.drag(300, 200, 200);
    expect(harness.pages[0]).toMatchObject({ direction: 1 });
    expect(harness.pages[0]!.gesture!.offsetX).toBeLessThan(0);
    expect(Math.abs(harness.pages[0]!.gesture!.offsetX)).toBeLessThan(100);

    harness.binding.reset();
    harness.time = 1_000;
    harness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
    expect(harness.media.animationCalls).toEqual([]);

    harness.pointer('pointerdown', { pointerId: 2, clientX: 180, clientY: 200 });
    harness.time = 1_050;
    harness.pointer('pointermove', { pointerId: 2, clientX: 180, clientY: 320 });
    harness.pointer('pointerup', { pointerId: 2, clientX: 180, clientY: 320 });
    expect(harness.dismissals).toEqual([]);
  });

  it('locks all input after a committed page until its consumer resets the handoff', () => {
    const harness = new GestureHarness();
    harness.drag(300, 200, 200);
    expect(harness.pages).toHaveLength(1);
    expect(harness.viewer.classList.contains('is-paging')).toBe(true);

    harness.time = 500;
    harness.pointer('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 2, clientX: 100, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 2, clientX: 100, clientY: 300 });
    const doubleClick = harness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
    const wheel = harness.stage.dispatch('wheel', { ctrlKey: true, clientX: 195, clientY: 422, deltaY: -20 });

    expect(harness.pages).toHaveLength(1);
    expect(harness.media.animationCalls).toEqual([]);
    expect(doubleClick.defaultPrevented).toBe(true);
    expect(wheel.defaultPrevented).toBe(true);
    expect(harness.viewer.classList.contains('is-paging')).toBe(true);

    harness.binding.reset();
    harness.time = 1_000;
    harness.pointer('pointerdown', { pointerId: 3, clientX: 300, clientY: 300 });
    harness.time = 1_200;
    harness.pointer('pointermove', { pointerId: 3, clientX: 200, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 3, clientX: 200, clientY: 300 });
    expect(harness.pages).toHaveLength(2);
  });

  it('keeps a page-pending contact latched through reset and capture loss until physical release', () => {
    const harness = new GestureHarness();
    harness.drag(300, 200, 200);
    expect(harness.pages).toHaveLength(1);

    harness.pointer('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 });
    expect(harness.stage.hasPointerCapture(2)).toBe(true);
    harness.pointer('lostpointercapture', { pointerId: 2, clientX: 300, clientY: 300 });
    expect(harness.stage.hasPointerCapture(2)).toBe(false);
    harness.binding.reset();

    harness.time = 1_000;
    harness.pointer('pointerdown', { pointerId: 3, clientX: 300, clientY: 300 });
    harness.time = 1_100;
    harness.pointer('pointermove', { pointerId: 3, clientX: 180, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 3, clientX: 180, clientY: 300 });
    expect(harness.pages).toHaveLength(1);

    harness.stage.pointerRoot.dispatch('pointerup', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.drag(300, 200, 200, 4);
    expect(harness.pages).toHaveLength(2);
  });

  it.each(['pending', 'active'] as const)('ignores gestures while native video is %s', state => {
    const harness = new GestureHarness({ media: 'video', nativeVideo: state });
    harness.drag(300, 100, 100);
    expect(harness.pages).toEqual([]);
    expect(harness.media.style.transform).toBe('translate3d(0px, 0px, 0)');
  });

  it('rejects every gesture entry while the app is animating between media layers', () => {
    const pointerHarness = new GestureHarness();
    pointerHarness.viewer.classList.add('is-transitioning');
    pointerHarness.drag(300, 100, 100);
    expect(pointerHarness.pages).toEqual([]);
    expect(pointerHarness.dismissals).toEqual([]);
    expect(pointerHarness.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');

    const programmaticHarness = new GestureHarness();
    programmaticHarness.viewer.classList.add('is-transitioning');
    const wheel = programmaticHarness.stage.dispatch('wheel', {
      ctrlKey: true,
      clientX: 195,
      clientY: 422,
      deltaY: -20,
    });
    const doubleClick = programmaticHarness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
    expect(wheel.defaultPrevented).toBe(true);
    expect(doubleClick.defaultPrevented).toBe(true);
    expect(programmaticHarness.media.animationCalls).toEqual([]);
    expect(programmaticHarness.stage.dataset.zoomed).toBe('false');

    const touchHarness = new GestureHarness();
    touchHarness.pointer('pointerdown', { pointerId: 1, clientX: 120, clientY: 300 });
    touchHarness.time = 20;
    touchHarness.pointer('pointerup', { pointerId: 1, clientX: 120, clientY: 300 });
    touchHarness.viewer.classList.add('is-transitioning');
    touchHarness.time = 80;
    touchHarness.pointer('pointerdown', { pointerId: 2, clientX: 120, clientY: 300 });
    touchHarness.pointer('pointerup', { pointerId: 2, clientX: 120, clientY: 300 });
    touchHarness.viewer.classList.remove('is-transitioning');
    touchHarness.time = 120;
    touchHarness.pointer('pointerdown', { pointerId: 3, clientX: 120, clientY: 300 });
    touchHarness.time = 140;
    touchHarness.pointer('pointerup', { pointerId: 3, clientX: 120, clientY: 300 });
    expect(touchHarness.media.animationCalls).toEqual([]);
    expect(touchHarness.stage.dataset.zoomed).toBe('false');
  });

  it('keeps a transition-started contact latched after capture loss until physical release', () => {
    const harness = new GestureHarness();
    harness.viewer.classList.add('is-transitioning');
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.pointer('lostpointercapture', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.viewer.classList.remove('is-transitioning');

    harness.drag(300, 180, 100, 2);
    expect(harness.pages).toEqual([]);

    harness.pointer('pointerup', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.drag(300, 200, 200, 3);
    expect(harness.pages).toHaveLength(1);
  });
});

describe('image viewer dismissal and cancellation', () => {
  it('keeps downward image dismissal and rejects upward dismissal', () => {
    const downward = new GestureHarness();
    downward.pointer('pointerdown', { pointerId: 1, clientX: 190, clientY: 250 });
    downward.time = 300;
    downward.pointer('pointermove', { pointerId: 1, clientX: 190, clientY: 320 });
    expect(downward.viewer.classList.contains('is-dragging')).toBe(true);
    downward.pointer('pointerup', { pointerId: 1, clientX: 190, clientY: 320 });
    expect(downward.dismissals).toEqual([true]);

    const upward = new GestureHarness();
    upward.pointer('pointerdown', { pointerId: 1, clientX: 190, clientY: 320 });
    upward.time = 100;
    upward.pointer('pointermove', { pointerId: 1, clientX: 190, clientY: 220 });
    upward.pointer('pointerup', { pointerId: 1, clientX: 190, clientY: 220 });
    expect(upward.dismissals).toEqual([]);
  });

  it('adds edge resistance and progressively shrinks a normal-scale dismissal drag', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 190, clientY: 200 });
    harness.pointer('pointermove', { pointerId: 1, clientX: 220, clientY: 500 });

    const transform = harness.media.style.transform;
    const values = transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\) scale\(([-\d.]+)\)/);
    expect(values).not.toBeNull();
    expect(Math.abs(Number(values![1]))).toBeLessThan(30);
    expect(Number(values![2])).toBeGreaterThan(0);
    expect(Number(values![2])).toBeLessThan(300);
    expect(Number(values![3])).toBeLessThan(1);
    expect(Number(values![3])).toBeGreaterThanOrEqual(0.72);
  });

  it.each(['pointercancel', 'lostpointercapture'] as const)('%s settles without paging and leaves the next gesture usable', eventType => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.time = 100;
    harness.pointer('pointermove', { pointerId: 1, clientX: 190, clientY: 300 });
    harness.pointer(eventType, { pointerId: 1, clientX: 190, clientY: 300 });

    expect(harness.pages).toEqual([]);
    expect(harness.dismissals).toEqual([]);
    expect(harness.viewer.classList.contains('is-paging')).toBe(false);
    expect(harness.media.animationCalls.at(-1)?.options.duration).toBe(180);

    if (eventType === 'lostpointercapture') {
      harness.pointer('pointerup', { pointerId: 1, clientX: 190, clientY: 300 });
    }

    harness.time = 1_000;
    harness.pointer('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.time = 1_200;
    harness.pointer('pointermove', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 2, clientX: 200, clientY: 300 });
    expect(harness.pages).toHaveLength(1);
  });

  it('aborts and latches an active drag when the viewer becomes unavailable', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 1, clientX: 230, clientY: 300 });
    expect(harness.media.style.transform).toMatch(/^translate3d\(-/);
    expect(Math.abs(Number(harness.media.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1]))).toBeLessThan(70);

    harness.viewer.classList.add('is-transitioning');
    const captureLoss = harness.pointer('lostpointercapture', { pointerId: 1, clientX: 180, clientY: 300 });
    expect(captureLoss.defaultPrevented).toBe(true);
    expect(harness.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
    expect(harness.viewer.classList.contains('is-paging')).toBe(false);
    expect(harness.media.animationCalls).toEqual([]);

    harness.viewer.classList.remove('is-transitioning');
    harness.drag(300, 180, 100, 2);
    expect(harness.pages).toEqual([]);
    harness.pointer('pointerup', { pointerId: 1, clientX: 180, clientY: 300 });
    harness.drag(300, 200, 200, 3);
    expect(harness.pages).toHaveLength(1);
  });

  it('settles an active pointer outside the stage when capture could not be acquired', () => {
    const harness = new GestureHarness();
    harness.stage.captureFailures.add(1);
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    expect(harness.stage.hasPointerCapture(1)).toBe(false);
    harness.time = 200;
    harness.pointer('pointermove', { pointerId: 1, clientX: 200, clientY: 300 });

    harness.stage.pointerRoot.dispatch('pointerup', { pointerId: 1, clientX: 200, clientY: 300 });
    expect(harness.pages).toHaveLength(1);
    expect(harness.pages[0]).toMatchObject({ direction: 1 });
    expect(harness.pages[0]!.gesture!.offsetX).toBeLessThan(0);
    expect(Math.abs(harness.pages[0]!.gesture!.offsetX)).toBeLessThan(100);
  });

  it.each(['blur', 'pagehide'] as const)('releases a contact generation lost outside the window on %s', lifecycleEvent => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 1, clientX: 230, clientY: 300 });
    harness.viewer.classList.add('is-transitioning');
    harness.pointer('pointermove', { pointerId: 1, clientX: 200, clientY: 300 });
    harness.viewer.classList.remove('is-transitioning');

    // No terminal pointer event reaches this window. Its lifecycle boundary
    // must still restore the old pixels and make the next contact usable.
    harness.stage.pointerRoot.dispatch(lifecycleEvent);
    expect(harness.media.style.transform).toContain('scale(1)');
    expect(harness.viewer.classList.contains('is-paging')).toBe(false);

    harness.time = 1_000;
    harness.drag(300, 200, 200, 2);
    expect(harness.pages).toHaveLength(1);
  });

  it('fails closed when the active media is replaced during a drag', () => {
    const harness = new GestureHarness();
    const staleImage = harness.media;
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 1, clientX: 240, clientY: 300 });
    const replacement = new FakeMedia('IMG');
    harness.stage.media = replacement;
    harness.pointer('pointermove', { pointerId: 1, clientX: 180, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 180, clientY: 300 });

    expect(harness.pages).toEqual([]);
    expect(harness.dismissals).toEqual([]);
    expect(staleImage.animationCalls).toHaveLength(1);
    expect(replacement.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('rolls back a duplicate pointer id instead of leaving a transient offset behind', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 7, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 7, clientX: 220, clientY: 300 });
    expect(harness.media.style.transform).toMatch(/^translate3d\(-/);
    expect(Math.abs(Number(harness.media.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1]))).toBeLessThan(80);

    harness.pointer('pointerdown', { pointerId: 7, clientX: 220, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 7, clientX: 220, clientY: 300 });
    expect(harness.pages).toEqual([]);
    expect(harness.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('treats a non-primary second pointer as a conflict instead of committing the first drag', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 1, clientX: 200, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, button: 1, clientX: 180, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 2, button: 1, clientX: 180, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 200, clientY: 300 });
    expect(harness.pages).toEqual([]);
    expect(harness.dismissals).toEqual([]);
    expect(harness.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
  });
});

describe('image viewer zoom', () => {
  it('springs a pinch-reduced image back to its original fitted size', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 2, clientX: 110, clientY: 300 });

    const activeScale = Number(harness.media.style.transform.match(/scale\(([-\d.]+)\)/)?.[1]);
    expect(activeScale).toBeLessThan(1 / 3);
    expect(activeScale).toBeGreaterThanOrEqual(0.28);

    harness.pointer('pointerup', { pointerId: 2, clientX: 110, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 100, clientY: 300 });
    const settledScale = Number(harness.media.style.transform.match(/scale\(([-\d.]+)\)/)?.[1]);
    expect(settledScale).toBe(1);
    expect(harness.media.animationCalls.at(-1)?.options.duration).toBe(180);
  });

  it('keeps a pinch enlargement after both fingers are released', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 140, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 2, clientX: 320, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 2, clientX: 320, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 140, clientY: 300 });

    const settledScale = Number(harness.media.style.transform.match(/scale\(([-\d.]+)\)/)?.[1]);
    expect(settledScale).toBeGreaterThan(1);
  });

  it('uses one guarded WAAPI animation for both directions of image double-click zoom', async () => {
    const harness = new GestureHarness();
    const zoomIn = harness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(harness.stage.dataset.zoomed).toBe('true');
    expect(harness.viewer.classList.contains('is-pinching')).toBe(true);
    expect(harness.media.animationCalls).toHaveLength(1);
    const first = harness.media.animationCalls[0]!;
    expect(first.options).toMatchObject({ duration: 340, easing: 'cubic-bezier(.22,.72,.2,1)', fill: 'both' });
    expect(first.keyframes).toHaveLength(2);
    expect(first.keyframes[0]?.transform).not.toBe(first.keyframes[1]?.transform);
    expect(first.keyframes[1]?.transform).toContain('scale(2.5)');
    first.animation.finish();
    await first.animation.finished;
    await Promise.resolve();
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    expect(first.animation.cancelCount).toBe(1);

    harness.time = 400;
    harness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
    expect(harness.stage.dataset.zoomed).toBe('false');
    expect(harness.viewer.classList.contains('is-pinching')).toBe(true);
    expect(harness.media.animationCalls).toHaveLength(2);
    const second = harness.media.animationCalls[1]!;
    expect(second.keyframes[1]?.transform).toContain('scale(1)');
    second.animation.finish();
    await second.animation.finished;
    await Promise.resolve();
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
  });

  it('commits programmatic zoom and drag return immediately when reduced motion is preferred', () => {
    const zoomHarness = new GestureHarness({ reducedMotion: true });
    zoomHarness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
    expect(zoomHarness.stage.dataset.zoomed).toBe('true');
    expect(zoomHarness.media.style.transform).toContain('scale(2.5)');
    expect(zoomHarness.media.animationCalls).toEqual([]);
    expect(zoomHarness.viewer.classList.contains('is-pinching')).toBe(false);

    zoomHarness.time = 400;
    zoomHarness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
    expect(zoomHarness.stage.dataset.zoomed).toBe('false');
    expect(zoomHarness.media.style.transform).toContain('scale(1)');
    expect(zoomHarness.media.animationCalls).toEqual([]);

    const returnHarness = new GestureHarness({ reducedMotion: true });
    returnHarness.drag(200, 150, 500);
    expect(returnHarness.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
    expect(returnHarness.media.animationCalls).toEqual([]);
    expect(returnHarness.viewer.classList.contains('is-pinching')).toBe(false);
  });

  it('reads the platform reduced-motion preference when no override is supplied', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      const harness = new GestureHarness();
      harness.stage.dispatch('dblclick', { clientX: 195, clientY: 422 });
      expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
      expect(harness.media.style.transform).toContain('scale(2.5)');
      expect(harness.media.animationCalls).toEqual([]);
      expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps CSS transform transitions suppressed for an animated drag return', async () => {
    const harness = new GestureHarness();
    harness.drag(200, 150, 500);
    expect(harness.media.animationCalls).toHaveLength(1);
    const settle = harness.media.animationCalls[0]!;
    expect(settle.options.duration).toBe(180);
    expect(harness.viewer.classList.contains('is-pinching')).toBe(true);

    settle.animation.finish();
    await settle.animation.finished;
    await Promise.resolve();
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
  });

  it('recognizes a stationary double touch and suppresses its following synthetic dblclick', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 120, clientY: 300 });
    harness.time = 50;
    harness.pointer('pointerup', { pointerId: 1, clientX: 120, clientY: 300 });
    harness.time = 150;
    harness.pointer('pointerdown', { pointerId: 2, clientX: 124, clientY: 304 });
    harness.time = 200;
    const secondTap = harness.pointer('pointerup', { pointerId: 2, clientX: 124, clientY: 304 });

    expect(secondTap.defaultPrevented).toBe(true);
    expect(harness.media.animationCalls).toHaveLength(1);
    expect(harness.stage.dataset.zoomed).toBe('true');
    const synthetic = harness.stage.dispatch('dblclick', { clientX: 124, clientY: 304 });
    expect(synthetic.defaultPrevented).toBe(true);
    expect(harness.media.animationCalls).toHaveLength(1);
    expect(harness.stage.dataset.zoomed).toBe('true');
  });

  it('does not turn distant or slow taps into a double tap', () => {
    const distant = new GestureHarness();
    distant.pointer('pointerdown', { pointerId: 1, clientX: 80, clientY: 200 });
    distant.time = 20;
    distant.pointer('pointerup', { pointerId: 1, clientX: 80, clientY: 200 });
    distant.time = 100;
    distant.pointer('pointerdown', { pointerId: 2, clientX: 130, clientY: 200 });
    distant.time = 120;
    distant.pointer('pointerup', { pointerId: 2, clientX: 130, clientY: 200 });
    expect(distant.media.animationCalls).toEqual([]);

    const slow = new GestureHarness();
    slow.pointer('pointerdown', { pointerId: 1, clientX: 80, clientY: 200 });
    slow.time = 20;
    slow.pointer('pointerup', { pointerId: 1, clientX: 80, clientY: 200 });
    slow.time = 400;
    slow.pointer('pointerdown', { pointerId: 2, clientX: 80, clientY: 200 });
    slow.time = 420;
    slow.pointer('pointerup', { pointerId: 2, clientX: 80, clientY: 200 });
    expect(slow.media.animationCalls).toEqual([]);
  });

  it('keeps is-pinching through pinch and remaining-finger pan without allowing a page', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    expect(harness.viewer.classList.contains('is-pinching')).toBe(true);

    harness.time = 20;
    harness.pointer('pointermove', { pointerId: 2, clientX: 300, clientY: 300 });
    expect(harness.media.style.transform).toContain('scale(2)');
    harness.time = 30;
    harness.pointer('pointerup', { pointerId: 2, clientX: 300, clientY: 300 });
    expect(harness.viewer.classList.contains('is-pinching')).toBe(true);

    const beforePan = harness.media.style.transform;
    harness.time = 60;
    harness.pointer('pointermove', { pointerId: 1, clientX: 50, clientY: 300 });
    expect(harness.media.style.transform).not.toBe(beforePan);
    harness.pointer('pointerup', { pointerId: 1, clientX: 50, clientY: 300 });
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    expect(harness.pages).toEqual([]);
    expect(harness.dismissals).toEqual([]);
  });

  it('never transfers pinch zoom state to a replacement image', () => {
    const harness = new GestureHarness();
    const original = harness.media;
    harness.pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 2, clientX: 300, clientY: 300 });
    expect(original.style.transform).toContain('scale(2)');

    const replacement = new FakeMedia('IMG');
    harness.stage.media = replacement;
    harness.pointer('pointermove', { pointerId: 1, clientX: 80, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 80, clientY: 300 });

    expect(original.style.transform).toContain('scale(1)');
    expect(replacement.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
    expect(harness.stage.dataset.zoomed).toBe('false');
    expect(harness.pages).toEqual([]);

    harness.time = 1_000;
    harness.pointer('pointerdown', { pointerId: 3, clientX: 300, clientY: 300 });
    harness.time = 1_200;
    harness.pointer('pointermove', { pointerId: 3, clientX: 200, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 3, clientX: 200, clientY: 300 });
    expect(harness.pages).toHaveLength(1);
  });

  it('never creates a delayed pinch on media that replaced the pre-pinch generation', () => {
    const harness = new GestureHarness();
    const original = harness.media;
    harness.pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, clientX: 104, clientY: 300 });

    const replacement = new FakeMedia('IMG');
    harness.stage.media = replacement;
    const move = harness.pointer('pointermove', { pointerId: 2, clientX: 220, clientY: 300 });
    expect(move.defaultPrevented).toBe(true);
    expect(original.style.transform).toContain('scale(1)');
    expect(replacement.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
    expect(replacement.animationCalls).toEqual([]);
    expect(harness.stage.dataset.zoomed).toBe('false');

    harness.pointer('pointerup', { pointerId: 2, clientX: 220, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 100, clientY: 300 });
    harness.drag(300, 200, 200, 3);
    expect(harness.pages).toHaveLength(1);
  });

  it('aborts and latches an active pinch when the viewer becomes unavailable', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 2, clientX: 300, clientY: 300 });
    expect(harness.media.style.transform).toContain('scale(2)');

    harness.viewer.classList.add('is-transitioning');
    harness.pointer('pointermove', { pointerId: 1, clientX: 80, clientY: 300 });
    expect(harness.media.style.transform).toContain('scale(1)');
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    expect(harness.media.animationCalls).toEqual([]);

    harness.viewer.classList.remove('is-transitioning');
    harness.drag(300, 180, 100, 3);
    expect(harness.pages).toEqual([]);
    harness.pointer('pointerup', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 80, clientY: 300 });
    harness.drag(300, 200, 200, 4);
    expect(harness.pages).toHaveLength(1);
  });

  it('rejects a pinch whose two fingers began on different media generations', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    const replacement = new FakeMedia('IMG');
    harness.stage.media = replacement;
    harness.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 100, clientY: 300 });

    expect(harness.pages).toEqual([]);
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    expect(replacement.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
    expect(harness.stage.dataset.zoomed).toBe('false');
  });

  it('latches a third-pointer conflict until every pointer leaves', () => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointerdown', { pointerId: 3, clientX: 250, clientY: 300 });
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    harness.pointer('pointermove', { pointerId: 1, clientX: 0, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 3, clientX: 250, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 2, clientX: 200, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 0, clientY: 300 });
    expect(harness.pages).toEqual([]);
    expect(harness.dismissals).toEqual([]);
    expect(harness.media.style.transform).toContain('scale(1)');
    expect(harness.stage.dataset.zoomed).toBe('false');

    harness.binding.reset();
    harness.time = 1_000;
    harness.pointer('pointerdown', { pointerId: 4, clientX: 300, clientY: 300 });
    harness.time = 1_200;
    harness.pointer('pointermove', { pointerId: 4, clientX: 200, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 4, clientX: 200, clientY: 300 });
    expect(harness.pages).toHaveLength(1);
  });

  it.each([
    ['mixed pointer types', 'pointerup'],
    ['a cancelled pinch', 'pointercancel'],
  ] as const)('fails closed for %s', (_label, terminal) => {
    const harness = new GestureHarness();
    harness.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 300 });
    harness.pointer('pointerdown', {
      pointerId: 2,
      pointerType: terminal === 'pointercancel' ? 'touch' : 'pen',
      clientX: 200,
      clientY: 300,
    });
    harness.pointer('pointermove', { pointerId: 2, clientX: 300, clientY: 300 });
    harness.pointer(terminal, { pointerId: 2, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 1, clientX: 0, clientY: 300 });
    harness.pointer('pointerup', { pointerId: 1, clientX: 0, clientY: 300 });
    expect(harness.pages).toEqual([]);
    expect(harness.dismissals).toEqual([]);
    expect(harness.media.style.transform).toContain('scale(1)');
    expect(harness.stage.dataset.zoomed).toBe('false');
  });

  it('disables CSS transform transitions throughout trackpad zoom frames', () => {
    vi.useFakeTimers();
    try {
      const harness = new GestureHarness();
      const wheel = harness.stage.dispatch('wheel', {
        ctrlKey: true,
        clientX: 195,
        clientY: 422,
        deltaY: -20,
      });
      expect(wheel.defaultPrevented).toBe(true);
      expect(harness.viewer.classList.contains('is-pinching')).toBe(true);
      expect(harness.media.style.transform).not.toContain('scale(1)');
      vi.advanceTimersByTime(89);
      expect(harness.viewer.classList.contains('is-pinching')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('image viewer binding lifetime', () => {
  it('restores touch behavior, clears interaction classes, and removes every listener on destroy', () => {
    const harness = new GestureHarness();
    expect(harness.stage.style.touchAction).toBe('none');
    expect(harness.media.offsetWidthReads).toBeGreaterThan(0);
    harness.pointer('pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    harness.pointer('pointermove', { pointerId: 1, clientX: 200, clientY: 300 });
    expect(harness.viewer.classList.contains('is-paging')).toBe(true);

    harness.binding.destroy();
    expect(harness.stage.style.touchAction).toBe('pan-y');
    expect(harness.viewer.classList.contains('is-paging')).toBe(false);
    expect(harness.viewer.classList.contains('is-pinching')).toBe(false);
    expect(harness.stage.dataset.zoomed).toBe('false');
    expect(harness.media.style.transform).toBe('translate3d(0px, 0px, 0) scale(1)');
    expect(harness.stage.hasPointerCapture(1)).toBe(false);

    harness.time = 100;
    harness.pointer('pointerup', { pointerId: 1, clientX: 200, clientY: 300 });
    harness.drag(300, 100, 100, 2);
    expect(harness.pages).toEqual([]);
    expect(harness.dismissals).toEqual([]);
  });
});
