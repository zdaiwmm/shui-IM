import { fromBase64Url } from './base64';
import { matchesJpegFrame } from './x-article-data.mjs';
import { firstPreviewUrl, previewableUrl, webUrl } from './web-links';

export const LINK_PREVIEW_CAPABILITY = 'link-preview-v1';
export const X_POST_PREVIEW_CAPABILITY = 'x-post-preview-v1';
export const PREVIEW_IMAGE_BYTES = 16 * 1024;
export const MAX_X_POST_VIDEOS = 4;
export const X_ARTICLE_SOURCE = 'X Article · ';
export type PreviewImage = { mimeType: 'image/jpeg'; data: string; width: number; height: number };
export type XPostVideoPreview = { id: string; durationMs?: number; poster?: PreviewImage };
export type XPostPreview = { id: string; canRead: boolean; videos: XPostVideoPreview[] };
export type LinkPreview = {
  url: string; siteName: string; title: string; description: string;
  layout: 'large' | 'compact' | 'text'; image?: PreviewImage; xPost?: XPostPreview;
};

const X_POST_HOSTS = new Set(['x.com', 'www.x.com', 'm.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'm.twitter.com', 'mobile.twitter.com']);
const X_POST_PATH = /^\/(?:[A-Za-z0-9_]{1,15}\/|i\/web\/)?status\/(\d{1,20})(?:\/(?:video|photo)\/\d+)?\/?$/;

function xLinkPath(value: string): string | undefined {
  const normalized = previewableUrl(value);
  if (!normalized) return undefined;
  const url = new URL(normalized);
  if (!X_POST_HOSTS.has(url.hostname) || url.port) return undefined;
  return url.pathname;
}

export function xPostId(value: string): string | undefined {
  const path = xLinkPath(value);
  return path ? X_POST_PATH.exec(path)?.[1] : undefined;
}

export function xDirectArticleId(value: string): string | undefined {
  const path = xLinkPath(value);
  return path ? /^\/(?:i|[A-Za-z0-9_]{1,15})\/article\/(\d{1,20})\/?$/.exec(path)?.[1] : undefined;
}

export function xArticleAuthor(preview: LinkPreview): string | undefined {
  return preview.xPost && preview.siteName.startsWith(X_ARTICLE_SOURCE)
    ? preview.siteName.slice(X_ARTICLE_SOURCE.length) || undefined : undefined;
}

export function isXPostMediaId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value);
}

export function isXPostVideoDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 24 * 60 * 60 * 1000;
}

function cleanText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
}

function previewImageSize(image: PreviewImage): number {
  return Math.floor(image.data.length * 3 / 4);
}

function isXPostPreview(value: unknown, url: string, imageBytes: number): value is XPostPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const post = value as Record<string, unknown>;
  if (Object.keys(post).some(key => !['id','canRead','videos'].includes(key))
    || typeof post.id !== 'string' || xPostId(url) !== post.id || typeof post.canRead !== 'boolean'
    || !Array.isArray(post.videos) || post.videos.length > MAX_X_POST_VIDEOS) return false;
  const mediaIds = new Set<string>();
  for (const value of post.videos) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const video = value as Record<string, unknown>;
    if (Object.keys(video).some(key => !['id','durationMs','poster'].includes(key))
      || !isXPostMediaId(video.id) || mediaIds.has(video.id)
      || (video.durationMs !== undefined && !isXPostVideoDuration(video.durationMs))) return false;
    mediaIds.add(video.id);
    if (video.poster !== undefined) {
      if (!isPreviewImage(video.poster)) return false;
      imageBytes += previewImageSize(video.poster);
      if (imageBytes > PREVIEW_IMAGE_BYTES) return false;
    }
  }
  return true;
}

export function isLinkPreview(value: unknown, messageText?: string): value is LinkPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !['url','siteName','title','description','layout','image','xPost'].includes(key))
    || typeof p.url !== 'string' || webUrl(p.url) !== p.url
    || (messageText !== undefined && firstPreviewUrl(messageText) !== p.url)
    || !cleanText(p.siteName, 100) || !p.siteName.trim() || !cleanText(p.title, 300) || !p.title.trim()
    || !cleanText(p.description, 600) || typeof p.layout !== 'string' || !['large','compact','text'].includes(p.layout)) return false;
  let imageBytes = 0;
  if (p.image === undefined) {
    if (p.layout !== 'text') return false;
  } else {
    if (p.layout === 'text' || !isPreviewImage(p.image)) return false;
    imageBytes = previewImageSize(p.image);
  }
  return p.xPost === undefined || isXPostPreview(p.xPost, p.url, imageBytes);
}

export function isPreviewImage(value: unknown): value is PreviewImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  if (Object.keys(image).some(key => !['mimeType','data','width','height'].includes(key))
    || image.mimeType !== 'image/jpeg' || typeof image.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(image.data)
    || image.data.length > Math.ceil(PREVIEW_IMAGE_BYTES * 4 / 3)
    || !Number.isInteger(image.width) || Number(image.width) < 1 || Number(image.width) > 640
    || !Number.isInteger(image.height) || Number(image.height) < 1 || Number(image.height) > 640) return false;
  try {
    const bytes = fromBase64Url(image.data);
    return bytes.length <= PREVIEW_IMAGE_BYTES && matchesJpegFrame(bytes, Number(image.width), Number(image.height));
  } catch { return false; }
}

/** Metadata is not evidence that a square image is an avatar; only known icon sources force compact. */
export function previewLayout(source: 'content' | 'icon', width: number, height: number): 'large' | 'compact' {
  return source === 'content' && width >= 480 && height >= 240 && width / height >= .5 && width / height <= 3 ? 'large' : 'compact';
}
