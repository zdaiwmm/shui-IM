import { fromBase64Url } from './base64';
import { isReactionEmoji } from './reactions';
import type { MessagePayload } from './types';

export const MAX_MESSAGE_TEXT_LENGTH = 4000;
export const MAX_REPLY_PREVIEW_LENGTH = 160;
export const MAX_IMAGE_NAME_LENGTH = 1024;
export const MAX_IMAGE_MIME_LENGTH = 255;
export const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
export const IMAGE_CHUNK_SIZE = 2 * 1024 * 1024;
export const MIN_IMAGE_ALBUM_ITEMS = 2;
export const MAX_IMAGE_ALBUM_ITEMS = 9;
export const MAX_IMAGE_ALBUM_BYTES = MAX_IMAGE_BYTES;
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const MIN_AUDIO_DURATION_MS = 500;
export const MAX_AUDIO_DURATION_MS = 5 * 60 * 1000;
export const AUDIO_MIME_TYPES = ['audio/wav', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'] as const;

export function isAudioMimeType(value: unknown): value is string {
  return typeof value === 'string' && (AUDIO_MIME_TYPES as readonly string[]).includes(value.toLowerCase().replace(/\s/g, ''));
}

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

function isAttachmentManifest(value: unknown, kind: 'image' | 'audio' | 'file'): boolean {
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
    chunkCount === Math.ceil(originalSize / IMAGE_CHUNK_SIZE) &&
    typeof image.originalName === 'string' && image.originalName.length <= MAX_IMAGE_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(image.originalName) &&
    typeof image.mimeType === 'string' && image.mimeType.length <= MAX_IMAGE_MIME_LENGTH &&
    (kind === 'file'
      ? !/[\u0000-\u001f\u007f]/.test(image.mimeType)
      : image.mimeType.length > 0 && (kind === 'image' ? image.mimeType.startsWith('image/') : isAudioMimeType(image.mimeType) && originalSize <= MAX_AUDIO_BYTES)) &&
    typeof lastModified === 'number' && Number.isSafeInteger(lastModified) && lastModified >= 0 &&
    typeof image.sha256 === 'string' && SHA256.test(image.sha256),
  );
}

export function isImageManifest(value: unknown): boolean {
  return isAttachmentManifest(value, 'image');
}

export function isAudioManifest(value: unknown): boolean {
  return isAttachmentManifest(value, 'audio');
}

export function isFileManifest(value: unknown): boolean {
  return isAttachmentManifest(value, 'file');
}

function isReplyReference(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, unknown>;
  return hasOnlyKeys(reply, ['clientMsgId', 'serverSeq', 'senderId', 'kind', 'preview']) &&
    typeof reply.clientMsgId === 'string' && UUID_V4.test(reply.clientMsgId) &&
    typeof reply.serverSeq === 'number' && Number.isSafeInteger(reply.serverSeq) && reply.serverSeq > 0 &&
    typeof reply.senderId === 'string' && UUID_V4.test(reply.senderId) &&
    (reply.kind === 'text' || reply.kind === 'image' || reply.kind === 'audio' || reply.kind === 'file') &&
    typeof reply.preview === 'string' && reply.preview.length > 0 && [...reply.preview].length <= MAX_REPLY_PREVIEW_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(reply.preview);
}

export function isMessageTarget(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const target = value as Record<string, unknown>;
  return hasOnlyKeys(target, ['clientMsgId', 'serverSeq', 'senderId']) &&
    typeof target.clientMsgId === 'string' && UUID_V4.test(target.clientMsgId) &&
    typeof target.serverSeq === 'number' && Number.isSafeInteger(target.serverSeq) && target.serverSeq > 0 &&
    typeof target.senderId === 'string' && UUID_V4.test(target.senderId);
}

