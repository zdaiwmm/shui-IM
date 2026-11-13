import { isSelectedVideo, isVideoFile } from './video-media';
import { atFaultStage } from './fault-report';
import { uiLiteral, uiTemplate } from './language';
import { VoiceNetworkError } from './voice-network';
import { createSHA256 } from 'hash-wasm';
import { canonicalStringify } from './canonical';
import { fromBase64Url, toBase64Url } from './base64';
import { IMAGE_CHUNK_SIZE, isImageManifest, MAX_VIDEO_BYTES, MAX_IMAGE_BYTES, isAudioManifest, isAudioMimeType, MAX_AUDIO_BYTES, isFileManifest, MAX_IMAGE_NAME_LENGTH, MAX_IMAGE_MIME_LENGTH } from './message-payload';
import type { FileManifest, ImageManifest, ImageUploadPlan, ImageUploadPlanV2 } from './types';
import { readMediaDimensions } from './media-dimensions';

export { IMAGE_CHUNK_SIZE, MAX_IMAGE_BYTES } from './message-payload';
const encoder = new TextEncoder();

function chunkIv(prefix: Uint8Array<ArrayBuffer>, index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}

function chunkAad(blobId: string, index: number, chunkCount: number, originalSize: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(canonicalStringify({
    v: 1,
    blobId,
    index,
    chunkCount,
    originalSize,
  }));
}

