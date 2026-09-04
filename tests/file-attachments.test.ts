import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { randomBase64Url } from '../src/lib/base64';
import { decryptFileAttachment, encryptFileAttachment, encryptImageFile } from '../src/lib/file-crypto';
import { IMAGE_CHUNK_SIZE, isFileManifest, isImageManifest, isMessagePayload, MAX_IMAGE_BYTES } from '../src/lib/message-payload';
import type { FileManifest, ImageUploadPlan } from '../src/lib/types';

function fileManifest(): FileManifest {
  return {
    v: 1, blobId: crypto.randomUUID(), key: randomBase64Url(32), ivPrefix: randomBase64Url(8),
    chunkSize: IMAGE_CHUNK_SIZE, chunkCount: 1, originalSize: 12,
    originalName: 'report.pdf', mimeType: 'application/pdf', lastModified: 1_700_000_000_000,
    sha256: 'a'.repeat(64),
  };
}

function memoryTransport() {
  const state: { chunks: Map<number, ArrayBuffer>; plan?: ImageUploadPlan; completed: boolean } = {
    chunks: new Map(), completed: false,
  };
  const callbacks: Parameters<typeof encryptFileAttachment>[1] = {
    reserve: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ uploadedIndexes: [...state.chunks.keys()], completed: state.completed })),
    upload: vi.fn(async (_blobId, index, bytes) => { state.chunks.set(index, bytes); }),
    complete: vi.fn(async () => { state.completed = true; }),
    savePlan: vi.fn(async (plan) => { state.plan = plan; }),
  };
  return { state, callbacks, fetch: vi.fn(async (_blobId: string, index: number) => state.chunks.get(index)!) };
}

function localFile(bytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3, 4]), type = 'application/pdf'): File {
  return new File([bytes], 'report.pdf', { type, lastModified: 1_700_000_000_000 });
}

describe('generic file payload validation', () => {
  it('accepts arbitrary and empty MIME types while preserving image-only validation', () => {
    for (const mimeType of ['application/pdf', 'application/zip', 'text/plain', 'video/mp4', 'audio/mpeg', 'application/x-custom', '']) {
      const manifest = { ...fileManifest(), mimeType };
      expect(isFileManifest(manifest)).toBe(true);
      expect(isImageManifest(manifest)).toBe(false);
    }
    expect(isFileManifest({ ...fileManifest(), mimeType: 'image/png' })).toBe(true);
    expect(isFileManifest({ ...fileManifest(), originalSize: MAX_IMAGE_BYTES, chunkCount: 128 })).toBe(true);
  });

  it('rejects unsafe metadata and malformed encryption or chunk parameters', () => {
    const invalid = [
      { mimeType: 'application/pdf\r\nx-custom: injected' }, { mimeType: '\u0000' }, { mimeType: '\u007f' },
      { mimeType: 'a'.repeat(256) }, { mimeType: null },
      { originalName: 'unsafe\u0000.pdf' }, { originalName: 'a'.repeat(1025) },
      { originalSize: 0 }, { originalSize: MAX_IMAGE_BYTES + 1 }, { originalSize: 1.5 },
      { chunkCount: 0 }, { chunkCount: 129 }, { chunkCount: 2 }, { chunkSize: 1024 },
      { key: randomBase64Url(16) }, { ivPrefix: randomBase64Url(12) },
      { blobId: 'invalid' }, { sha256: 'invalid' }, { lastModified: -1 }, { v: 2 }, { debug: true },
    ];
    for (const patch of invalid) expect(isFileManifest({ ...fileManifest(), ...patch })).toBe(false);
  });

  it('accepts v1 files and v2 file replies while keeping gallery files reply-free', () => {
    const payload = { v: 1, kind: 'file', file: fileManifest(), sentAt: new Date().toISOString() };
    const replyTo = {
      clientMsgId: crypto.randomUUID(), serverSeq: 1, senderId: crypto.randomUUID(), kind: 'file', preview: '文件：report.pdf',
    };
    expect(isMessagePayload(payload)).toBe(true);
    expect(isMessagePayload({ ...payload, v: 2, replyTo })).toBe(true);
    expect(isMessagePayload({ ...payload, kind: 'gallery-file' })).toBe(true);
    expect(isMessagePayload({ v: 2, kind: 'text', text: '收到', sentAt: payload.sentAt, replyTo })).toBe(true);
    expect(isMessagePayload({ ...payload, replyTo })).toBe(false);
    expect(isMessagePayload({ ...payload, v: 2 })).toBe(false);
    expect(isMessagePayload({ ...payload, v: 2, replyTo: { ...replyTo, kind: 'gallery-file' } })).toBe(false);
    expect(isMessagePayload({ ...payload, kind: 'gallery-file', v: 2, replyTo })).toBe(false);
    expect(isMessagePayload({ ...payload, kind: 'gallery-file', replyTo })).toBe(false);
    expect(isMessagePayload({ ...payload, debug: true })).toBe(false);
    expect(isMessagePayload({ ...payload, file: { ...payload.file, mimeType: '\n' } })).toBe(false);
  });
});