export function isMessagePayload(value: unknown): value is MessagePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  if (
    (payload.v !== 1 && payload.v !== 2) ||
    typeof payload.sentAt !== 'string' ||
    payload.sentAt.length > 64 ||
    !Number.isFinite(Date.parse(payload.sentAt))
  ) return false;
  if (payload.kind === 'reaction') {
    if (payload.v !== 1 || !hasOnlyKeys(payload, ['v', 'kind', 'sentAt', 'target', 'emoji']) ||
      (payload.emoji !== null && !isReactionEmoji(payload.emoji)) ||
      !isMessageTarget(payload.target)
    ) return false;
    return true;
  }
  if (payload.kind === 'message-delete') {
    return payload.v === 1 &&
      hasOnlyKeys(payload, ['v', 'kind', 'sentAt', 'target']) &&
      isMessageTarget(payload.target);
  }
  if (payload.kind === 'text') {
    if (typeof payload.text !== 'string' || payload.text.length > MAX_MESSAGE_TEXT_LENGTH) return false;
    if (payload.v === 1) return hasOnlyKeys(payload, ['v', 'kind', 'text', 'sentAt']);
    if (!hasOnlyKeys(payload, ['v', 'kind', 'text', 'sentAt', 'replyTo'])) return false;
    return isReplyReference(payload.replyTo);
  }
  if (payload.kind === 'image') {
    if (!isImageManifest(payload.image)) return false;
    if (payload.v === 1) return hasOnlyKeys(payload, ['v', 'kind', 'image', 'sentAt']);
    return hasOnlyKeys(payload, ['v', 'kind', 'image', 'sentAt', 'replyTo']) && isReplyReference(payload.replyTo);
  }
  if (payload.kind === 'file') {
    if (!isFileManifest(payload.file)) return false;
    if (payload.v === 1) return hasOnlyKeys(payload, ['v', 'kind', 'file', 'sentAt']);
    return hasOnlyKeys(payload, ['v', 'kind', 'file', 'sentAt', 'replyTo']) && isReplyReference(payload.replyTo);
  }
  if (payload.kind === 'audio') {
    if (!isAudioManifest(payload.audio) ||
      typeof payload.durationMs !== 'number' || !Number.isSafeInteger(payload.durationMs) ||
      payload.durationMs < MIN_AUDIO_DURATION_MS || payload.durationMs > MAX_AUDIO_DURATION_MS ||
      !Array.isArray(payload.waveform) || payload.waveform.length < 1 || payload.waveform.length > 64 ||
      !payload.waveform.every((sample) => Number.isInteger(sample) && sample >= 0 && sample <= 100)
    ) return false;
    const keys = ['v', 'kind', 'audio', 'durationMs', 'waveform', 'sentAt'];
    if (payload.v === 1) return hasOnlyKeys(payload, keys);
    return hasOnlyKeys(payload, [...keys, 'replyTo']) && isReplyReference(payload.replyTo);
  }
  if (payload.kind === 'image-album') {
    if (
      !Array.isArray(payload.images) ||
      payload.images.length < MIN_IMAGE_ALBUM_ITEMS ||
      payload.images.length > MAX_IMAGE_ALBUM_ITEMS
    ) return false;
    const blobIds = new Set<string>();
    let totalOriginalBytes = 0;
    for (const image of payload.images) {
      if (!isImageManifest(image) || blobIds.has(image.blobId)) return false;
      blobIds.add(image.blobId);
      totalOriginalBytes += image.originalSize;
      if (totalOriginalBytes > MAX_IMAGE_ALBUM_BYTES) return false;
    }
    if (payload.v === 1) return hasOnlyKeys(payload, ['v', 'kind', 'images', 'sentAt']);
    return hasOnlyKeys(payload, ['v', 'kind', 'images', 'sentAt', 'replyTo']) && isReplyReference(payload.replyTo);
  }
  if (payload.v !== 1) return false;
  if (payload.kind === 'gallery-file') {
    return hasOnlyKeys(payload, ['v', 'kind', 'file', 'sentAt']) && isFileManifest(payload.file);
  }
  return hasOnlyKeys(payload, ['v', 'kind', 'image', 'sentAt']) &&
    payload.kind === 'gallery-image' && isImageManifest(payload.image);
}
