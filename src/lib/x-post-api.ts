import { authorizedFetch } from './api';
import { parseXArticle, type XArticle } from './x-article-data.mjs';

type XPostRequest = { action: 'preview' | 'text' | 'article'; postId: string }
  | { action: 'playback'; postId: string; mediaId: string };

export async function requestXPost(roomId: string, token: string, request: XPostRequest, signal: AbortSignal): Promise<unknown> {
  const response = await authorizedFetch(`/api/rooms/${roomId}/x-post`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  return response.json();
}

export async function readXPostText(roomId: string, token: string, postId: string, signal: AbortSignal): Promise<string> {
  const result = await requestXPost(roomId, token, { action: 'text', postId }, signal) as { text?: unknown };
  if (typeof result?.text !== 'string' || !result.text || result.text.length > 50_000) throw new Error('Invalid X post text');
  return result.text;
}

export async function openXPostVideo(roomId: string, token: string, postId: string, mediaId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const connection = document.createElement('link');
  connection.rel = 'preconnect';
  connection.href = 'https://aix.shui.click';
  connection.crossOrigin = 'anonymous';
  document.head.append(connection);
  const result = await requestXPost(roomId, token, { action: 'playback', postId, mediaId }, signal)
    .finally(() => connection.remove()) as { url?: unknown };
  if (typeof result?.url !== 'string' || !/^https:\/\/aix\.shui\.click\/v1\/x\/media\/[A-Za-z0-9_-]{43}$/.test(result.url)) {
    throw new Error('Invalid X video playback URL');
  }
  return result.url;
}

export async function readXArticle(roomId: string, token: string, postId: string, signal: AbortSignal): Promise<XArticle> {
  const article = parseXArticle(await requestXPost(roomId, token, { action: 'article', postId }, signal));
  if (!article) throw new Error('Invalid X article');
  return article;
}
