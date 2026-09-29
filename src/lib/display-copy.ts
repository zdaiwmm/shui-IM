import { detectImageAnimation } from './image-animation';

type RgbaFrame = { rgba: Uint8ClampedArray; delayCs: number };
type DecodedImage = {
  close: () => void;
  displayWidth: number;
  displayHeight: number;
  duration: number | null;
};

const MAX_ANIMATED_PIXELS = 12_000_000;
const PLAYBACK_MAX_EDGE = 1280;
const PLAYBACK_BITRATE = 6_000_000;

function displayEdge(): number {
  const screenEdge = Math.max(globalThis.screen?.width ?? 390, globalThis.screen?.height ?? 844);
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 3);
  return Math.min(2048, Math.max(1024, Math.ceil(screenEdge * pixelRatio)));
}

function nearest(r: number, g: number, b: number, palette: number[][]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < palette.length; index += 1) {
    const color = palette[index]!;
    const distance = (r - color[0]!) ** 2 + (g - color[1]!) ** 2 + (b - color[2]!) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
      if (distance === 0) break;
    }
  }
  return best;
}

function paletteFromFrames(frames: RgbaFrame[], limit: number): number[][] {
  const exact = new Map<number, number[]>();
  for (const frame of frames) {
    const pixels = frame.rgba;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3]! < 128) continue;
      const key = (pixels[offset]! << 16) | (pixels[offset + 1]! << 8) | pixels[offset + 2]!;
      if (!exact.has(key)) exact.set(key, [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!]);
      if (exact.size > limit) break;
    }
    if (exact.size > limit) break;
  }
  if (exact.size > 0 && exact.size <= limit) return [...exact.values()];
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (const frame of frames) {
    const pixels = frame.rgba;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (pixels[offset + 3]! < 128) continue;
      const key = ((pixels[offset]! >> 3) << 10) | ((pixels[offset + 1]! >> 3) << 5) | (pixels[offset + 2]! >> 3);
      const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      bucket.r += pixels[offset]!;
      bucket.g += pixels[offset + 1]!;
      bucket.b += pixels[offset + 2]!;
      bucket.n += 1;
      buckets.set(key, bucket);
    }
  }
  return [...buckets.values()]
    .sort((left, right) => right.n - left.n)
    .slice(0, limit)
    .map(bucket => [Math.round(bucket.r / bucket.n), Math.round(bucket.g / bucket.n), Math.round(bucket.b / bucket.n)]);
}

function indexFrame(frame: RgbaFrame, palette: number[][], transparentIndex: number | null, width: number): Uint8Array {
  const source = new Float32Array(frame.rgba);
  const indexed = new Uint8Array(frame.rgba.length / 4);
  for (let offset = 0, pixel = 0; offset < source.length; offset += 4, pixel += 1) {
    if (source[offset + 3]! < 128) {
      indexed[pixel] = transparentIndex ?? 0;
      continue;
    }
    const red = Math.max(0, Math.min(255, source[offset]!));
    const green = Math.max(0, Math.min(255, source[offset + 1]!));
    const blue = Math.max(0, Math.min(255, source[offset + 2]!));
    const chosen = nearest(red, green, blue, palette);
    indexed[pixel] = chosen;
    const color = palette[chosen]!;
    const error = [red - color[0]!, green - color[1]!, blue - color[2]!];
    const x = pixel % width;
    const diffuse = (target: number, factor: number) => {
      if (target < 0 || target >= indexed.length || source[target * 4 + 3]! < 128) return;
      for (let channel = 0; channel < 3; channel += 1) source[target * 4 + channel]! += error[channel]! * factor;
    };
    if (x + 1 < width) diffuse(pixel + 1, 7 / 16);
    if (pixel + width < indexed.length) {
      if (x > 0) diffuse(pixel + width - 1, 3 / 16);
      diffuse(pixel + width, 5 / 16);
      if (x + 1 < width) diffuse(pixel + width + 1, 1 / 16);
    }
  }
  return indexed;
}

