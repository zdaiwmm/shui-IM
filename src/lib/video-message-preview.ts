import { isPreviewImage, PREVIEW_IMAGE_BYTES, type PreviewImage } from './link-preview-data';
import { createVideoPoster } from './video-poster';
import { fromBase64Url, toBase64Url } from './base64';

export const VIDEO_PREVIEW_CAPABILITY = 'video-preview-v1';
export type VideoMessagePreview = { durationMs?: number; image?: PreviewImage };

export function isVideoMessagePreview(value: unknown): value is VideoMessagePreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return !Object.keys(p).some(key => !['durationMs','image'].includes(key))
    && (p.durationMs !== undefined || p.image !== undefined)
    && (p.durationMs === undefined || Number.isSafeInteger(p.durationMs) && Number(p.durationMs) > 0 && Number(p.durationMs) <= 7 * 24 * 3600 * 1000)
    && (p.image === undefined || isPreviewImage(p.image));
}

/** Source data is local; only this bounded JPEG and duration enter MLS ciphertext. */
export async function createVideoMessagePreview(file: File, signal?: AbortSignal): Promise<VideoMessagePreview | undefined> {
  const url = URL.createObjectURL(file);
  let bitmap: ImageBitmap | undefined;
  try {
    const poster = await createVideoPoster(url, signal);
    const result: VideoMessagePreview = {};
    if (poster.durationMs && poster.durationMs <= 7 * 24 * 3600 * 1000) result.durationMs = poster.durationMs;
    bitmap = await createImageBitmap(poster.blob);
    const canvas = document.createElement('canvas');
    for (let attempt = 0, scale = 1; attempt < 6; attempt++, scale *= .7) {
      signal?.throwIfAborted();
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d'); if (!context) break;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .65));
      signal?.throwIfAborted();
      if (blob && blob.size <= PREVIEW_IMAGE_BYTES) {
        result.image = { mimeType: 'image/jpeg', data: toBase64Url(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
        break;
      }
    }
    canvas.width = canvas.height = 0;
    return isVideoMessagePreview(result) ? result : undefined;
  } catch { signal?.throwIfAborted(); return undefined; }
  finally { bitmap?.close(); URL.revokeObjectURL(url); }
}

export function videoMessagePoster(preview?: VideoMessagePreview): Blob | undefined {
  if (!preview || !isVideoMessagePreview(preview) || !preview.image) return;
  return new Blob([fromBase64Url(preview.image.data)], { type: 'image/jpeg' });
}
