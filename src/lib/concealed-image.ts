const MAX_SIDE = 128;

/** Two separable Gaussian passes over one bounded, premultiplied RGBA buffer. */
export function blurConcealedPixels(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_SIDE || height > MAX_SIDE || pixels.length !== width * height * 4) {
    throw new Error('Invalid concealed preview dimensions');
  }
  // Equivalent to 48px at the 288px chat preview size; clamp edges, never tiles.
  const sigma = Math.max(width, height) / 6;
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-((index - radius) ** 2) / (2 * sigma ** 2)));
  const sum = kernel.reduce((total, weight) => total + weight, 0);
  const weights = kernel.map(weight => weight / sum);
  let source = Float32Array.from(pixels, (value, index) => index % 4 === 3 ? value : value * pixels[index - index % 4 + 3]! / 255);
  for (const horizontal of [true, false]) {
    const target = new Float32Array(pixels.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const destination = (y * width + x) * 4;
      for (let offset = -radius; offset <= radius; offset++) {
        const sx = horizontal ? Math.max(0, Math.min(width - 1, x + offset)) : x;
        const sy = horizontal ? y : Math.max(0, Math.min(height - 1, y + offset));
        const start = (sy * width + sx) * 4;
        const weight = weights[offset + radius]!;
        for (let channel = 0; channel < 4; channel++) target[destination + channel]! += source[start + channel]! * weight;
      }
    }
    source = target;
  }
  return Uint8ClampedArray.from(source, (value, index) => {
    const alpha = source[index - index % 4 + 3]!;
    return index % 4 === 3 ? value : alpha > 0 ? value * 255 / alpha : 0;
  });
}

/** The caller supplies an already verified and decoded local image. */
export async function createConcealedImage(image: HTMLImageElement, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尚未解码');
  const ratio = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('图片预览不可用');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    pixels.data.set(blurConcealedPixels(pixels.data, canvas.width, canvas.height));
    context.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    signal?.throwIfAborted();
    if (!blob) throw new Error('图片预览不可用');
    return blob;
  } finally { canvas.width = canvas.height = 0; }
}
