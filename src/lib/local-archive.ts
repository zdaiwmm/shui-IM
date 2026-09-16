import { fromBase64Url } from './base64';

/** Binary framing is independent of ZIP paths and never interprets filenames. */
const MAGIC = new TextEncoder().encode('QRLOCAL1');
const HEADER_SIZE = 40; // magic (8), salt (24), nonce prefix (8)
export const LOCAL_ARCHIVE_RECORD_LIMIT = 3 * 1024 * 1024;
export const LOCAL_ARCHIVE_SIZE_LIMIT = 8 * 1024 * 1024 * 1024;
export const LOCAL_ARCHIVE_RECORD_COUNT_LIMIT = 200_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export type ArchiveSink = { write: (bytes: Uint8Array<ArrayBuffer>) => Promise<void> };
export type ArchiveRecord = { type: number; bytes: Uint8Array<ArrayBuffer> };
export class LocalArchiveError extends Error {
  constructor(readonly code: 'FORMAT' | 'LIMIT' | 'AUTHENTICATION' | 'TRUNCATED' | 'VERSION') {
    super(({ FORMAT: '聊天备份文件格式不正确', LIMIT: '聊天备份超过安全处理上限',
      AUTHENTICATION: '聊天备份无法验证，文件可能已损坏或不属于此恢复身份',
      TRUNCATED: '聊天备份不完整', VERSION: '此聊天备份版本暂不支持' })[code]);
  }
}

async function keyFor(secret: string, header: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const raw = fromBase64Url(secret);
  if (raw.length !== 32) throw new LocalArchiveError('AUTHENTICATION');
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: header.slice(8, 32),
      info: encoder.encode('quiet-room-local-history-v1') }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { raw.fill(0); }
}

function parameters(header: Uint8Array<ArrayBuffer>, index: number) {
  const iv = new Uint8Array(12);
  iv.set(header.subarray(32), 0);
  new DataView(iv.buffer).setUint32(8, index);
  const aad = new Uint8Array(HEADER_SIZE + 4);
  aad.set(header);
  new DataView(aad.buffer).setUint32(HEADER_SIZE, index);
  return { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 };
}

/** Each compressed record has a hard output bound, including decompression bombs. */
async function transform(bytes: Uint8Array<ArrayBuffer>, decompress: boolean, signal: AbortSignal) {
  const stream = new Blob([bytes]).stream().pipeThrough(decompress
    ? new DecompressionStream('gzip') : new CompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > LOCAL_ARCHIVE_RECORD_LIMIT + 65536) throw new LocalArchiveError('LIMIT');
      chunks.push(new Uint8Array(item.value));
    }
    signal.throwIfAborted();
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
    signal.removeEventListener('abort', abort);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** A unique salt gives each export a distinct key. Counter nonces never repeat within it. */
export async function writeLocalArchive(
  secret: string, records: AsyncIterable<ArchiveRecord>, sink: ArchiveSink, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const header = crypto.getRandomValues(new Uint8Array(HEADER_SIZE));
  header.set(MAGIC);
  const key = await keyFor(secret, header);
  let total = HEADER_SIZE;
  let index = 0;
  await sink.write(header);
  async function write(type: number, bytes: Uint8Array<ArrayBuffer>) {
    signal.throwIfAborted();
    if (bytes.byteLength > LOCAL_ARCHIVE_RECORD_LIMIT || index > LOCAL_ARCHIVE_RECORD_COUNT_LIMIT) throw new LocalArchiveError('LIMIT');
    const compressed = await transform(bytes, false, signal);
    const plaintext = new Uint8Array(compressed.length + 1);
    plaintext[0] = type;
    plaintext.set(compressed, 1);
    compressed.fill(0);
    try {
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(parameters(header, index), key, plaintext));
      const frame = new Uint8Array(4);
      new DataView(frame.buffer).setUint32(0, ciphertext.length);
      total += 4 + ciphertext.length;
      if (total > LOCAL_ARCHIVE_SIZE_LIMIT) throw new LocalArchiveError('LIMIT');
      signal.throwIfAborted();
      await sink.write(frame);
      await sink.write(ciphertext);
      index++;
    } finally { plaintext.fill(0); }
  }
  for await (const record of records) {
    if (!Number.isInteger(record.type) || record.type < 1 || record.type > 254) throw new LocalArchiveError('FORMAT');
    await write(record.type, record.bytes);
  }
  // Position-authenticated terminator prevents prefix truncation, reordering and concatenation.
  await write(255, encoder.encode(String(index)));
}

/** Consumers must finish one complete validation pass before committing any imported data. */
export async function* readLocalArchive(
  file: Blob, secret: string, signal: AbortSignal,
): AsyncGenerator<ArchiveRecord> {
  if (file.size > LOCAL_ARCHIVE_SIZE_LIMIT) throw new LocalArchiveError('LIMIT');
  if (file.size < HEADER_SIZE) throw new LocalArchiveError('TRUNCATED');
  const header = new Uint8Array(await file.slice(0, HEADER_SIZE).arrayBuffer());
  if (!MAGIC.every((byte, i) => header[i] === byte)) throw new LocalArchiveError('VERSION');
  const key = await keyFor(secret, header);
  let offset = HEADER_SIZE;
  let index = 0;
  let expanded = 0;
  while (offset < file.size) {
    signal.throwIfAborted();
    if (index > LOCAL_ARCHIVE_RECORD_COUNT_LIMIT) throw new LocalArchiveError('LIMIT');
    if (offset + 4 > file.size) throw new LocalArchiveError('TRUNCATED');
    const length = new DataView(await file.slice(offset, offset + 4).arrayBuffer()).getUint32(0);
    if (length < 17 || length > LOCAL_ARCHIVE_RECORD_LIMIT + 65536 + 17) throw new LocalArchiveError('LIMIT');
    offset += 4;
    if (offset + length > file.size) throw new LocalArchiveError('TRUNCATED');
    const ciphertext = await file.slice(offset, offset + length).arrayBuffer();
    offset += length;
    let plaintext: Uint8Array<ArrayBuffer>;
    try { plaintext = new Uint8Array(await crypto.subtle.decrypt(parameters(header, index), key, ciphertext)); }
    catch { throw new LocalArchiveError('AUTHENTICATION'); }
    const type = plaintext[0]!;
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = await transform(plaintext.slice(1), true, signal); }
    finally { plaintext.fill(0); }
    expanded += bytes.length;
    if (bytes.length > LOCAL_ARCHIVE_RECORD_LIMIT || expanded > LOCAL_ARCHIVE_SIZE_LIMIT) {
      bytes.fill(0); throw new LocalArchiveError('LIMIT');
    }
    if (type === 255) {
      try {
        if (decoder.decode(bytes) !== String(index) || offset !== file.size) throw new LocalArchiveError('FORMAT');
        return;
      } finally { bytes.fill(0); }
    }
    if (type < 1 || type > 254) { bytes.fill(0); throw new LocalArchiveError('FORMAT'); }
    try { yield { type, bytes }; } finally { bytes.fill(0); }
    index++;
  }
  throw new LocalArchiveError('TRUNCATED');
}
