/** Inspect container structure, never compressed pixel data or file extensions. */
export async function detectImageAnimation(blob: Blob, signal?: AbortSignal): Promise<boolean> {
  let start = -1;
  let buffer = new Uint8Array();
  let steps = 0;
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    signal?.throwIfAborted();
    if (++steps > 2_000_000 || offset < 0 || offset + length > blob.size) throw new Error('Invalid image container');
    if (offset < start || offset + length > start + buffer.length) {
      start = offset;
      buffer = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + Math.max(length, 65_536))).arrayBuffer());
      signal?.throwIfAborted();
    }
    return buffer.subarray(offset - start, offset - start + length);
  };
  const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);
  const uint = (bytes: Uint8Array, littleEndian = false) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, littleEndian);
  if (blob.size < 12) return false;
  const head = await read(0, 12);
  if (ascii(head.subarray(0, 6)) === 'GIF87a' || ascii(head.subarray(0, 6)) === 'GIF89a') {
    const packed = (await read(10, 1))[0]!;
    let offset = 13 + ((packed & 0x80) ? 3 * (2 ** ((packed & 7) + 1)) : 0);
    let frames = 0;
    const skipBlocks = async () => {
      while (true) {
        const size = (await read(offset++, 1))[0]!;
        if (!size) break;
        offset += size;
        if (offset > blob.size) throw new Error('Truncated GIF');
      }
    };
    while (offset < blob.size) {
      const marker = (await read(offset++, 1))[0];
      if (marker === 0x3b) return false;
      if (marker === 0x21) { offset++; await skipBlocks(); }
      else if (marker === 0x2c) {
        const descriptor = await read(offset, 9);
        const flags = descriptor[8]!;
        offset += 9 + ((flags & 0x80) ? 3 * (2 ** ((flags & 7) + 1)) : 0);
        await read(offset++, 1); // LZW minimum code size precedes data sub-blocks.
        await skipBlocks();
        if (++frames > 1) return true;
      } else throw new Error('Invalid GIF block');
    }
    return false;
  }
  if (head[0] === 137 && ascii(head.subarray(1, 8)) === 'PNG\r\n\x1a\n') {
    let offset = 8;
    while (offset + 12 <= blob.size) {
      const chunk = await read(offset, 8);
      const size = uint(chunk);
      const type = ascii(chunk.subarray(4));
      if (size > blob.size - offset - 12) throw new Error('Truncated PNG');
      if (type === 'acTL') return size === 8 && uint(await read(offset + 8, 4)) > 1;
      if (type === 'IDAT' || type === 'IEND') return false;
      offset += size + 12;
    }
  } else if (ascii(head.subarray(0, 4)) === 'RIFF' && ascii(head.subarray(8, 12)) === 'WEBP') {
    const length = uint(head.subarray(4, 8), true) + 8;
    if (length > blob.size) throw new Error('Truncated WebP');
    let offset = 12;
    let frames = 0;
    while (offset + 8 <= length) {
      const chunk = await read(offset, 8);
      const size = uint(chunk.subarray(4), true);
      if (size > length - offset - 8) throw new Error('Truncated WebP chunk');
      if (ascii(chunk.subarray(0, 4)) === 'ANMF' && ++frames > 1) return true;
      offset += 8 + size + (size % 2);
    }
  }
  return false;
}

export type ImageMotion = { pause: () => void; resume: () => void; destroy: () => void; playing: () => boolean };

/** The bounded still frame is temporary; downloads always retain the original. */
export async function prepareImageMotion(image: HTMLImageElement, blob: Blob, signal: AbortSignal): Promise<ImageMotion | null> {
  if (!await detectImageAnimation(blob, signal)) return null;
  const originalUrl = image.src;
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!width || !height) return null;
  const ratio = Math.min(1, 4096 / width, 4096 / height, Math.sqrt(8_000_000 / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法准备静态画面');
  let still: Blob | null;
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    still = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally { canvas.width = canvas.height = 0; }
  signal.throwIfAborted();
  if (!still) throw new Error('无法准备静态画面');
  const stillUrl = URL.createObjectURL(still);
  let destroyed = false;
  let playing = true;
  // Preserve fitted geometry when the memory-only still is downsampled.
  image.style.aspectRatio = `${width} / ${height}`;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    signal.removeEventListener('abort', destroy);
    image.removeAttribute('src');
    URL.revokeObjectURL(stillUrl);
  };
  signal.addEventListener('abort', destroy, { once: true });
  return {
    playing: () => playing,
    pause: () => { if (!destroyed) { playing = false; image.src = stillUrl; } },
    resume: () => { if (!destroyed) { playing = true; image.src = originalUrl; } },
    destroy,
  };
}
