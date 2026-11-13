/** Coalesce presentation only: business transitions must execute separately. */
export function latestPaint<T>(paint: (state: T) => void,
  schedule: (fn: () => void) => number = requestAnimationFrame,
  cancel: (id: number) => void = cancelAnimationFrame) {
  let latest: T | undefined, pending = false, frame: number | undefined, disposed = false;
  const flush = () => {
    frame = undefined;
    if (disposed || !pending) return;
    pending = false;
    paint(latest!);
  };
  return {
    update(state: T, immediate = false) {
      if (disposed) return;
      latest = state; pending = true;
      if (immediate) { if (frame !== undefined) cancel(frame); flush(); }
      else if (frame === undefined) frame = schedule(flush);
    },
    dispose() { disposed = true; pending = false; if (frame !== undefined) cancel(frame); frame = undefined; latest = undefined; },
  };
}
