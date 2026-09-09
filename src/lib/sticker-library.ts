import type { MemeFavorite } from './meme-media';
const starters: { packs: StarterPack[]; gifs: MediaItem[] } = { packs: [], gifs: [] };

export type MediaKind = 'gifs' | 'stickers';
export type StickerPack = { id: string; title: string; items: MemeFavorite[]; installedAt: number };
export type MediaItem = { id: string; title: string; asset?: string; favorite?: MemeFavorite; pack?: string; animatedOnly?: boolean };
export type StarterPack = { id: string; title: string; items: MediaItem[] };
export type RemotePack = { id: string; title: string; cover: string };
export type MediaSearchResult = { items: MediaItem[]; packs?: RemotePack[]; nextPage: number | null; source?: string };
export type RemotePackDetail = { id: string; title: string; items: MediaItem[] };
export const starterPacks: StarterPack[] = starters.packs;
export const starterGifs: MediaItem[] = starters.gifs;
export const MAX_STICKER_PACKS = 20;
export const MAX_PACK_ITEMS = 200;
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_PACK_LIBRARY_BYTES = 256 * 1024 * 1024;

export const STARTER_CACHE = 'quiet-room-starter-media-v1';
const starterAssets = new Map([...starters.packs.flatMap(pack => pack.items), ...starters.gifs].map(item => [item.asset, item]));
let warming: Promise<void> | undefined;
let warmed = false;

/** Only shipped, content-addressed public assets may enter this plaintext cache. */
export async function starterMedia(asset: string, signal: AbortSignal): Promise<Blob> {
  if (!starterAssets.has(asset)) throw new Error('未知预置表情');
  signal.throwIfAborted();
  const cache = await caches.open(STARTER_CACHE).catch(() => null);
  const metadata = starterAssets.get(asset)!;
  const valid = async (blob: Blob) => {
    if (blob.size !== metadata.size) return false;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    signal.throwIfAborted(); return digest === metadata.digest;
  };
  const cached = await cache?.match(asset);
  if (cached) {
    const blob = await cached.blob(); if (await valid(blob)) return blob;
    await cache?.delete(asset);
  }
  const response = await fetch(asset, { credentials: 'omit', cache: 'force-cache', signal });
  if (!response.ok || response.redirected) throw new Error('预置表情加载失败');
  const blob = await response.blob(); if (!await valid(blob)) throw new Error('预置表情校验失败');
  signal.throwIfAborted(); await cache?.put(asset, new Response(blob, { headers: { 'Content-Type': blob.type } })).catch(() => undefined);
  return blob;
}

export function warmStarterMedia(signal: AbortSignal): void {
  if (warming || warmed) return;
  warming = (async () => {
    const assets = [...starterAssets.keys()];
    const worker = async () => {
      while (assets.length && !signal.aborted) {
        const asset = assets.shift()!;
        try { await starterMedia(asset, signal); } catch { return false; }
      }
      return !signal.aborted;
    };
    warmed = (await Promise.all([worker(), worker()])).every(Boolean);
  })().finally(() => { warming = undefined; });
}
