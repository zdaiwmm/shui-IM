import { describe, expect, it } from 'vitest';
import { VIDEO_AUTO_DOWNLOAD_BYTES, shouldAutoDownloadVideo, videoDurationLabel } from '../src/lib/video-download-policy';

describe('history video download policy', () => {
  it('requires consent at exactly 30 MiB and above, independently of cache capacity', () => {
    expect(VIDEO_AUTO_DOWNLOAD_BYTES).toBe(30 * 1024 * 1024);
    expect(shouldAutoDownloadVideo(VIDEO_AUTO_DOWNLOAD_BYTES - 1)).toBe(true);
    expect(shouldAutoDownloadVideo(VIDEO_AUTO_DOWNLOAD_BYTES)).toBe(false);
    expect(shouldAutoDownloadVideo(2 * 1024 ** 3)).toBe(false);
  });
  it.each([NaN, Infinity, -1, 0])('does not start an unknown or invalid size (%s)', size => {
    expect(shouldAutoDownloadVideo(size)).toBe(false);
  });
  it('displays actual metadata without making up a duration', () => {
    expect(videoDurationLabel(48_990)).toBe('00:48');
    expect(videoDurationLabel(3_661_100)).toBe('1:01:01');
    for (const duration of [undefined, 0, -1, NaN, Infinity]) expect(videoDurationLabel(duration)).toBe('—:—');
  });
});
