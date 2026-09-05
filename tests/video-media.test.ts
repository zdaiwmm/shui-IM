import { describe, expect, it } from 'vitest';
import { isGalleryMediaPayload, isVideoFile, videoMimeType } from '../src/lib/video-media';
import type { ImageManifest, MessagePayload } from '../src/lib/types';

describe('video attachment classification', () => {
  it.each([
    ['video/mp4', 'clip.bin', 'video/mp4'],
    ['VIDEO/WEBM', 'clip', 'video/webm'],
    ['video/mp4; codecs="avc1.42E01E"', 'clip.mp4', 'video/mp4; codecs="avc1.42E01E"'],
    ['', 'clip.MP4', 'video/mp4'],
    ['application/octet-stream', 'clip.mov', 'video/quicktime'],
    ['', 'clip.m4v', 'video/mp4'],
    ['', 'clip.webm', 'video/webm'],
    ['', 'clip.ogv', 'video/ogg'],
    ['', 'clip.mkv', 'video/x-matroska'],
    ['', 'clip.avi', 'video/x-msvideo'],
    ['', 'clip.3gp', 'video/3gpp'],
    ['', 'clip.3g2', 'video/3gpp2'],
  ])('identifies %s / %s without changing the manifest', (mimeType, originalName, expected) => {
    const manifest = Object.freeze({ mimeType, originalName });
    expect(videoMimeType(manifest)).toBe(expected);
    expect(isVideoFile(manifest)).toBe(true);
    expect(manifest).toEqual({ mimeType, originalName });
  });

  it.each([
    ['text/html', 'page.mp4'], ['application/pdf', 'report.mov'], ['image/png', 'photo.webm'],
    ['audio/mp4', 'sound.mp4'], ['', 'clip.mp4.html'], ['', 'clip'], ['', 'page.html'],
    ['application/octet-stream', 'clip.unsupported'], ['video/', 'clip.mp4'],
    ['video/mp4\r\ntext/html', 'clip.mp4'], ['', 'clip.mp4?download'], ['', 'clip.mp4/'],
  ])('keeps %s / %s outside video previews', (mimeType, originalName) => {
    expect(videoMimeType({ mimeType, originalName })).toBeNull();
    expect(isVideoFile({ mimeType, originalName })).toBe(false);
  });

  it('adds every chat attachment to the existing safe payload categories', () => {
    const image: ImageManifest = { v: 1, blobId: 'blob', key: 'key', ivPrefix: 'iv', chunkSize: 2097152,
      chunkCount: 1, originalSize: 1, originalName: 'photo.png', mimeType: 'image/png', lastModified: 1, sha256: 'hash' };
    const base = { v: 1 as const, sentAt: '2026-09-04T00:00:00.000Z' };
    const video = { ...image, originalName: 'clip.mp4', mimeType: 'video/mp4' };
    const document = { ...image, originalName: 'report.pdf', mimeType: 'application/pdf' };
    const included: MessagePayload[] = [
      { ...base, kind: 'image', image }, { ...base, kind: 'image-album', images: [image, { ...image, blobId: 'other' }] },
      { ...base, kind: 'gallery-image', image }, { ...base, kind: 'gallery-file', file: document },
      { ...base, kind: 'gallery-file', file: video }, { ...base, kind: 'file', file: video },
      { ...base, kind: 'file', file: { ...video, mimeType: '' } },
    ];
    for (const payload of included) expect(isGalleryMediaPayload(payload)).toBe(true);
    expect(isGalleryMediaPayload({ ...base, kind: 'file', file: document })).toBe(true);
    expect(isGalleryMediaPayload({ ...base, kind: 'file', file: { ...video, mimeType: 'text/html' } })).toBe(true);
    expect(isGalleryMediaPayload({ ...base, kind: 'text', text: 'ordinary chat' })).toBe(false);
  });
});
