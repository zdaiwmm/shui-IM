/** Only formats proven static are re-encoded; animated/unknown media keep originals. */
export async function createMediaPreview(blob: Blob, signal?: AbortSignal): Promise<Blob | null> {
  if (!['image/jpeg', 'image/png'].includes(blob.type)) return null;
  if (blob.type === 'image/png') {
    const data = new DataView(await blob.arrayBuffer());
    let offset = 8, staticImage = false;
    while (offset + 12 <= data.byteLength) {
      const size = data.getUint32(offset), type = data.getUint32(offset + 4);
      if (size > data.byteLength - offset - 12 || type === 0x6163544c) return null;
      if (type === 0x49444154) { staticImage = true; break; }
      offset += size + 12;
    }
    if (!staticImage) return null;
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
      const result = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
      signal?.throwIfAborted(); return result;
    } finally { canvas.width = canvas.height = 0; }
  } finally { image.removeAttribute('src'); URL.revokeObjectURL(url); }
}
