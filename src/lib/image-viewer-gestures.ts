type Point = { x: number; y: number };
type Axis = 'x' | 'y' | null;
type ActivePointer = Point & { pointerType: string };

type ViewerMedia = HTMLImageElement | HTMLVideoElement;

export type ImageViewerPageGesture = {
  direction: -1 | 1;
  /** Signed displacement left on the media at release; left is negative. */
  offsetX: number;
  /** Signed average velocity in CSS pixels per millisecond. */
  velocityX: number;
  elapsedMs: number;
  stageWidth: number;
  source: 'drag';
};

export type ImageViewerGestureBinding = {
  reset: () => void;
  destroy: () => void;
};

export type ImageViewerGestureOptions = {
  stage: HTMLElement;
  viewer: HTMLElement;
  itemCount: number;
  dismiss: (downward: boolean) => void;
  /** The optional detail keeps the old one-argument callback source-compatible. */
  page: (direction: -1 | 1, gesture?: ImageViewerPageGesture) => void;
  /** Override these when the viewer keeps more than one slide mounted. */
  media?: () => ViewerMedia | null;
  /** Return null for a video poster represented by an img element. */
  zoomTarget?: () => HTMLImageElement | null;
  /** Deterministic clock injection for gesture tests. */
  now?: () => number;
  /** Override the viewer's reduced-motion preference in deterministic tests. */
  reducedMotion?: boolean;
};

const AXIS_LOCK_DISTANCE = 8;
const PAGE_MIN_DISTANCE = 56;
const PAGE_MAX_DISTANCE = 96;
const PAGE_DISTANCE_RATIO = 0.16;
const PAGE_FLICK_MIN_DISTANCE = 24;
const PAGE_FLICK_VELOCITY = 0.45;
const DISMISS_DISTANCE = 60;
const DISMISS_FLICK_MIN_DISTANCE = 24;
const DISMISS_FLICK_VELOCITY = 0.45;
const DOUBLE_TAP_DELAY = 300;
const DOUBLE_TAP_DISTANCE = 24;
const TAP_MAX_DURATION = 260;
const PINCH_MIN_DISTANCE = 8;
const MIN_SCALE = 1 / 3;
const MAX_SCALE = 5;
const PINCH_UNDERSCALE_LIMIT = 0.28;
const PINCH_OVERSCALE_LIMIT = 5.42;
const DRAG_SHRINK_LIMIT = 1 / 2;
const ZOOM_DURATION = 340;
const RETURN_DURATION = 180;
const MOTION_EASING = 'cubic-bezier(.22,.72,.2,1)';

function resistEdgeDistance(distance: number, extent: number): number {
  const safeExtent = Math.max(extent, 1);
  return distance / (1 + Math.abs(distance) / (safeExtent * 2.5));
}

function dragScaleForDistance(x: number, y: number, width: number, height: number): number {
  const progress = Math.min(1, Math.hypot(x / Math.max(width, 1), y / Math.max(height, 1)));
  return Math.max(DRAG_SHRINK_LIMIT, 1 - progress * (1 - DRAG_SHRINK_LIMIT));
}

function tagName(element: Element | null): string {
  return element?.tagName?.toLowerCase() ?? '';
}

function eventStartedOnButton(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && Boolean(target.closest('button, input, .viewer-video-controls'));
}

