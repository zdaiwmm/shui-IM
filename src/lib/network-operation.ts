/** Cancelable deadlines; callers supply only fixed, non-sensitive error codes. */
export class NetworkOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'NetworkOperationError'; }
}
export function networkDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new DOMException('已取消', 'AbortError')); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function boundedOperation<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number, code: string, parent?: AbortSignal): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason ?? new DOMException('已取消', 'AbortError'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  let rejectAbort: () => void = () => {};
  const canceled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new NetworkOperationError(code, '网络操作超时')), ms);
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), canceled]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
