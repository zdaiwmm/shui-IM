import { fromBase64Url } from './base64';
import { firstPreviewUrl, webUrl } from './web-links';

export const LINK_PREVIEW_CAPABILITY = 'link-preview-v1';
export const PREVIEW_IMAGE_BYTES = 16 * 1024;
export type PreviewImage = { mimeType: 'image/jpeg'; data: string; width: number; height: number };
export type LinkPreview = {
  url: string; siteName: string; title: string; description: string;
  layout: 'large' | 'compact' | 'text'; image?: PreviewImage;
};

function cleanText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
}

export function isLinkPreview(value: unknown, messageText?: string): value is LinkPreview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => !['url','siteName','title','description','layout','image'].includes(key))
    || typeof p.url !== 'string' || webUrl(p.url) !== p.url
    || (messageText !== undefined && firstPreviewUrl(messageText) !== p.url)
    || !cleanText(p.siteName, 100) || !p.siteName.trim() || !cleanText(p.title, 300) || !p.title.trim()
    || !cleanText(p.description, 600) || typeof p.layout !== 'string' || !['large','compact','text'].includes(p.layout)) return false;
  if (p.image === undefined) return p.layout === 'text';
  if (p.layout === 'text' || !p.image || typeof p.image !== 'object' || Array.isArray(p.image)) return false;
  const image = p.image as Record<string, unknown>;
  if (Object.keys(image).some(key => !['mimeType','data','width','height'].includes(key))
    || image.mimeType !== 'image/jpeg' || typeof image.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(image.data)
    || image.data.length > Math.ceil(PREVIEW_IMAGE_BYTES * 4 / 3)
    || !Number.isInteger(image.width) || Number(image.width) < 1 || Number(image.width) > 640
    || !Number.isInteger(image.height) || Number(image.height) < 1 || Number(image.height) > 640) return false;
  try {
    const bytes = fromBase64Url(image.data);
    return bytes.length >= 4 && bytes.length <= PREVIEW_IMAGE_BYTES && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  } catch { return false; }
}

/** Metadata is not evidence that a square image is an avatar; only known icon sources force compact. */
export function previewLayout(source: 'content' | 'icon', width: number, height: number): 'large' | 'compact' {
  return source === 'content' && width >= 480 && height >= 240 && width / height >= .5 && width / height <= 3 ? 'large' : 'compact';
}
