import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';

export async function wastickers(files, options = {}) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 6, ...options });
  for (const [name, data] of Object.entries(files)) await writer.add(name, new Uint8ArrayReader(data));
  return Buffer.from(await writer.close());
}
