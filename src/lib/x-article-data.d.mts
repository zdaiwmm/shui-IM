export type XArticleSummary = { title: string; author: string };
export type XArticleRun = { text: string; href?: string; bold?: true; italic?: true; underline?: true; strike?: true; code?: true };
export type XArticleBlock =
  | { kind: 'paragraph' | 'quote' | 'code'; runs: XArticleRun[] }
  | { kind: 'heading'; level: 2 | 3 | 4; runs: XArticleRun[] }
  | { kind: 'list-item'; ordered: boolean; depth: number; runs: XArticleRun[] }
  | { kind: 'divider' }
  | { kind: 'image'; alt: string; caption?: string; image: { mimeType: 'image/jpeg'; data: string; width: number; height: number } }
  | { kind: 'link'; href: string; label: string };
export type XArticle = XArticleSummary & { blocks: XArticleBlock[] };
export function xArticleMetadata(value: unknown): XArticleSummary | undefined;
export function parseXArticle(value: unknown): XArticle | undefined;
export function matchesJpegFrame(bytes: Uint8Array, width: number, height: number): boolean;
