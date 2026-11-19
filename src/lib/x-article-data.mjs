const MAX_BODY_TEXT = 50_000;
const MAX_BLOCKS = 512;
const MAX_RUNS = 2048;
const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_IMAGES_BYTES = 768 * 1024;

const textBlocks = new Set(['paragraph', 'heading', 'quote', 'code', 'list-item']);
const styleKeys = ['bold', 'italic', 'underline', 'strike', 'code'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keysAre(value, keys) {
  return record(value) && Object.keys(value).every(key => keys.includes(key));
}

function text(value, limit, multiline = false) {
  return typeof value === 'string' && value.length <= limit
    && !(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value))
    && (multiline || !/[\t\n]/u.test(value));
}

function webLink(value) {
  if (!text(value, 2048) || !/^https?:\/\//i.test(value)) return false;
  const url = URL.parse(value);
  return Boolean(url && !url.username && !url.password);
}

export function xArticleMetadata(value) {
  if (!record(value) || !text(value.title, 300) || !value.title.trim()
    || !text(value.author, 300) || !value.author.trim()) return;
  return { title: value.title, author: value.author };
}

export function matchesJpegFrame(bytes, width, height) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216
    || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return false;
  let offset = 2, frame = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 216 || marker === 217 || marker === 220) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 218) return frame && length >= 6;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (frame || ![192, 193, 194].includes(marker) || length < 8 || bytes[offset + 2] !== 8
        || ((bytes[offset + 3] << 8) | bytes[offset + 4]) !== height
        || ((bytes[offset + 5] << 8) | bytes[offset + 6]) !== width) return false;
      const components = bytes[offset + 7];
      if (![1, 3].includes(components) || length !== 8 + 3 * components) return false;
      frame = true;
    }
    offset += length;
  }
  return false;
}

function imageSize(image, budget) {
  if (!keysAre(image, ['mimeType', 'data', 'width', 'height'])
    || image.mimeType !== 'image/jpeg' || typeof image.data !== 'string'
    || image.data.length > Math.ceil(Math.min(budget, MAX_IMAGE_BYTES) * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/.test(image.data)
    || !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 1600
    || !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 1600) return 0;
  try {
    const binary = atob(image.data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return bytes.length <= Math.min(budget, MAX_IMAGE_BYTES) && matchesJpegFrame(bytes, image.width, image.height) ? bytes.length : 0;
  } catch {
    return 0;
  }
}

export function parseXArticle(value) {
  if (!keysAre(value, ['title', 'author', 'blocks']) || !xArticleMetadata(value)
    || !Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS) return;
  let characters = 0, runs = 0, imageBytes = 0;
  for (const block of value.blocks) {
    if (!record(block)) return;
    if (textBlocks.has(block.kind)) {
      const keys = ['kind', 'runs'];
      if (block.kind === 'heading') {
        if (![2, 3, 4].includes(block.level)) return;
        keys.push('level');
      } else if (block.kind === 'list-item') {
        if (typeof block.ordered !== 'boolean' || !Number.isSafeInteger(block.depth) || block.depth < 0 || block.depth > 4) return;
        keys.push('ordered', 'depth');
      }
      if (!keysAre(block, keys) || !Array.isArray(block.runs)) return;
      runs += block.runs.length;
      if (runs > MAX_RUNS) return;
      for (const run of block.runs) {
        if (!keysAre(run, ['text', 'href', ...styleKeys]) || !text(run.text, MAX_BODY_TEXT - characters, true)
          || (run.href !== undefined && !webLink(run.href))
          || !styleKeys.every(key => run[key] === undefined || run[key] === true)) return;
        characters += run.text.length;
      }
    } else if (block.kind === 'image') {
      if (!keysAre(block, ['kind', 'alt', 'caption', 'image']) || !text(block.alt, 1000)
        || (block.caption !== undefined && !text(block.caption, 1000, true))) return;
      const size = imageSize(block.image, MAX_IMAGES_BYTES - imageBytes);
      if (!size) return;
      imageBytes += size;
    } else if (block.kind === 'link') {
      if (!keysAre(block, ['kind', 'href', 'label']) || !webLink(block.href) || !text(block.label, 300) || !block.label) return;
    } else if (block.kind !== 'divider' || !keysAre(block, ['kind'])) return;
  }
  return value;
}
