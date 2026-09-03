import { describe, expect, it } from 'vitest';
import { randomBase64Url } from '../src/lib/base64';
import {
  IMAGE_CHUNK_SIZE,
  isImageManifest,
  isMessagePayload,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_TEXT_LENGTH,
} from '../src/lib/message-payload';

function imageManifest() {
  return {
    v: 1,
    blobId: crypto.randomUUID(),
    key: randomBase64Url(32),
    ivPrefix: randomBase64Url(8),
    chunkSize: IMAGE_CHUNK_SIZE,
    chunkCount: 1,
    originalSize: 12,
    originalName: 'photo.png',
    mimeType: 'image/png',
    lastModified: 1_700_000_000_000,
    sha256: 'a'.repeat(64),
  };
}

describe('shared encrypted message payload validation', () => {
  it('accepts valid text and image payloads but rejects unknown fields', () => {
    const text = { v: 1, kind: 'text', text: 'hello', sentAt: new Date().toISOString() };
    expect(isMessagePayload(text)).toBe(true);
    expect(isMessagePayload({ ...text, debug: true })).toBe(false);
    expect(isImageManifest(imageManifest())).toBe(true);
    expect(isMessagePayload({ v: 1, kind: 'image', image: imageManifest(), sentAt: text.sentAt })).toBe(true);
  });

  it('rejects oversized, malformed, and unsafe image metadata', () => {
    const manifest = imageManifest();
    expect(isImageManifest({ ...manifest, originalSize: MAX_IMAGE_BYTES + 1 })).toBe(false);
    expect(isImageManifest({ ...manifest, mimeType: 'text/html' })).toBe(false);
    expect(isImageManifest({ ...manifest, blobId: 'not-a-v4-uuid' })).toBe(false);
    expect(isImageManifest({ ...manifest, originalName: 'bad\u0000name.png' })).toBe(false);
    expect(isMessagePayload({ v: 1, kind: 'text', text: 'x'.repeat(MAX_MESSAGE_TEXT_LENGTH + 1), sentAt: manifest.lastModified })).toBe(false);
  });
});
