import { ZipReader, Uint8ArrayReader, configure, type FileEntry } from '@zip.js/zip.js';
import wasmURI from '@zip.js/zip.js/dist/zip-module.wasm?url&no-inline';

configure({ wasmURI, useWebWorkers: false });

const entries = new Map<string, FileEntry>();
let reader: ZipReader<Uint8Array> | undefined;
let queue = Promise.resolve();

async function handle(data: { id: number; bytes?: Uint8Array; path?: string; limit?: number }): Promise<void> {
  try {
    if (data.bytes) {
      if (reader || data.bytes.byteLength > 32 * 1024 * 1024) throw new Error('ARCHIVE_LIMIT');
      reader = new ZipReader(new Uint8ArrayReader(data.bytes), { useWebWorkers: false, strictness: 'strict', checkCrc32: true });
      let size = 0, count = 0;
      for await (const entry of reader.getEntriesGenerator()) {
        const name = entry.filename;
        if (++count > 1000 || name.length > 1024 || /[\\\u0000-\u001f]/.test(name)
          || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')
          || entries.has(name) || entry.encrypted) throw new Error('INVALID_ARCHIVE');
        if (entry.directory) continue;
        size += entry.uncompressedSize;
        if (entry.uncompressedSize > 16 * 1024 * 1024 || size > 128 * 1024 * 1024) throw new Error('ARCHIVE_LIMIT');
        entries.set(name, entry);
      }
      self.postMessage({ id: data.id, value: [...entries.keys()] });
    } else {
      const entry = entries.get(data.path ?? '');
      const limit = Math.min(data.limit ?? 0, 16 * 1024 * 1024);
      if (!entry || entry.uncompressedSize > limit) throw new Error('ENTRY_LIMIT');
      const chunks: Uint8Array[] = [];
      let size = 0;
      // Enforce the actual output limit, including archives with forged size headers.
      await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
        size += chunk.byteLength;
        if (size > limit) throw new Error('ENTRY_LIMIT');
        chunks.push(chunk);
      } }));
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      self.postMessage({ id: data.id, value: bytes }, { transfer: [bytes.buffer] });
    }
  } catch { self.postMessage({ id: data.id, error: true }); }
}

self.onmessage = event => { queue = queue.then(() => handle(event.data)); };