/** Image zoom plus media paging. Native full-screen video remains outside this DOM. */
export function bindImageViewerGestures(options: ImageViewerGestureOptions): ImageViewerGestureBinding {
  const { stage, viewer } = options;
  const events = new AbortController();
  const now = options.now ?? (() => performance.now());
  const reducedMotion = options.reducedMotion ??
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const pointers = new Map<number, ActivePointer>();
  const blockedPointers = new Set<number>();
  const previousTouchAction = stage.style.touchAction;
  // The video stylesheet permits native pan. An inline value is required here
  // so a paused video can reliably hand a horizontal gesture to this viewer.
  stage.style.touchAction = 'none';

  let scale = 1;
  let pan: Point = { x: 0, y: 0 };
  let drag: {
    id: number;
    origin: Point;
    pan: Point;
    startedAt: number;
    axis: Axis;
    media: ViewerMedia;
    image: HTMLImageElement | null;
    scale: number;
    /** A finger left after a valid pinch may pan, but must never become a page. */
    panOnly: boolean;
  } | null = null;
  let pinch: { distance: number; center: Point; scale: number; pan: Point; image: HTMLImageElement } | null = null;
  let multiSnapshot: {
    media: ViewerMedia;
    image: HTMLImageElement | null;
    scale: number;
    pan: Point;
  } | null = null;
  let multiTouch = false;
  let gestureConflict = false;
  let pagePending = false;
  let stateMedia: ViewerMedia | null = null;
  let lastTap: { at: number; point: Point } | null = null;
  let suppressDblClickUntil = 0;
  let transformAnimation: Animation | null = null;
  let wheelEndTimer: ReturnType<typeof setTimeout> | null = null;
  let continuousTransform = false;
  let programmaticTransform = false;

  const media = (): ViewerMedia | null => {
    if (options.media) return options.media();
    return stage.querySelector<ViewerMedia>('img, video');
  };
  const nativeVideoActive = () => Boolean(viewer.dataset.nativeVideo);
  const viewerUnavailable = () => viewer.classList.contains('is-closing') || viewer.classList.contains('is-transitioning');
  const hasStagePointerCapture = (pointerId: number) => {
    try { return stage.hasPointerCapture(pointerId); } catch { return false; }
  };
  const image = (): HTMLImageElement | null => {
    if (options.zoomTarget) return options.zoomTarget();
    const target = media();
    return tagName(target) === 'img' ? target as HTMLImageElement : null;
  };
  const imageForMedia = (target: ViewerMedia): HTMLImageElement | null => {
    const zoomTarget = image();
    return zoomTarget === target ? zoomTarget : null;
  };
  const transform = () => `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`;
  const syncTransformSuppression = () => {
    if (continuousTransform || programmaticTransform) viewer.classList.add('is-pinching');
    else viewer.classList.remove('is-pinching');
  };
  const setContinuousTransform = (active: boolean) => {
    continuousTransform = active;
    syncTransformSuppression();
  };
  const cancelTransformAnimation = (finish = false) => {
    const animation = transformAnimation;
    transformAnimation = null;
    programmaticTransform = false;
    syncTransformSuppression();
    if (!animation) return;
    if (finish) {
      try { animation.finish(); } catch { /* A detached target has no finishable effect. */ }
    }
    animation.cancel();
  };
  const animateTransform = (target: ViewerMedia, next: string, duration: number, from = target.style.transform || 'none') => {
    cancelTransformAnimation(true);
    // The stylesheet owns a transform transition for double-click zoom. Keep it
    // suppressed for the entire WAAPI transaction so only one animator ever
    // owns transform, including on WebKit.
    programmaticTransform = true;
    syncTransformSuppression();
    void target.offsetWidth;
    target.style.transform = next;
    if (reducedMotion || from === next || typeof target.animate !== 'function') {
      // Commit the new value while CSS transitions are still disabled. This
      // makes reduced motion immediate instead of falling back to the CSS path.
      void target.offsetWidth;
      programmaticTransform = false;
      syncTransformSuppression();
      return;
    }
    let animation: Animation;
    try {
      animation = target.animate([{ transform: from }, { transform: next }], {
        duration,
        easing: MOTION_EASING,
        fill: 'both',
      });
    } catch {
      void target.offsetWidth;
      programmaticTransform = false;
      syncTransformSuppression();
      return;
    }
    transformAnimation = animation;
    void animation.finished.then(() => {
      if (transformAnimation !== animation) return;
      transformAnimation = null;
      animation.cancel();
      programmaticTransform = false;
      syncTransformSuppression();
    }, () => {
      if (transformAnimation !== animation) return;
      transformAnimation = null;
      programmaticTransform = false;
      syncTransformSuppression();
    });
  };
  const applyImage = (target = image(), animate = false, from?: string, duration = ZOOM_DURATION) => {
    if (!target) return;
    const fit = Math.min(target.clientWidth / (target.naturalWidth || 1), target.clientHeight / (target.naturalHeight || 1));
    const maxX = Math.max(0, (target.naturalWidth * fit * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (target.naturalHeight * fit * scale - stage.clientHeight) / 2);
    pan.x = Math.max(-maxX, Math.min(maxX, pan.x));
    pan.y = Math.max(-maxY, Math.min(maxY, pan.y));
    const next = transform();
    if (animate) animateTransform(target, next, duration, from);
    else {
      cancelTransformAnimation();
      target.style.transform = next;
    }
    stage.dataset.zoomed = String(scale > 1.01);
  };
  const returnMediaToRest = (target: ViewerMedia | null, animate = true) => {
    if (!target) return;
    const targetImage = imageForMedia(target);
    if (targetImage) {
      applyImage(targetImage, animate, targetImage.style.transform || 'none', RETURN_DURATION);
      return;
    }
    const next = 'translate3d(0px, 0px, 0)';
    if (animate) animateTransform(target, next, RETURN_DURATION);
    else {
      cancelTransformAnimation();
      target.style.transform = next;
    }
    stage.dataset.zoomed = 'false';
  };
  const restoreKnownMedia = (
    target: ViewerMedia,
    targetImage: HTMLImageElement | null,
    nextScale: number,
    nextPan: Point,
    animate: boolean,
  ) => {
    scale = nextScale;
    pan = { ...nextPan };
    if (targetImage) applyImage(targetImage, animate, targetImage.style.transform || 'none', RETURN_DURATION);
    else {
      const next = 'translate3d(0px, 0px, 0)';
      if (animate) animateTransform(target, next, RETURN_DURATION);
      else {
        cancelTransformAnimation();
        target.style.transform = next;
      }
      stage.dataset.zoomed = 'false';
    }
    stateMedia = target;
  };
  const normalizeCurrentAfterStaleMedia = (stale: ViewerMedia) => {
    const current = media();
    if (!current || current === stale) return;
    scale = 1;
    pan = { x: 0, y: 0 };
    stateMedia = current;
    const currentImage = image();
    if (currentImage === current) applyImage(currentImage, false);
    else {
      cancelTransformAnimation();
      current.style.transform = 'translate3d(0px, 0px, 0)';
      stage.dataset.zoomed = 'false';
    }
  };
  const restoreDragState = (ended: NonNullable<typeof drag>, animate: boolean) => {
    restoreKnownMedia(ended.media, ended.image, ended.scale, ended.pan, animate);
    normalizeCurrentAfterStaleMedia(ended.media);
  };
  const restoreMultiSnapshot = (animate: boolean) => {
    const snapshot = multiSnapshot;
    if (!snapshot) return;
    restoreKnownMedia(snapshot.media, snapshot.image, snapshot.scale, snapshot.pan, animate);
    normalizeCurrentAfterStaleMedia(snapshot.media);
  };
  const stopDrag = () => {
    drag = null;
    viewer.classList.remove('is-dragging', 'is-paging');
    setContinuousTransform(false);
    viewer.style.removeProperty('--viewer-backdrop-opacity');
  };
  const stopWheelInteraction = () => {
    if (wheelEndTimer !== null) clearTimeout(wheelEndTimer);
    wheelEndTimer = null;
    setContinuousTransform(false);
  };
  const abortActiveInteraction = (animate: boolean) => {
    const interruptedDrag = drag;
    const interruptedSnapshot = multiSnapshot;
    if (interruptedSnapshot) restoreMultiSnapshot(animate);
    else if (interruptedDrag) restoreDragState(interruptedDrag, animate);
    for (const pointerId of pointers.keys()) blockedPointers.add(pointerId);
    pointers.clear();
    pinch = null;
    multiSnapshot = null;
    multiTouch = false;
    gestureConflict = false;
    lastTap = null;
    stopDrag();
  };
  const blockPointer = (event: PointerEvent) => {
    lastTap = null;
    blockedPointers.add(event.pointerId);
    event.preventDefault();
    try { stage.setPointerCapture(event.pointerId); } catch { /* Ignore synthetic or detached targets. */ }
  };
  const reset = () => {
    cancelTransformAnimation();
    stopWheelInteraction();
    const target = media();
    const pointerIds = [...pointers.keys()];
    for (const pointerId of pointerIds) blockedPointers.add(pointerId);
    pointers.clear();
    // Retain capture until the physical pointerup/cancel. Releasing it here
    // produces lostpointercapture while the finger is still down and would make
    // a later pointer look like a fresh single-finger gesture.
    pinch = null;
    multiSnapshot = null;
    multiTouch = false;
    gestureConflict = false;
    pagePending = false;
    lastTap = null;
    suppressDblClickUntil = 0;
    scale = 1;
    pan = { x: 0, y: 0 };
    stateMedia = target;
    // Even the initial reset changes the inline value from empty to scale(1).
    // Suppress the normal double-click transition while that baseline commits.
    setContinuousTransform(true);
    if (target) {
      returnMediaToRest(target, false);
      // Commit the transition:none style before removing its guard. Without a
      // style flush, WebKit can coalesce the class and transform mutations and
      // incorrectly animate this baseline as an entry zoom.
      void target.offsetWidth;
    }
    stage.dataset.zoomed = 'false';
    // Clear the interaction classes after the inline transform is restored.
    // This prevents the normal double-click transition from animating a
    // successful page's residual child transform on top of the layer handoff.
    stopDrag();
  };
  const pair = () => {
    const [first, second] = [...pointers.values()];
    if (!first || !second) return null;
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    };
  };
  const zoom = (next: number, center: Point, animate = false, startScale = scale, startPan = pan, startCenter = center, resistant = false) => {
    const target = image();
    if (!target) return;
    stateMedia = target;
    const from = target.style.transform || transform();
    const bounds = stage.getBoundingClientRect();
    const origin = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    const bounded = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    scale = resistant
      ? next < MIN_SCALE ? Math.max(PINCH_UNDERSCALE_LIMIT, MIN_SCALE - (MIN_SCALE - next) * .16)
        : next > MAX_SCALE ? Math.min(PINCH_OVERSCALE_LIMIT, MAX_SCALE + (next - MAX_SCALE) * .14)
          : next
      : bounded;
    const ratio = scale / startScale;
    pan = {
      x: center.x - origin.x - (startCenter.x - origin.x - startPan.x) * ratio,
      y: center.y - origin.y - (startCenter.y - origin.y - startPan.y) * ratio,
    };
    applyImage(target, animate, from);
  };
  const beginProgrammaticZoom = (point: Point) => {
    cancelTransformAnimation(true);
    zoom(scale > 1.01 ? 1 : 2.5, point, true);
  };
  const registerTouchTap = (event: PointerEvent, ended: NonNullable<typeof drag>, elapsed: number, x: number, y: number): boolean => {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || elapsed > TAP_MAX_DURATION ||
        Math.hypot(x, y) > AXIS_LOCK_DISTANCE || !imageForMedia(ended.media)) {
      lastTap = null;
      return false;
    }
    const at = now();
    const point = { x: event.clientX, y: event.clientY };
    const previous = lastTap;
    if (previous && at - previous.at <= DOUBLE_TAP_DELAY && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) <= DOUBLE_TAP_DISTANCE) {
      lastTap = null;
      suppressDblClickUntil = at + DOUBLE_TAP_DELAY;
      event.preventDefault();
      beginProgrammaticZoom(point);
      return true;
    }
    lastTap = { at, point };
    return false;
  };

  stage.addEventListener('pointerdown', event => {
    if (pagePending || blockedPointers.size > 0 || viewerUnavailable()) {
      if (viewerUnavailable() && pointers.size > 0) abortActiveInteraction(false);
      blockPointer(event);
      return;
    }
    stopWheelInteraction();
    const target = media();
    const invalidStart = event.button !== 0 || !target || nativeVideoActive() ||
      viewerUnavailable() || eventStartedOnButton(event.target);
    if (pointers.size === 0 && invalidStart) {
      lastTap = null;
      return;
    }

    if (pointers.has(event.pointerId)) {
      if (!multiSnapshot && drag) {
        multiSnapshot = {
          media: drag.media,
          image: drag.image,
          scale: drag.scale,
          pan: { ...drag.pan },
        };
      }
      gestureConflict = true;
      multiTouch = true;
      stopDrag();
      lastTap = null;
      restoreMultiSnapshot(true);
      return;
    }

    cancelTransformAnimation(true);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pointerType: event.pointerType });
    if (pointers.size > 1) {
      const previousDrag = drag;
      const previousMedia = previousDrag?.media ?? multiSnapshot?.media ?? target;
      if (!previousMedia) {
        gestureConflict = true;
        multiTouch = true;
        return;
      }
      if (!multiSnapshot && previousDrag) {
        multiSnapshot = {
          media: previousDrag.media,
          image: previousDrag.image,
          scale: previousDrag.scale,
          pan: { ...previousDrag.pan },
        };
      }
      stopDrag();
      setContinuousTransform(true);
      lastTap = null;
      multiTouch = true;
      restoreMultiSnapshot(false);
      const current = pair();
      const zoomTarget = image();
      const pointerTypes = new Set([...pointers.values()].map(pointer => pointer.pointerType));
      if (invalidStart || pointers.size !== 2 || pointerTypes.size !== 1 || !pointerTypes.has('touch') ||
          !target || previousMedia !== target || zoomTarget !== target) gestureConflict = true;
      pinch = !gestureConflict && current && current.distance >= PINCH_MIN_DISTANCE
        ? { ...current, scale, pan: { ...pan }, image: zoomTarget! }
        : null;
      if (gestureConflict) {
        restoreMultiSnapshot(true);
        setContinuousTransform(false);
      }
    } else if (!multiTouch) {
      if (!target) return;
      if (stateMedia !== target) {
        scale = 1;
        pan = { x: 0, y: 0 };
        stateMedia = target;
      }
      const targetImage = imageForMedia(target);
      drag = {
        id: event.pointerId,
        origin: { x: event.clientX, y: event.clientY },
        pan: { ...pan },
        startedAt: now(),
        axis: null,
        media: target,
        image: targetImage,
        scale,
        panOnly: false,
      };
    }
    try { stage.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers have no capture target. */ }
  }, { signal: events.signal });

  stage.addEventListener('pointermove', event => {
    if (blockedPointers.has(event.pointerId)) {
      event.preventDefault();
      return;
    }
    if (!pointers.has(event.pointerId)) return;
    const gestureMedia = multiTouch ? multiSnapshot?.media ?? pinch?.image ?? null : drag?.media ?? null;
    const unavailable = viewerUnavailable() || nativeVideoActive();
    if (unavailable || gestureMedia && media() !== gestureMedia) {
      event.preventDefault();
      // A disappearing generation may settle visibly; a viewer transition must
      // normalize immediately before its layer handoff.
      abortActiveInteraction(!unavailable);
      return;
    }
    const previousPointer = pointers.get(event.pointerId)!;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pointerType: previousPointer.pointerType });
    if (multiTouch) {
      event.preventDefault();
      if (gestureConflict) return;
      const current = pair();
      if (!pinch) {
        const zoomTarget = image();
        if (current && current.distance >= PINCH_MIN_DISTANCE && multiSnapshot && zoomTarget &&
            multiSnapshot.media === zoomTarget && multiSnapshot.image === zoomTarget) {
          pinch = { ...current, scale, pan: { ...pan }, image: zoomTarget };
        } else if (current && current.distance >= PINCH_MIN_DISTANCE) {
          gestureConflict = true;
          restoreMultiSnapshot(true);
          setContinuousTransform(false);
        }
        return;
      }
      if (!current || image() !== pinch.image) {
        gestureConflict = true;
        pinch = null;
        setContinuousTransform(false);
        restoreMultiSnapshot(true);
        return;
      }
      zoom(pinch.scale * current.distance / pinch.distance, current.center, false, pinch.scale, pinch.pan, pinch.center, true);
      return;
    }
    if (!drag || drag.id !== event.pointerId) return;
    if (media() !== drag.media || nativeVideoActive() || viewerUnavailable()) {
      const staleDrag = drag;
      gestureConflict = true;
      stopDrag();
      restoreDragState(staleDrag, true);
      return;
    }
    const x = event.clientX - drag.origin.x;
    const y = event.clientY - drag.origin.y;
    const targetImage = imageForMedia(drag.media);
    if (targetImage && (scale > 1.01 || drag.panOnly)) {
      event.preventDefault();
      lastTap = null;
      setContinuousTransform(true);
      pan = { x: drag.pan.x + x, y: drag.pan.y + y };
      applyImage(targetImage);
      return;
    }
    if (!drag.axis && Math.hypot(x, y) > AXIS_LOCK_DISTANCE) drag.axis = Math.abs(y) > Math.abs(x) ? 'y' : 'x';
    if (!drag.axis) return;
    lastTap = null;
    if (drag.axis === 'x') {
      if (options.itemCount < 2) return;
      event.preventDefault();
      // Deliberately avoid .is-dragging: existing chrome styles hide the title
      // for that class. Horizontal paging keeps the header continuously visible.
      viewer.classList.remove('is-dragging');
      viewer.classList.add('is-paging');
      const resistedX = resistEdgeDistance(x, stage.clientWidth);
      drag.media.style.transform = `translate3d(${resistedX}px, 0px, 0)`;
      return;
    }
    event.preventDefault();
    viewer.classList.remove('is-paging');
    viewer.classList.add('is-dragging');
    const resistedX = resistEdgeDistance(x, stage.clientWidth);
    const resistedY = resistEdgeDistance(y, stage.clientHeight);
    const dragScale = dragScaleForDistance(x, y, stage.clientWidth, stage.clientHeight);
    drag.media.style.transform = `translate3d(${resistedX}px, ${resistedY}px, 0) scale(${dragScale})`;
    viewer.style.setProperty('--viewer-backdrop-opacity', String(1 - Math.min(Math.abs(y) / Math.max(stage.clientHeight, 1), 0.8)));
  }, { signal: events.signal });

  const end = (event: PointerEvent, reason: 'up' | 'cancel' | 'capture-loss') => {
    const physicalTerminal = reason !== 'capture-loss';
    if (blockedPointers.has(event.pointerId)) {
      event.preventDefault();
      // Capture ownership can be lost while the contact is still physically
      // active. Only pointerup/pointercancel releases the latch.
      if (!physicalTerminal) return;
      blockedPointers.delete(event.pointerId);
      try {
        if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      } catch { /* Ignore a detached capture target. */ }
      return;
    }
    if (!pointers.has(event.pointerId)) return;
    if (!physicalTerminal) {
      event.preventDefault();
      abortActiveInteraction(!(viewerUnavailable() || nativeVideoActive()));
      return;
    }
    pointers.delete(event.pointerId);
    try {
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    } catch { /* Ignore a detached capture target. */ }
    const interruptedMedia = multiTouch ? multiSnapshot?.media ?? pinch?.image ?? null : drag?.media ?? null;
    if (viewerUnavailable() || nativeVideoActive() || interruptedMedia && media() !== interruptedMedia) {
      abortActiveInteraction(false);
      return;
    }
    if (multiTouch) {
      if (reason === 'cancel') gestureConflict = true;
      const completedPinch = pinch;
      pinch = null;
      lastTap = null;
      if (multiSnapshot && media() !== multiSnapshot.media) gestureConflict = true;
      if (completedPinch && image() !== completedPinch.image) gestureConflict = true;
      if (!gestureConflict && completedPinch && scale < 1) {
        // A pinch that makes the fitted image smaller is only exploratory.
        // Once both fingers leave, return to the original fitted size. Keep a
        // genuine enlargement in place so the user can continue inspecting it.
        scale = 1;
        pan = { x: 0, y: 0 };
        applyImage(completedPinch.image, true, completedPinch.image.style.transform || 'none', RETURN_DURATION);
      } else if (!gestureConflict && completedPinch && scale > MAX_SCALE) {
        scale = MAX_SCALE;
        applyImage(completedPinch.image, true);
      }
      if (!gestureConflict && completedPinch && pointers.size === 1 && image() === completedPinch.image) {
        const remaining = [...pointers.entries()][0]!;
        multiTouch = false;
        multiSnapshot = null;
        stateMedia = completedPinch.image;
        drag = {
          id: remaining[0],
          origin: { x: remaining[1].x, y: remaining[1].y },
          pan: { ...pan },
          startedAt: now(),
          axis: null,
          media: completedPinch.image,
          image: completedPinch.image,
          scale,
          panOnly: true,
        };
        viewer.classList.remove('is-dragging', 'is-paging');
        setContinuousTransform(true);
        viewer.style.removeProperty('--viewer-backdrop-opacity');
        return;
      }
      stopDrag();
      restoreMultiSnapshot(gestureConflict);
      if (pointers.size === 0) {
        multiTouch = false;
        gestureConflict = false;
        multiSnapshot = null;
      }
      return;
    }
    const ended = drag;
    stopDrag();
    if (!ended || ended.id !== event.pointerId) {
      if (pointers.size === 0) gestureConflict = false;
      return;
    }
    if (reason === 'cancel' || gestureConflict || media() !== ended.media || nativeVideoActive() || viewerUnavailable()) {
      lastTap = null;
      gestureConflict = false;
      restoreDragState(ended, true);
      return;
    }
    const x = event.clientX - ended.origin.x;
    const y = event.clientY - ended.origin.y;
    const elapsed = Math.max(now() - ended.startedAt, 1);
    if (imageForMedia(ended.media) && (scale > 1.01 || ended.panOnly)) {
      applyImage(imageForMedia(ended.media));
      return;
    }
    const axis = ended.axis ?? (Math.hypot(x, y) > AXIS_LOCK_DISTANCE ? (Math.abs(y) > Math.abs(x) ? 'y' : 'x') : null);
    if (axis === 'y' && imageForMedia(ended.media) && y > 0 &&
        (y >= DISMISS_DISTANCE || (y > DISMISS_FLICK_MIN_DISTANCE && y / elapsed > DISMISS_FLICK_VELOCITY))) {
      lastTap = null;
      options.dismiss(y > 0);
      return;
    }
    const velocityX = x / elapsed;
    const pageDistance = Math.min(PAGE_MAX_DISTANCE, Math.max(PAGE_MIN_DISTANCE, stage.clientWidth * PAGE_DISTANCE_RATIO));
    if (axis === 'x' && options.itemCount > 1 &&
        (Math.abs(x) >= pageDistance || Math.abs(x) >= PAGE_FLICK_MIN_DISTANCE && Math.abs(velocityX) > PAGE_FLICK_VELOCITY)) {
      lastTap = null;
      const direction = x < 0 ? 1 : -1;
      const offsetX = resistEdgeDistance(x, stage.clientWidth);
      // Keep the transition-disabling class until the consumer calls reset()
      // after moving this residual transform onto its outgoing layer.
      pagePending = true;
      viewer.classList.add('is-paging');
      ended.media.style.transform = `translate3d(${offsetX}px, 0px, 0)`;
      options.page(direction, {
        direction,
        offsetX,
        velocityX,
        elapsedMs: elapsed,
        stageWidth: stage.clientWidth,
        source: 'drag',
      });
      return;
    }
    if (axis === null && registerTouchTap(event, ended, elapsed, x, y)) return;
    restoreDragState(ended, true);
  };
  stage.addEventListener('pointerup', event => end(event, 'up'), { signal: events.signal });
  stage.addEventListener('pointercancel', event => end(event, 'cancel'), { signal: events.signal });
  stage.addEventListener('lostpointercapture', event => end(event, 'capture-loss'), { signal: events.signal });
  const pointerRoot = stage.ownerDocument?.defaultView;
  // Once capture is lost, the physical terminal event can target something
  // outside the stage. Observe only already-blocked contacts at the window
  // boundary so their latches cannot become permanent.
  pointerRoot?.addEventListener('pointerup', event => {
    if (blockedPointers.has(event.pointerId) ||
        (pointers.has(event.pointerId) && !hasStagePointerCapture(event.pointerId))) {
      end(event, 'up');
    }
  }, { capture: true, signal: events.signal });
  pointerRoot?.addEventListener('pointercancel', event => {
    if (blockedPointers.has(event.pointerId) ||
        (pointers.has(event.pointerId) && !hasStagePointerCapture(event.pointerId))) {
      end(event, 'cancel');
    }
  }, { capture: true, signal: events.signal });
  const abandonContactsOutsideWindow = () => {
    // Some mobile browsers emit neither pointerup nor pointercancel when a
    // contact ends while the top-level window is backgrounded. Treat losing
    // the window as a failed gesture generation: restore pixels immediately,
    // then release only the internal latch so the next real pointerdown after
    // resume can start cleanly.
    if (pointers.size > 0) abortActiveInteraction(false);
    blockedPointers.clear();
    lastTap = null;
  };
  pointerRoot?.addEventListener('blur', abandonContactsOutsideWindow, { signal: events.signal });
  pointerRoot?.addEventListener('pagehide', abandonContactsOutsideWindow, { signal: events.signal });

  stage.addEventListener('wheel', event => {
    if (pagePending || blockedPointers.size > 0 || pointers.size > 0 || viewerUnavailable()) {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
      lastTap = null;
      return;
    }
    if (nativeVideoActive() || (!event.ctrlKey && !event.metaKey) || !image()) return;
    event.preventDefault();
    lastTap = null;
    cancelTransformAnimation(true);
    setContinuousTransform(true);
    zoom(scale * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY }, false, scale, pan, { x: event.clientX, y: event.clientY }, true);
    if (wheelEndTimer !== null) clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      wheelEndTimer = null;
      if (scale < MIN_SCALE || scale > MAX_SCALE) {
        scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        applyImage(image(), true);
      }
      setContinuousTransform(false);
    }, 90);
  }, { passive: false, signal: events.signal });

  stage.addEventListener('dblclick', event => {
    if (pagePending || blockedPointers.size > 0 || pointers.size > 0 || viewerUnavailable()) {
      event.preventDefault();
      lastTap = null;
      return;
    }
    if (nativeVideoActive() || !image()) return;
    stopWheelInteraction();
    event.preventDefault();
    if (now() < suppressDblClickUntil) return;
    lastTap = null;
    beginProgrammaticZoom({ x: event.clientX, y: event.clientY });
  }, { signal: events.signal });

  return {
    reset,
    destroy: () => {
      // reset() commits a neutral inline transform and latches active contacts.
      // Abort listeners before releasing captures so synchronous capture-loss
      // events cannot re-enter the state machine during teardown.
      reset();
      events.abort();
      for (const pointerId of blockedPointers) {
        try {
          if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
        } catch { /* A detached stage may no longer expose capture state. */ }
      }
      blockedPointers.clear();
      if (stage.style.touchAction === 'none') stage.style.touchAction = previousTouchAction;
    },
  };
}
