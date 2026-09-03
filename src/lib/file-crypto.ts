import { createSHA256 } from 'hash-wasm';
import { canonicalStringify } from './canonical';
import { fromBase64Url, toBase64Url } from './base64';
import { IMAGE_CHUNK_SIZE, isImageManifest, MAX_IMAGE_BYTES } from './message-payload';
import type { ImageManifest, ImageUploadPlan, ImageUploadPlanV2 } from './types';

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
    hash.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
  }
  signal?.throwIfAborted();
  return hash.digest('hex');
}

export async function encryptImageFile(
  file: File,
  callbacks: {
    reserve: (blobId: string, chunkCount: number, encryptedSize: number) => Promise<void>;
    status: (blobId: string) => Promise<{ uploadedIndexes: number[]; completed: boolean }>;
    upload: (blobId: string, index: number, bytes: ArrayBuffer) => Promise<void>;
    complete: (blobId: string) => Promise<void>;
    savePlan: (plan: ImageUploadPlan) => Promise<void>;
    progress?: (ratio: number) => void;
    signal?: AbortSignal;
  },
  existingPlan?: ImageUploadPlan,
): Promise<ImageManifest> {
  callbacks.signal?.throwIfAborted();
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size === 0) throw new Error('图片文件为空');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 256 MB');
  const chunkCount = Math.ceil(file.size / IMAGE_CHUNK_SIZE);
  if (existingPlan?.v === 1) {
    throw new Error('旧版图片续传计划缺少内容校验，不能安全复用');
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
    if (!matchesMetadata) throw new Error('所选图片与待续传文件不一致');
    if (!/^[0-9a-f]{64}$/i.test(existingPlan.plaintextSha256)) {
      throw new Error('图片续传内容校验已损坏');
    }
    if (existingPlan.plaintextSha256 !== plaintextSha256) {
      throw new Error('所选图片内容与待续传文件不一致');
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
  if (keyBytes.length !== 32) throw new Error('图片续传密钥已损坏');
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const ivPrefix = fromBase64Url(plan.ivPrefix);
  if (ivPrefix.length !== 8) throw new Error('图片续传参数已损坏');
  await callbacks.savePlan(plan);
  callbacks.signal?.throwIfAborted();
  await callbacks.reserve(plan.blobId, chunkCount, plan.encryptedSize);
  callbacks.signal?.throwIfAborted();
  const remote = await callbacks.status(plan.blobId);
  const uploaded = new Set(remote.uploadedIndexes);
  for (let index = 0; index < chunkCount; index += 1) {
    callbacks.signal?.throwIfAborted();
    const start = index * IMAGE_CHUNK_SIZE;
    const end = Math.min(start + IMAGE_CHUNK_SIZE, file.size);
    const plaintext = new Uint8Array(await file.slice(start, end).arrayBuffer());
    if (!uploaded.has(index)) {
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: chunkIv(ivPrefix, index),
          additionalData: chunkAad(plan.blobId, index, chunkCount, file.size),
          tagLength: 128,
        },
        key,
        plaintext,
      );
      await callbacks.upload(plan.blobId, index, ciphertext);
      callbacks.signal?.throwIfAborted();
    }
    callbacks.progress?.((index + 1) / chunkCount);
  }
  if (!remote.completed) await callbacks.complete(plan.blobId);

  return {
    v: 1,
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
}

export async function decryptImageFile(
  manifest: ImageManifest,
  fetchChunk: (blobId: string, index: number) => Promise<ArrayBuffer>,
  progress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  if (!isImageManifest(manifest)) {
    throw new Error('图片清单不受支持');
  }
  const key = await crypto.subtle.importKey('raw', fromBase64Url(manifest.key), { name: 'AES-GCM' }, false, ['decrypt']);
  const ivPrefix = fromBase64Url(manifest.ivPrefix);
  if (ivPrefix.length !== 8) throw new Error('图片加密参数不正确');
  const hash = await createSHA256();
  hash.init();
  const parts: BlobPart[] = [];
  let totalSize = 0;

  for (let index = 0; index < manifest.chunkCount; index += 1) {
    signal?.throwIfAborted();
    const ciphertext = await fetchChunk(manifest.blobId, index);
    signal?.throwIfAborted();
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
    parts.push(bytes);
    progress?.((index + 1) / manifest.chunkCount);
  }

  if (totalSize !== manifest.originalSize || hash.digest('hex') !== manifest.sha256) {
    throw new Error('图片完整性校验失败');
  }
  return new Blob(parts, { type: manifest.mimeType || 'application/octet-stream' });
}