function lzw(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const dictionary = new Map<number, number>();
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  const reset = () => {
    dictionary.clear();
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  };
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  const write = (code: number) => {
    buffer |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      bytes.push(buffer & 255);
      buffer >>= 8;
      bits -= 8;
    }
  };
  write(clearCode);
  let code = indices[0] ?? 0;
  for (let index = 1; index < indices.length; index += 1) {
    const next = indices[index]!;
    const key = (code << 8) + next;
    const existing = dictionary.get(key);
    if (existing !== undefined) code = existing;
    else {
      write(code);
      if (nextCode < 4096) {
        dictionary.set(key, nextCode);
        nextCode += 1;
        if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
      } else {
        write(clearCode);
        reset();
      }
      code = next;
    }
  }
  write(code);
  write(endCode);
  if (bits > 0) bytes.push(buffer & 255);
  return bytes;
}

function subBlocks(minCodeSize: number, bytes: number[]): number[] {
  const output = [minCodeSize];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const slice = bytes.slice(offset, offset + 255);
    output.push(slice.length, ...slice);
  }
  output.push(0);
  return output;
}

/** Full-frame GIF89a. Returns bytes even when a later decode check should discard them. */
export function encodeAnimatedGif(width: number, height: number, frames: RgbaFrame[]): Uint8Array {
  const transparent = frames.some(frame => {
    for (let offset = 3; offset < frame.rgba.length; offset += 4) if (frame.rgba[offset]! < 128) return true;
    return false;
  });
  const colors = paletteFromFrames(frames, transparent ? 255 : 256);
  const usable = colors.length ? colors.slice(0, transparent ? 255 : 256) : [[0, 0, 0]];
  const transparentIndex = transparent ? usable.length : null;
  const palette = usable.slice();
  if (transparent) palette.push([0, 0, 0]);
  while (palette.length < 256) palette.push([0, 0, 0]);
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 255, width >> 8, height & 255, height >> 8, 0xf7, 0, 0];
  for (const color of palette) bytes.push(color[0]!, color[1]!, color[2]!);
  bytes.push(0x21, 0xff, 0x0b, ...[...'NETSCAPE2.0'].map(char => char.charCodeAt(0)), 0x03, 0x01, 0, 0, 0);
  for (const frame of frames) {
    const delay = Math.max(2, Math.min(65535, frame.delayCs));
    const packed = transparent ? 0x05 : 0x04;
    bytes.push(0x21, 0xf9, 0x04, packed, delay & 255, delay >> 8, transparentIndex ?? 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0);
    bytes.push(...subBlocks(8, lzw(indexFrame(frame, usable, transparentIndex, width), 8)));
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

async function readFrames(blob: Blob, width: number, height: number, signal?: AbortSignal): Promise<RgbaFrame[] | null> {
  const Decoder = (globalThis as { ImageDecoder?: new (init: { data: BufferSource; type: string }) => {
    close: () => void;
    tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
    decode: (options: { frameIndex: number }) => Promise<{ image: DecodedImage }>;
  } }).ImageDecoder;
  if (!Decoder || width * height <= 0) return null;
  const decoder = new Decoder({ data: await blob.arrayBuffer(), type: blob.type });
  try {
    await decoder.tracks.ready;
    signal?.throwIfAborted();
    const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
    if (count < 2 || width * height * count > MAX_ANIMATED_PIXELS) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    const frames: RgbaFrame[] = [];
    for (let index = 0; index < count; index += 1) {
      signal?.throwIfAborted();
      const { image } = await decoder.decode({ frameIndex: index });
      try {
        context.clearRect(0, 0, width, height);
        context.drawImage(image as CanvasImageSource, 0, 0, width, height);
        const delayMs = image.duration == null ? 100 : Math.max(20, image.duration / 1000);
        frames.push({ rgba: context.getImageData(0, 0, width, height).data, delayCs: Math.round(delayMs / 10) });
      } finally { image.close(); }
    }
    return frames;
  } finally {
    decoder.close();
    signal?.throwIfAborted();
  }
}

/** Smaller animated GIF for local display. Keeps every frame; discards itself if it is not smaller or will not decode. */
export async function createAnimatedDisplayCopy(blob: Blob, signal?: AbortSignal): Promise<Blob | null> {
  if (!['image/gif', 'image/png', 'image/webp'].includes(blob.type)) return null;
  let animated = false;
  try { animated = await detectImageAnimation(blob, signal); } catch { return null; }
  if (!animated) return null;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.src = url;
    await image.decode();
    signal?.throwIfAborted();
    const sourceEdge = Math.max(image.naturalWidth, image.naturalHeight);
    const edge = Math.min(sourceEdge, displayEdge());
    if (edge <= 0 || (edge === sourceEdge && blob.size < 1_500_000)) return null;
    const ratio = edge / sourceEdge;
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const frames = await readFrames(blob, width, height, signal);
    if (!frames || frames.length < 2) return null;
    const gif = encodeAnimatedGif(width, height, frames);
    const payload = new ArrayBuffer(gif.byteLength);
    new Uint8Array(payload).set(gif);
    const encoded = new Blob([payload], { type: 'image/gif' });
    if (encoded.size >= blob.size * 0.9) return null;
    const checkUrl = URL.createObjectURL(encoded);
    const check = new Image();
    try {
      check.src = checkUrl;
      await check.decode();
      if (check.naturalWidth !== width || !await detectImageAnimation(encoded, signal)) return null;
    } finally {
      check.removeAttribute('src');
      URL.revokeObjectURL(checkUrl);
    }
    return encoded;
  } catch {
    return null;
  } finally {
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}

/** High-bitrate local playback file. Long recordings stay on the original download path. */
export async function createVideoPlaybackCopy(blob: Blob, signal?: AbortSignal): Promise<Blob | null> {
  if (blob.size < 1_500_000 || typeof MediaRecorder === 'undefined') return null;
  const mimeType = MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
  if (!mimeType) return null;
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('video'));
    });
    signal?.throwIfAborted();
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 120) return null;
    const sourceEdge = Math.max(video.videoWidth, video.videoHeight);
    if (!sourceEdge) return null;
    const ratio = Math.min(1, PLAYBACK_MAX_EDGE / sourceEdge);
    if (ratio === 1 && blob.size < 8 * 1024 ** 2) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(video.videoWidth * ratio) & ~1);
    canvas.height = Math.max(2, Math.round(video.videoHeight * ratio) & ~1);
    const context = canvas.getContext('2d');
    if (!context) return null;
    const stream = canvas.captureStream(30);
    await video.play();
    const captured = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.() ?? null;
    for (const track of captured?.getAudioTracks() ?? []) stream.addTrack(track);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: PLAYBACK_BITRATE, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    const stopped = new Promise<void>(resolve => recorder.addEventListener('stop', () => resolve(), { once: true }));
    const abort = () => { video.pause(); if (recorder.state !== 'inactive') recorder.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    recorder.start(1000);
    await new Promise<void>(resolve => {
      const draw = () => {
        if (signal?.aborted || video.ended) { resolve(); return; }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        requestAnimationFrame(draw);
      };
      video.onended = () => resolve();
      draw();
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    signal?.removeEventListener('abort', abort);
    stream.getTracks().forEach(track => track.stop());
    captured?.getTracks().forEach(track => track.stop());
    canvas.width = canvas.height = 0;
    if (signal?.aborted) return null;
    const result = new Blob(chunks, { type: mimeType.split(';')[0] });
    return result.size > 0 && result.size < blob.size ? result : null;
  } catch {
    return null;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
