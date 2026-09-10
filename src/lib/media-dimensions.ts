export type MediaDimensions = { width: number; height: number };

export function validMediaDimensions(value: { width?: unknown; height?: unknown }): value is MediaDimensions {
  return Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)
    && Number(value.width) > 0 && Number(value.height) > 0
    && Number(value.width) <= 65535 && Number(value.height) <= 65535;
}

/** Decode only the sender's local original, with bounded lifetime. */
export async function readMediaDimensions(file: Blob, signal?: AbortSignal): Promise<MediaDimensions | undefined> {
  signal?.throwIfAborted();
  if (typeof document === 'undefined' || !/^(image|video)\//.test(file.type)) return;
  const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'img');
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<MediaDimensions | undefined>((resolve, reject) => {
      const finish = () => {
        const dimensions = media instanceof HTMLVideoElement
          ? { width: media.videoWidth, height: media.videoHeight }
          : { width: media.naturalWidth, height: media.naturalHeight };
        cleanup();
        resolve(validMediaDimensions(dimensions) ? dimensions : undefined);
      };
      const abort = () => { cleanup(); reject(signal?.reason); };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        media.onload = null;
        media.onerror = null;
        media.onloadedmetadata = null;
      };
      const timer = window.setTimeout(finish, 5000);
      signal?.addEventListener('abort', abort, { once: true });
      media.onload = finish;
      media.onerror = finish;
      media.onloadedmetadata = finish;
      if (media instanceof HTMLVideoElement) { media.preload = 'metadata'; media.muted = true; }
      media.src = url;
    });
  } finally {
    media.removeAttribute('src');
    if (media instanceof HTMLVideoElement) media.load();
    URL.revokeObjectURL(url);
  }
}
