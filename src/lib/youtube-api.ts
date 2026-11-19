import { authorizedFetch } from './api';

export async function requestYouTube(roomId: string, token: string, videoId: string,
  action: 'preview' | 'playback', signal: AbortSignal): Promise<unknown> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/youtube-video`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, action }), cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(16_000)]),
  });
  return response.json();
}

export async function openYouTubeVideo(roomId: string, token: string, videoId: string, signal: AbortSignal): Promise<string> {
  const result = await requestYouTube(roomId, token, videoId, 'playback', signal) as { url?: unknown };
  if (typeof result?.url !== 'string' || !/^https:\/\/aix\.shui\.click\/v1\/youtube\/media\/[A-Za-z0-9_-]{43}$/.test(result.url)) {
    throw new Error('Invalid YouTube playback URL');
  }
  return result.url;
}