async function hashFile(file: File, signal?: AbortSignal): Promise<string> {
  const hash = await createSHA256();
  hash.init();
  for (let offset = 0; offset < file.size; offset += IMAGE_CHUNK_SIZE) {
    signal?.throwIfAborted();
    const end = Math.min(offset + IMAGE_CHUNK_SIZE, file.size);
    hash.update(new Uint8Array(await atFaultStage('upload.read',file.slice(offset, end).arrayBuffer())));
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
}

async function encryptAttachmentFile(
  file: File,
  callbacks: {
    reserve: (blobId: string, chunkCount: number, encryptedSize: number) => Promise<void>;
    status: (blobId: string) => Promise<{ uploadedIndexes: number[]; completed: boolean }>;
    upload: (blobId: string, index: number, bytes: ArrayBuffer) => Promise<void>;
    cacheCiphertext?: (blobId: string, index: number, bytes: ArrayBuffer) => Promise<void>;
    complete: (blobId: string) => Promise<void>;
    savePlan: (plan: ImageUploadPlan) => Promise<void>;
    /** Persist a complete encrypted-send intent before detached transport. */
    encrypted?: (manifest: ImageManifest) => Promise<void>;
    started?: () => void;
    progress?: (ratio: number) => void;
    signal?: AbortSignal;
    includeDimensions?: boolean;
  },
  existingPlan?: ImageUploadPlan,
  kind: 'image' | 'audio' | 'file' = 'image',
): Promise<ImageManifest> {
  callbacks.signal?.throwIfAborted();
  if (kind === 'audio') {
    if (!isAudioMimeType(file.type)) throw new Error(uiLiteral('录音格式不受支持，请更新浏览器'));
    if (!file.size || file.size > MAX_AUDIO_BYTES) throw new Error(uiLiteral('录音为空或超过 16 MiB，请重新录制'));
  } else if (kind === 'image' && !file.type.startsWith('image/')) throw new Error(uiLiteral('请选择图片文件'));
  const fileLabel = kind === 'file' ? uiLiteral('文件') : uiLiteral('图片');
  if (file.size === 0) throw new Error(kind === 'file' ? uiLiteral('文件为空') : uiLiteral('图片文件为空'));
  if (kind === 'file' && isSelectedVideo(file)) {
    if (file.size > MAX_VIDEO_BYTES) throw new Error(uiLiteral('单个视频不能超过 2 GiB'));
  } else if (file.size > MAX_IMAGE_BYTES) throw new Error(uiTemplate`${fileLabel}不能超过 256 MB`);
  if (kind === 'file' && (
    file.name.length > MAX_IMAGE_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(file.name) ||
    file.type.length > MAX_IMAGE_MIME_LENGTH || /[\u0000-\u001f\u007f]/.test(file.type)
  )) throw new Error(uiLiteral('文件名称或格式信息不受支持'));
  // Start metadata decoding beside hashing/upload, but always observe its
  // rejection so a later upload failure cannot leave an unhandled abort.
  const dimensionsPromise = (callbacks.includeDimensions
    ? readMediaDimensions(file, callbacks.signal)
    : Promise.resolve(undefined)
  ).then(
    (dimensions) => ({ dimensions }),
    (error: unknown) => ({ error }),
  );
  const chunkCount = Math.ceil(file.size / IMAGE_CHUNK_SIZE);
  if (existingPlan?.v === 1) {
    throw new Error(uiTemplate`旧版${fileLabel}续传计划缺少内容校验，不能安全复用`);
  }
  const plaintextSha256 = await hashFile(file, callbacks.signal);
  if (existingPlan) {
    const matchesMetadata =
      existingPlan.originalSize === file.size &&
      existingPlan.originalName === file.name &&
      existingPlan.mimeType === file.type &&
      existingPlan.lastModified === file.lastModified &&
      existingPlan.chunkCount === chunkCount &&
      existingPlan.encryptedSize === file.size + 16 * chunkCount;
    if (!matchesMetadata) throw new Error(uiTemplate`所选${fileLabel}与待续传文件不一致`);
    if (!/^[0-9a-f]{64}$/i.test(existingPlan.plaintextSha256)) {
      throw new Error(uiTemplate`${fileLabel}续传内容校验已损坏`);
    }
    if (existingPlan.plaintextSha256 !== plaintextSha256) {
      throw new Error(uiTemplate`所选${fileLabel}内容与待续传文件不一致`);
    }
  }

  const plan: ImageUploadPlanV2 = existingPlan ?? {
    v: 2,
    blobId: crypto.randomUUID(),
    key: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    ivPrefix: toBase64Url(crypto.getRandomValues(new Uint8Array(8))),
    chunkCount,
    encryptedSize: file.size + 16 * chunkCount,
    originalSize: file.size,
    originalName: file.name,
    mimeType: file.type,
    lastModified: file.lastModified,
    plaintextSha256,
  };
  const keyBytes = fromBase64Url(plan.key);
  if (keyBytes.length !== 32) throw new Error(uiTemplate`${fileLabel}续传密钥已损坏`);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const ivPrefix = fromBase64Url(plan.ivPrefix);
  if (ivPrefix.length !== 8) throw new Error(uiTemplate`${fileLabel}续传参数已损坏`);
  await atFaultStage('upload.plan',callbacks.savePlan(plan));
  callbacks.signal?.throwIfAborted();
  callbacks.started?.();
  await atFaultStage('upload.reserve',callbacks.reserve(plan.blobId, chunkCount, plan.encryptedSize));
  callbacks.signal?.throwIfAborted();
  const remote = await atFaultStage('upload.status',callbacks.status(plan.blobId));
  const uploaded = new Set(remote.uploadedIndexes);
  for (let index = 0; index < chunkCount; index += 1) {
    callbacks.signal?.throwIfAborted();
    const start = index * IMAGE_CHUNK_SIZE;
    const end = Math.min(start + IMAGE_CHUNK_SIZE, file.size);
    const plaintext = new Uint8Array(await atFaultStage('upload.read',file.slice(start, end).arrayBuffer()));
    if (!uploaded.has(index) || callbacks.cacheCiphertext) {
      const ciphertext = await atFaultStage('upload.encrypt',crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: chunkIv(ivPrefix, index),
          additionalData: chunkAad(plan.blobId, index, chunkCount, file.size),
          tagLength: 128,
        },
        key,
        plaintext,
      ));
      if (!uploaded.has(index)) await atFaultStage('upload.chunk',callbacks.upload(plan.blobId, index, ciphertext));
      callbacks.signal?.throwIfAborted();
      await callbacks.cacheCiphertext?.(plan.blobId, index, ciphertext);
      callbacks.signal?.throwIfAborted();
    }
    callbacks.progress?.((index + 1) / chunkCount);
  }
  const dimensionsResult = await dimensionsPromise;
  if ('error' in dimensionsResult) throw dimensionsResult.error;
  const { dimensions } = dimensionsResult;
  callbacks.signal?.throwIfAborted();

  const manifest: ImageManifest = {
    v: 1,
    ...dimensions,
    blobId: plan.blobId,
    key: plan.key,
    ivPrefix: plan.ivPrefix,
    chunkSize: IMAGE_CHUNK_SIZE,
    chunkCount,
    originalSize: file.size,
    originalName: file.name,
    mimeType: file.type,
    lastModified: file.lastModified,
    sha256: plaintextSha256,
  };
  await callbacks.encrypted?.(manifest);
  callbacks.signal?.throwIfAborted();
  if (!remote.completed) await atFaultStage('upload.complete',callbacks.complete(plan.blobId));
  return manifest;
}

type UploadCallbacks = Parameters<typeof encryptAttachmentFile>[1];

export function encryptImageFile(file: File, callbacks: UploadCallbacks, plan?: ImageUploadPlan): Promise<ImageManifest> {
  return encryptAttachmentFile(file, callbacks, plan, 'image');
}

export function encryptAudioFile(file: File, callbacks: UploadCallbacks, plan?: ImageUploadPlan): Promise<ImageManifest> {
  return encryptAttachmentFile(file, callbacks, plan, 'audio');
}

