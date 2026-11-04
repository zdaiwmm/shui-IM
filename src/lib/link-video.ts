import { uiLiteral } from './language';

export interface LinkClip {
  key: string;
  name: string;
  url: string;
  cover?: string;
  duration: number;
}
export { MAX_VIDEO_BYTES as LOCAL_VIDEO_LIMIT } from './message-payload';

export function postId(input: string): string | undefined {
  try {
    const u = new URL(input.trim());
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !/^(?:(?:www|mobile|m)\.)?(?:x|twitter)\.com$/.test(u.hostname)
    )
      return;
    return /^\/(?:\w+|i\/web)\/status\/(\d{1,20})(?:\/(?:video|photo)\/\d+)?\/?$/.exec(u.pathname)?.[1];
  } catch {
    return;
  }
}
function allowed(value: unknown, host: string): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const u = new URL(value);
    if (u.origin === 'https://' + host && !u.username && !u.password) return u.href;
  } catch {
    /* Unsupported media URL. */
  }
}
export async function directBlob(
  url: string,
  signal: AbortSignal,
  limit: number,
  progress?: (bytes: number, total: number) => void,
): Promise<Blob> {
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    cache: 'no-store',
  });
  if (!response.ok || !response.body) throw new Error(uiLiteral('无法直接读取视频来源'));
  const reader = response.body.getReader(),
    total = Number(response.headers.get('content-length')) || 0;
  let bytes = 0;
  const chunks: Blob[] = [];
  let pending: Uint8Array<ArrayBuffer>[] = [],
    pendingBytes = 0;
  try {
    if (total > limit) throw new Error(uiLiteral('超过本机下载大小限制'));
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error(uiLiteral('超过本机下载大小限制'));
      pending.push(part.value as Uint8Array<ArrayBuffer>);
      pendingBytes += part.value.byteLength;
      if (pendingBytes >= 2 ** 20) {
        chunks.push(new Blob(pending));
        pending = [];
        pendingBytes = 0;
      }
      progress?.(bytes, total);
    }
    if (
      !bytes ||
      (total &&
        !response.headers.get('content-encoding') &&
        total !== bytes &&
        url.startsWith('https://video.twimg.com/'))
    )
      throw new Error(uiLiteral('下载不完整，请重试'));
    if (pending.length) chunks.push(new Blob(pending));
    return new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
type WireVideo = { url?: unknown; thumbnail_url?: unknown; duration?: unknown; id?: unknown };
type WirePost = { id?: string; media?: { videos?: WireVideo[] }; quote?: WirePost };
export async function resolveClips(input: string, signal: AbortSignal): Promise<LinkClip[]> {
  const id = postId(input);
  if (!id) throw new Error(uiLiteral('请输入有效的 X 帖子链接'));
  const data = await directBlob('https://api.fxtwitter.com/status/' + id, signal, 512 * 1024);
  const { tweet, code } = JSON.parse(await data.text()) as { tweet?: WirePost; code: number };
  if (code !== 200 || tweet?.id !== id) throw new Error(uiLiteral('无法读取此公开帖子'));
  const clips: LinkClip[] = [];
  for (const node of [tweet, tweet.quote])
    for (const v of node?.media?.videos ?? []) {
      const url = allowed(v.url, 'video.twimg.com');
      if (!url || !new URL(url).pathname.endsWith('.mp4') || clips.some((c) => c.url === url)) continue;
      clips.push({
        key: new URL(url).pathname,
        name: 'X-' + id + '-' + (clips.length + 1) + '.mp4',
        url,
        cover: allowed(v.thumbnail_url, 'pbs.twimg.com'),
        duration: typeof v.duration === 'number' && Number.isFinite(v.duration) ? v.duration : 0,
      });
    }
  if (!clips.length) throw new Error(uiLiteral('帖子中没有可下载的视频'));
  return clips;
}
/** Reading only top-level headers keeps the original samples and their offsets intact. */
async function inspectMp4(file: Blob, signal: AbortSignal): Promise<number | undefined> {
  let offset = 0,
    keep = 0,
    boxes = 0;
  let movie = false,
    media = false;
  while (offset < file.size) {
    signal.throwIfAborted();
    if (++boxes > 65536) return;
    const header = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    if (header.byteLength < 8) return;
    const type = header.getUint32(4),
      short = header.getUint32(0);
    if (offset === 0 && type !== 0x66747970) return; // ftyp
    if (short === 1 && header.byteLength < 16) return;
    const length = short === 0 ? file.size - offset : short === 1 ? Number(header.getBigUint64(8)) : short;
    const headerSize = short === 1 ? 16 : 8;
    if (!Number.isSafeInteger(length) || length < headerSize || length > file.size - offset) return;
    offset += length;
    if (type === 0x6d6f6f76 && length > headerSize) movie = true; // moov
    if (type === 0x6d646174 && length > headerSize) media = true; // mdat
    if (type !== 0x66726565 && type !== 0x736b6970) keep = offset; // free, skip
  }
  signal.throwIfAborted();
  return movie && media ? keep : undefined;
}
export async function verifyMp4(blob: Blob, signal: AbortSignal): Promise<void> {
  if (!(await inspectMp4(blob, signal))) throw new Error(uiLiteral('本机视频校验失败'));
}
export async function compactMp4(file: File, signal: AbortSignal): Promise<File> {
  const keep = await inspectMp4(file, signal);
  if (!keep) throw new Error(uiLiteral('本机视频校验失败'));
  return keep < file.size
    ? new File([file.slice(0, keep)], file.name, { type: file.type, lastModified: file.lastModified })
    : file;
}
export async function clipSize(clip: LinkClip, signal: AbortSignal): Promise<number | undefined> {
  const response = await fetch(clip.url, {
    method: 'HEAD',
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  const size = Number(response.headers.get('content-length'));
  if (response.ok && Number.isSafeInteger(size) && size > 0) return size;
}
