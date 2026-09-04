import { MAX_IMAGE_ALBUM_BYTES, MAX_IMAGE_ALBUM_ITEMS } from './message-payload';

/** Preserve the selected order while keeping each message within its wire limits. */
export function batchImageFiles<T extends { size: number }>(
  files: T[],
  destination: 'chat' | 'gallery',
): T[][] {
  return batchFiles(files, destination, () => true);
}

/** Documents stand alone; only consecutive images can share an album. */
export function batchAttachmentFiles<T extends { size: number; type: string }>(
  files: T[],
  destination: 'chat' | 'gallery',
): T[][] {
  return batchFiles(files, destination, (file) => file.type.startsWith('image/'));
}

function batchFiles<T extends { size: number }>(
  files: T[],
  destination: 'chat' | 'gallery',
  isImage: (file: T) => boolean,
): T[][] {
  if (files.some((file) => file.size > MAX_IMAGE_ALBUM_BYTES)) {
    throw new Error('单个文件不能超过 256 MiB');
  }
  if (destination === 'gallery') return files.map((file) => [file]);

  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const file of files) {
    if (!isImage(file)) {
      if (current.length > 0) batches.push(current);
      batches.push([file]);
      current = [];
      currentBytes = 0;
      continue;
    }
    if (
      current.length > 0 &&
      (current.length === MAX_IMAGE_ALBUM_ITEMS || currentBytes + file.size > MAX_IMAGE_ALBUM_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
