import { expect, it, vi } from 'vitest';
import { createYouTubeGateway, youtubeRequest } from '../server/x-post-gateway.mjs';
import { isLinkPreview, youtubeLinkPreview, youtubeVideoId } from '../src/lib/link-preview-data';

const videoId = 'TestVideo01';
const short = `https://youtu.be/${videoId}?si=tracking`;

it('keeps only the original validated public link in the encrypted payload', () => {
  for (const url of [short, `https://youtube.com/watch?v=${videoId}`, `https://m.youtube.com/shorts/${videoId}`]) {
    expect(youtubeVideoId(url)).toBe(videoId);
    const preview = youtubeLinkPreview(url);
    expect(isLinkPreview(preview, `Shared ${url}`)).toBe(true);
    expect(isLinkPreview({ ...preview, title: 'Upstream metadata' }, url)).toBe(false);
    expect(isLinkPreview({ ...preview, description: 'Upstream metadata' }, url)).toBe(false);
    expect(isLinkPreview(preview, 'https://example.org')).toBe(false);
  }
  for (const url of [`https://youtu.be.example/${videoId}`, `https://youtu.be:8443/${videoId}`,
    `https://youtube.com/watch?v=${videoId}&v=OtherTest01`, `https://youtube.com/watch?v=${videoId}&token=private`,
    'https://youtube.com/playlist?list=abc', 'https://youtube.com/post/abc']) {
    expect(youtubeVideoId(url)).toBeUndefined();
    expect(isLinkPreview(youtubeLinkPreview(url), url)).toBe(false);
  }
});

it('validates gateway requests and playback origins without forwarding external URLs', async () => {
  const packet = { action: 'preview', videoId };
  expect(youtubeRequest({ ...packet, url: short })).toBeUndefined();
  expect(youtubeRequest({ ...packet, videoId: 'https://youtube.com' })).toBeUndefined();
  expect(youtubeRequest(packet)).toEqual(packet);
  const token = 't'.repeat(43);
  const preview = { title: 'Title', channel: 'Channel', description: 'Description\nline 2', playable: true };
  const fetchImpl = vi.fn(async () => Response.json({ ...preview, url: short, roomId: 'ignored' }));
  const signal = new AbortController().signal;
  const gateway = createYouTubeGateway({ token, fetchImpl })!;
  expect(await gateway(packet, signal)).toEqual(preview);
  expect(fetchImpl).toHaveBeenCalledWith('https://aix.shui.click/v1/youtube/videos/lookup', expect.objectContaining({
    method: 'POST', redirect: 'error', body: JSON.stringify(packet),
  }));
  await expect(gateway({ ...packet, action: 'playback' }, signal)).rejects.toThrow('YOUTUBE_UNAVAILABLE');
  const ticket = `https://aix.shui.click/v1/youtube/media/${'a'.repeat(43)}`;
  fetchImpl.mockResolvedValueOnce(Response.json({ url: ticket }));
  expect(await gateway({ ...packet, action: 'playback' }, signal)).toEqual({ url: ticket });
});