describe('generic file encryption', () => {
  it.each([
    ['report.pdf', 'application/pdf'], ['archive.zip', 'application/zip'],
    ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['note.txt', 'text/plain'], ['movie.mp4', 'video/mp4'], ['song.mp3', 'audio/mpeg'], ['unknown.custom', ''],
  ])('round-trips original bytes and metadata for %s', async (name, type) => {
    const bytes = new Uint8Array([0, 255, 60, 62, 13, 10, 37, 18]);
    const file = new File([bytes], name, { type, lastModified: 1_700_000_000_000 });
    const transport = memoryTransport();
    const manifest = await encryptFileAttachment(file, transport.callbacks);
    expect(isFileManifest(manifest)).toBe(true);
    expect(manifest).toMatchObject({ originalName: name, mimeType: type, originalSize: bytes.length, lastModified: file.lastModified });
    const restored = await decryptFileAttachment(manifest, transport.fetch);
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes);
    expect(restored.type).toBe(type || 'application/octet-stream');
  });

  it('resumes only missing chunks with the same key, IV, blob ID, and file hash', async () => {
    const bytes = new Uint8Array(IMAGE_CHUNK_SIZE + 125).map((_, index) => index % 251);
    const file = localFile(bytes);
    const transport = memoryTransport();
    const normalUpload = transport.callbacks.upload;
    await expect(encryptFileAttachment(file, {
      ...transport.callbacks,
      upload: async (blobId, index, chunk) => {
        if (index === 1) throw new Error('offline');
        await normalUpload(blobId, index, chunk);
      },
    })).rejects.toThrow('offline');
    const plan = transport.state.plan!;
    expect(plan.v).toBe(2);
    vi.mocked(normalUpload).mockClear();
    const manifest = await encryptFileAttachment(file, transport.callbacks, plan);
    expect(normalUpload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(normalUpload).mock.calls[0]?.[1]).toBe(1);
    expect(manifest).toMatchObject({ blobId: plan.blobId, key: plan.key, ivPrefix: plan.ivPrefix });
    expect(plan.v === 2 && plan.plaintextSha256).toBe(manifest.sha256);
    expect(transport.callbacks.reserve).toHaveBeenLastCalledWith(manifest.blobId, 2, file.size + 32);
    const restored = Buffer.from(await (await decryptFileAttachment(manifest, transport.fetch)).arrayBuffer());
    expect(restored.byteLength).toBe(bytes.byteLength);
    // Compare every byte natively; generic deep equality walks over two million
    // indexed properties and can exhaust the CI timeout before reporting success.
    expect(restored.equals(bytes), 'Resumed download must preserve every original byte').toBe(true);
  });

  it('rejects changed file bytes, metadata, and damaged or legacy resume plans before touching remote state', async () => {
    const file = localFile();
    const initial = memoryTransport();
    await encryptFileAttachment(file, initial.callbacks);
    const plan = initial.state.plan!;
    if (plan.v !== 2) throw new Error('expected hashed upload plan');
    const { plaintextSha256: _hash, ...legacy } = plan;
    const cases: Array<{ file: File; plan: ImageUploadPlan; error: string }> = [
      { file: localFile(new Uint8Array([4, 3, 2, 1])), plan, error: '内容与待续传文件不一致' },
      { file: localFile(undefined, 'application/zip'), plan, error: '与待续传文件不一致' },
      { file, plan: { ...plan, originalName: 'different.pdf' }, error: '与待续传文件不一致' },
      { file, plan: { ...plan, plaintextSha256: 'bad' }, error: '内容校验已损坏' },
      { file, plan: { ...plan, key: randomBase64Url(16) }, error: '密钥已损坏' },
      { file, plan: { ...plan, ivPrefix: randomBase64Url(4) }, error: '参数已损坏' },
      { file, plan: { ...legacy, v: 1 }, error: '缺少内容校验' },
    ];
    for (const candidate of cases) {
      const transport = memoryTransport();
      await expect(encryptFileAttachment(candidate.file, transport.callbacks, candidate.plan)).rejects.toThrow(candidate.error);
      expect(transport.callbacks.savePlan).not.toHaveBeenCalled();
      expect(transport.callbacks.reserve).not.toHaveBeenCalled();
      expect(transport.callbacks.upload).not.toHaveBeenCalled();
    }
  });

  it('detects modified and truncated ciphertext and a mismatched plaintext checksum', async () => {
    const transport = memoryTransport();
    const manifest = await encryptFileAttachment(localFile(), transport.callbacks);
    const original = transport.state.chunks.get(0)!;
    const changed = new Uint8Array(original.slice(0));
    changed[0] = changed[0]! ^ 1;
    await expect(decryptFileAttachment(manifest, async () => changed.buffer)).rejects.toThrow();
    await expect(decryptFileAttachment(manifest, async () => original.slice(1))).rejects.toThrow('分块长度不正确');
    await expect(decryptFileAttachment({ ...manifest, sha256: '0'.repeat(64) }, transport.fetch)).rejects.toThrow('完整性校验失败');
    transport.fetch.mockClear();
    await expect(decryptFileAttachment({ ...manifest, mimeType: '\n' }, transport.fetch)).rejects.toThrow('清单不受支持');
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('rejects empty, oversized, or unsafe files before upload while keeping image uploads image-only', async () => {
    const oversize = localFile();
    Object.defineProperty(oversize, 'size', { value: MAX_IMAGE_BYTES + 1 });
    const unsafeMime = localFile();
    Object.defineProperty(unsafeMime, 'type', { value: 'application/pdf\r\nunsafe' });
    const invalidFiles = [
      new File([], 'empty.txt'), oversize, unsafeMime,
      new File(['x'], 'bad\u0000.pdf'), new File(['x'], 'a'.repeat(1025)),
      new File(['x'], 'report.pdf', { type: 'a'.repeat(256) }),
    ];
    for (const file of invalidFiles) {
      const transport = memoryTransport();
      await expect(encryptFileAttachment(file, transport.callbacks)).rejects.toThrow();
      expect(transport.callbacks.savePlan).not.toHaveBeenCalled();
      expect(transport.callbacks.reserve).not.toHaveBeenCalled();
    }
    await expect(encryptImageFile(localFile(), memoryTransport().callbacks)).rejects.toThrow('请选择图片文件');
  });
});
