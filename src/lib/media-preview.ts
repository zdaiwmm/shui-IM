import { detectImageAnimation } from './image-animation';

/** Only formats proven static are re-encoded; animated/unknown media keep originals. */
export async function createMediaPreview(blob: Blob, signal?: AbortSignal): Promise<Blob | null> {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(blob.type)) return null;
  if (blob.type !== 'image/jpeg') {
    try {
      if (await detectImageAnimation(blob, signal)) return null;
    } catch {
      return null;
    }
  }
  signal?.throwIfAborted();
  const url = URL.createObjectURL(blob); const image = new Image();
  try {
    image.src = url; await image.decode(); signal?.throwIfAborted();
    const edge = Math.min(2048, Math.max(1024, Math.ceil(Math.max(screen.width, screen.height) * Math.min(devicePixelRatio || 1, 3))));
    const ratio = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    try {
      const context = canvas.getContext('2d'); if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.92));
      signal?.throwIfAborted(); return result;
    } finally { canvas.width = canvas.height = 0; }
  } finally { image.removeAttribute('src'); URL.revokeObjectURL(url); }
}
