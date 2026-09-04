import { describe, expect, it } from 'vitest';
import { randomBase64Url } from '../src/lib/base64';
import {
  IMAGE_CHUNK_SIZE,
  isImageManifest,
  isMessagePayload,
  MAX_IMAGE_ALBUM_BYTES,
  MAX_IMAGE_ALBUM_ITEMS,
  MAX_IMAGE_BYTES,
  MIN_IMAGE_ALBUM_ITEMS,
  MAX_MESSAGE_TEXT_LENGTH,
} from '../src/lib/message-payload';
import { REACTION_EMOJIS } from '../src/lib/reactions';

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

  it('keeps reply references inside a strictly validated encrypted payload', () => {
    const reply = {
      v: 2,
      kind: 'text',
      text: '收到',
      sentAt: new Date().toISOString(),
      replyTo: {
        clientMsgId: crypto.randomUUID(),
        serverSeq: 12,
        senderId: crypto.randomUUID(),
        kind: 'text',
        preview: '这是被回复消息的本地摘要',
      },
    };
    expect(isMessagePayload(reply)).toBe(true);
    expect(isMessagePayload({ ...reply, replyTo: { ...reply.replyTo, serverSeq: 0 } })).toBe(false);
    expect(isMessagePayload({ ...reply, replyTo: { ...reply.replyTo, preview: 'x'.repeat(161) } })).toBe(false);
    expect(isMessagePayload({ ...reply, replyTo: { ...reply.replyTo, leaked: true } })).toBe(false);
    expect(isMessagePayload({
      v: 2,
      kind: 'image',
      image: imageManifest(),
      sentAt: reply.sentAt,
      replyTo: { ...reply.replyTo, kind: 'image', preview: '图片' },
    })).toBe(true);
  });

  it('accepts bounded encrypted reaction changes and removal, and rejects untrusted target metadata', () => {
    const reaction = {
      v: 1,
      kind: 'reaction',
      sentAt: new Date().toISOString(),
      target: { clientMsgId: crypto.randomUUID(), serverSeq: 12, senderId: crypto.randomUUID() },
      emoji: '❤️',
    };
    for (const emoji of [...REACTION_EMOJIS, null]) expect(isMessagePayload({ ...reaction, emoji })).toBe(true);
    for (const emoji of ['', '❤', '❤️'.repeat(500), '<img src=x>', 1, undefined]) {
      expect(isMessagePayload({ ...reaction, emoji })).toBe(false);
    }
    for (const serverSeq of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12']) {
      expect(isMessagePayload({ ...reaction, target: { ...reaction.target, serverSeq } })).toBe(false);
    }
    for (const key of ['clientMsgId', 'senderId']) {
      expect(isMessagePayload({ ...reaction, target: { ...reaction.target, [key]: 'not-a-v4-uuid' } })).toBe(false);
    }
    expect(isMessagePayload({ ...reaction, target: { ...reaction.target, preview: 'leaked text' } })).toBe(false);
    expect(isMessagePayload({ ...reaction, target: null })).toBe(false);
    expect(isMessagePayload({ ...reaction, v: 2 })).toBe(false);
    expect(isMessagePayload({ ...reaction, sentAt: 'not-a-date' })).toBe(false);
    expect(isMessagePayload({ ...reaction, debug: true })).toBe(false);
    expect(isMessagePayload({ ...reaction, replyTo: reaction.target })).toBe(false);
  });

  it('accepts one encrypted album message containing two through nine unique image manifests', () => {
    const sentAt = new Date().toISOString();
    const minimum = Array.from({ length: MIN_IMAGE_ALBUM_ITEMS }, () => imageManifest());
    const maximum = Array.from({ length: MAX_IMAGE_ALBUM_ITEMS }, () => imageManifest());
    expect(isMessagePayload({ v: 1, kind: 'image-album', images: minimum, sentAt })).toBe(true);
    expect(isMessagePayload({
      v: 2,
      kind: 'image-album',
      images: maximum,
      sentAt,
      replyTo: {
        clientMsgId: crypto.randomUUID(),
        serverSeq: 4,
        senderId: crypto.randomUUID(),
        kind: 'image',
        preview: '图片',
      },
    })).toBe(true);
  });

  it('rejects malformed album cardinality, duplicate blobs, reply versions, and unknown fields', () => {
    const sentAt = new Date().toISOString();
    const first = imageManifest();
    const second = imageManifest();
    const replyTo = {
      clientMsgId: crypto.randomUUID(),
      serverSeq: 4,
      senderId: crypto.randomUUID(),
      kind: 'image',
      preview: '2 张图片',
    };
    expect(isMessagePayload({ v: 1, kind: 'image-album', images: [first], sentAt })).toBe(false);
    expect(isMessagePayload({
      v: 1,
      kind: 'image-album',
      images: Array.from({ length: MAX_IMAGE_ALBUM_ITEMS + 1 }, () => imageManifest()),
      sentAt,
    })).toBe(false);
    expect(isMessagePayload({ v: 1, kind: 'image-album', images: [first, first], sentAt })).toBe(false);
    expect(isMessagePayload({
      v: 1,
      kind: 'image-album',
      images: [
        {
          ...first,
          chunkCount: Math.ceil((MAX_IMAGE_ALBUM_BYTES - 1) / IMAGE_CHUNK_SIZE),
          originalSize: MAX_IMAGE_ALBUM_BYTES - 1,
        },
        { ...second, originalSize: 2 },
      ],
      sentAt,
    })).toBe(false);
    expect(isMessagePayload({ v: 1, kind: 'image-album', images: [{ ...first, debug: true }, second], sentAt })).toBe(false);
    expect(isMessagePayload({ v: 1, kind: 'image-album', images: [first, second], sentAt, replyTo })).toBe(false);
    expect(isMessagePayload({ v: 2, kind: 'image-album', images: [first, second], sentAt })).toBe(false);
    expect(isMessagePayload({ v: 1, kind: 'image-album', images: [first, second], sentAt, debug: true })).toBe(false);
  });
});
