import type { PhotoMetadata } from './photo-detail-model';

export function readPhotoMetadata(blob: Blob, signal: AbortSignal): Promise<PhotoMetadata> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./photo-metadata.worker.ts', import.meta.url), { type: 'module' }); }
    catch { resolve({ tags: {}, unavailable: true }); return; }
    const cleanup = () => { window.clearTimeout(timeout); signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { cleanup(); reject(new DOMException('Photo details closed', 'AbortError')); };
    const timeout = window.setTimeout(() => { cleanup(); resolve({ tags: {}, unavailable: true }); }, 4_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<PhotoMetadata>) => { cleanup(); resolve(event.data); };
    worker.onerror = () => { cleanup(); resolve({ tags: {}, unavailable: true }); };
    worker.postMessage(blob);
  });
}
