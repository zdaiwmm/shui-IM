export const MAX_MEME_BYTES = 8 * 1024 * 1024;
export const MAX_MEME_PIXELS = 16_000_000;
export const MAX_MEME_FAVORITES = 100;
export const MAX_MEME_LIBRARY_BYTES = 128 * 1024 * 1024;
export type MemeFavorite = { id: string; digest: string; name: string; type: string; size: number; savedAt: number };
export const MEME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export function normalizeMemeIndex(value: unknown): MemeFavorite[] {
  if (!Array.isArray(value) || value.length > MAX_MEME_FAVORITES) throw new Error('本机收藏索引已损坏');
  const ids = new Set<string>();
  const digests = new Set<string>();
  let bytes = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || !/^[0-9a-f-]{36}$/.test(item.id)
      || !/^[0-9a-f]{64}$/.test(item.digest) || ids.has(item.id) || digests.has(item.digest)
      || typeof item.name !== 'string' || item.name.length > 120 || !MEME_TYPES.includes(item.type)
      || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_MEME_BYTES
      || !Number.isSafeInteger(item.savedAt) || item.savedAt < 0) throw new Error('本机收藏索引已损坏');
    ids.add(item.id); digests.add(item.digest); bytes += item.size;
  }
  if (bytes > MAX_MEME_LIBRARY_BYTES) throw new Error('本机收藏空间超出限制');
  return value as MemeFavorite[];
}

/** Check file signatures before the browser decoder receives external bytes. */
export function sniffMemeType(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 8 && bytes[0] === 137 && ascii(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export async function validateMemeFile(blob: Blob, name: string, signal: AbortSignal): Promise<File> {
  signal.throwIfAborted();
  if (!blob.size || blob.size > MAX_MEME_BYTES) throw new Error('梗图需小于 8 MiB');
  const type = sniffMemeType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
  if (!type) throw new Error('仅支持 JPEG、PNG、WebP 和 GIF 图片');
  const file = new File([blob], name.slice(0, 120) || '梗图', { type, lastModified: 0 });
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        image.onload = null; image.onerror = null; image.removeAttribute('src');
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      const timer = window.setTimeout(() => finish(new Error('图片解码超时')), 10_000);
      signal.addEventListener('abort', abort, { once: true });
      image.onload = () => finish(!image.naturalWidth || image.naturalWidth * image.naturalHeight > MAX_MEME_PIXELS
        || image.naturalWidth > 8192 || image.naturalHeight > 8192 ? new Error('图片尺寸过大') : undefined);
      image.onerror = () => finish(new Error('图片无法解码'));
      if (signal.aborted) abort(); else image.src = url;
    });
    signal.throwIfAborted();
    return file;
  } finally { URL.revokeObjectURL(url); }
}
