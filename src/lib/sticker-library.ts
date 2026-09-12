import type { MemeFavorite } from './meme-media';

export type MediaKind = 'gifs' | 'stickers';
export type StickerPack = { id: string; title: string; items: MemeFavorite[]; installedAt: number; autoHide?: boolean };
export type MediaItem = { id: string; title: string; favorite?: MemeFavorite; pack?: string; animatedOnly?: boolean; autoHide?: boolean };
export type RemotePack = { id: string; title: string; cover: string; autoHide?: boolean };
export type MediaSearchResult = { items: MediaItem[]; packs?: RemotePack[]; nextPage: number | null; source?: string };
export type RemotePackDetail = { id: string; title: string; items: MediaItem[]; autoHide?: boolean };
export const MAX_STICKER_PACKS = 20;
export const MAX_PACK_ITEMS = 200;
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
export const MAX_PACK_LIBRARY_BYTES = 256 * 1024 * 1024;
