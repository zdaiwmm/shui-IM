import type { MessagePayload } from './types';

type FileMediaMetadata = { mimeType: string; originalName: string };

const VIDEO_EXTENSIONS: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
};

/** Classify existing file messages without changing their encrypted metadata. */
export function videoMimeType(manifest: FileMediaMetadata): string | null {
  const mimeType = manifest.mimeType.trim().replace(/^[^;]*/, value => value.toLowerCase());
  if (/^video\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;[^\r\n]*)?$/.test(mimeType)) return mimeType;
  // A filename must not turn an explicitly typed document into playable media.
  if (mimeType !== '' && mimeType !== 'application/octet-stream') return null;
  const extension = manifest.originalName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(VIDEO_EXTENSIONS, extension) ? VIDEO_EXTENSIONS[extension]! : null;
}

export function isVideoFile(manifest: FileMediaMetadata): boolean {
  return videoMimeType(manifest) !== null;
}

/** The creator's safe automatically projects every chat attachment. */
export function isGalleryMediaPayload(payload: MessagePayload): boolean {
  return payload.kind === 'image' || payload.kind === 'image-album' || payload.kind === 'gallery-image' ||
    payload.kind === 'gallery-file' || payload.kind === 'file';
}
