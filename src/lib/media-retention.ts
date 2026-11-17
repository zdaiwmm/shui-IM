import type { MessagePayload } from './types';

/** Idle time, rather than grant expiry or file creation time. */
export const TRANSFER_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MEDIA_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

export function staleMediaActivity(updated: number, now: number): boolean {
  return Number.isSafeInteger(updated) && updated >= 0 && updated <= now - TRANSFER_RETENTION_MS;
}

export function attachmentBlobIds(payload: MessagePayload): string[] {
  switch (payload.kind) {
    case 'image': case 'gallery-image': return [payload.image.blobId];
    case 'image-album': return payload.images.map(image => image.blobId);
    case 'file': case 'gallery-file': return [payload.file.blobId];
    case 'audio': return [payload.audio.blobId];
    default: return [];
  }
}
