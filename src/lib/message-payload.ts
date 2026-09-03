import { fromBase64Url } from './base64';
import type { MessagePayload } from './types';

export const MAX_MESSAGE_TEXT_LENGTH = 4000;
export const MAX_IMAGE_NAME_LENGTH = 1024;
export const MAX_IMAGE_MIME_LENGTH = 255;
export const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
export const IMAGE_CHUNK_SIZE = 2 * 1024 * 1024;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function boundedBase64(value: unknown, byteLength: number): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  if (value.length < Math.ceil(byteLength * 4 / 3) - 2 || value.length > Math.ceil(byteLength * 4 / 3) + 2) return false;
  try {
    return fromBase64Url(value).length === byteLength;
  } catch {
    return false;
  }
}

export function isImageManifest(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const image = value as Record<string, unknown>;
  const chunkCount = image.chunkCount;
  const originalSize = image.originalSize;
  const lastModified = image.lastModified;
  return Boolean(
    hasOnlyKeys(image, ['v', 'blobId', 'key', 'ivPrefix', 'chunkSize', 'chunkCount', 'originalSize', 'originalName', 'mimeType', 'lastModified', 'sha256']) &&
    image.v === 1 &&
    typeof image.blobId === 'string' && UUID_V4.test(image.blobId) &&
    boundedBase64(image.key, 32) &&
    boundedBase64(image.ivPrefix, 8) &&
    image.chunkSize === IMAGE_CHUNK_SIZE &&
    typeof chunkCount === 'number' && Number.isSafeInteger(chunkCount) && chunkCount >= 1 && chunkCount <= 128 &&
    typeof originalSize === 'number' && Number.isSafeInteger(originalSize) && originalSize >= 1 && originalSize <= MAX_IMAGE_BYTES &&
    typeof image.originalName === 'string' && image.originalName.length <= MAX_IMAGE_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(image.originalName) &&
    typeof image.mimeType === 'string' && image.mimeType.length > 0 && image.mimeType.length <= MAX_IMAGE_MIME_LENGTH &&
    image.mimeType.startsWith('image/') &&
    typeof lastModified === 'number' && Number.isSafeInteger(lastModified) && lastModified >= 0 &&
    typeof image.sha256 === 'string' && SHA256.test(image.sha256),
  );
}

export function isMessagePayload(value: unknown): value is MessagePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  if (
    payload.v !== 1 ||
    typeof payload.sentAt !== 'string' ||
    payload.sentAt.length > 64 ||
    !Number.isFinite(Date.parse(payload.sentAt))
  ) return false;
  if (payload.kind === 'text') {
    return hasOnlyKeys(payload, ['v', 'kind', 'text', 'sentAt']) &&
      typeof payload.text === 'string' && payload.text.length <= MAX_MESSAGE_TEXT_LENGTH;
  }
  return hasOnlyKeys(payload, ['v', 'kind', 'image', 'sentAt']) &&
    (payload.kind === 'image' || payload.kind === 'gallery-image') && isImageManifest(payload.image);
}