export function encryptFileAttachment(file: File, callbacks: UploadCallbacks, plan?: ImageUploadPlan): Promise<FileManifest> {
  return encryptAttachmentFile(file, callbacks, plan, 'file');
}

export class VideoBufferUnavailable extends Error {
  constructor() { super(uiLiteral('本机无法准备完整视频，请释放空间或使用普通浏览窗口后重试')); }
}

async function decryptAttachmentFile(
  manifest: ImageManifest,
  fetchChunk: (blobId: string, index: number) => Promise<ArrayBuffer>,
  progress?: (ratio: number) => void,
  signal?: AbortSignal,
  kind: 'image' | 'audio' | 'file' = 'image',
): Promise<Blob> {
  signal?.throwIfAborted();
  if (!(kind === 'image' ? isImageManifest(manifest) : kind === 'audio' ? isAudioManifest(manifest) : isFileManifest(manifest))) {
    throw new Error(uiLiteral('附件清单不受支持'));
  }
  const key = await crypto.subtle.importKey('raw', fromBase64Url(manifest.key), { name: 'AES-GCM' }, false, ['decrypt']);
  const ivPrefix = fromBase64Url(manifest.ivPrefix);
  if (ivPrefix.length !== 8) throw new Error(uiLiteral('图片加密参数不正确'));
  const hash = await createSHA256();
  hash.init();
  let totalSize = 0;
  const readVerifiedChunk = async (index: number) => {
    signal?.throwIfAborted();
    const ciphertext = await fetchChunk(manifest.blobId, index);
    signal?.throwIfAborted();
    const expectedSize = Math.min(manifest.chunkSize, manifest.originalSize - index * manifest.chunkSize);
    if (ciphertext.byteLength !== expectedSize + 16) throw new Error(uiLiteral('附件分块长度不正确'));
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: chunkIv(ivPrefix, index),
        additionalData: chunkAad(manifest.blobId, index, manifest.chunkCount, manifest.originalSize),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    const bytes = new Uint8Array(plaintext);
    totalSize += bytes.length;
    hash.update(bytes);
    if (index + 1 === manifest.chunkCount && (totalSize !== manifest.originalSize || hash.digest('hex') !== manifest.sha256)) {
      throw new Error(uiLiteral('附件完整性校验失败'));
    }
    progress?.((index + 1) / manifest.chunkCount);
    return bytes;
  };

  const type = manifest.mimeType || 'application/octet-stream';
  if (manifest.originalSize <= 128 * 1024 ** 2 || kind !== 'file' || !isVideoFile(manifest)) {
    const parts: BlobPart[] = [];
    for (let index = 0; index < manifest.chunkCount; index++) parts.push(await readVerifiedChunk(index));
    return new Blob(parts, { type });
  }

  // A single backpressured stream lets the browser spool a large Blob. A list
  // of independent small Blobs can exhaust Chromium's backing store at 2 GiB.
  let next = 0;
  let sourceError: unknown;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        controller.enqueue(await readVerifiedChunk(next++));
        if (next === manifest.chunkCount) controller.close();
      } catch (error) {
        sourceError = error;
        controller.error(error);
      }
    },
  });
  try {
    const blob = await new Response(body).blob();
    signal?.throwIfAborted();
    // Some private browsers report the expected size even for an unreadable Blob.
    if (blob.size !== manifest.originalSize || (await blob.slice(-1).arrayBuffer()).byteLength !== 1) throw new VideoBufferUnavailable();
    return blob.slice(0, blob.size, type);
  } catch {
    signal?.throwIfAborted();
    if (sourceError) throw sourceError;
    throw new VideoBufferUnavailable();
  }
}

export function decryptImageFile(manifest: ImageManifest, fetchChunk: FetchChunk, progress?: (ratio: number) => void, signal?: AbortSignal): Promise<Blob> {
  return decryptAttachmentFile(manifest, fetchChunk, progress, signal, 'image');
}

type FetchChunk = (blobId: string, index: number) => Promise<ArrayBuffer>;

export async function decryptAudioFile(manifest: ImageManifest, fetchChunk: FetchChunk, progress?: (ratio: number) => void, signal?: AbortSignal): Promise<Blob> {
  let fetchFailure: unknown;
  try {
    return await decryptAttachmentFile(manifest, async (blobId, index) => {
      try { return await fetchChunk(blobId, index); } catch (error) { fetchFailure = error; throw error; }
    }, progress, signal, 'audio');
  } catch (error) {
    if (signal?.aborted || error === fetchFailure) throw error;
    throw new VoiceNetworkError('VOICE_DECRYPT_FAILED');
  }
}

export function decryptFileAttachment(manifest: FileManifest, fetchChunk: FetchChunk, progress?: (ratio: number) => void, signal?: AbortSignal): Promise<Blob> {
  return decryptAttachmentFile(manifest, fetchChunk, progress, signal, 'file');
}
