import { describe, expect, it } from 'vitest';
import { randomBase64Url } from '../src/lib/base64';
import { LOCAL_ARCHIVE_RECORD_LIMIT, readLocalArchive, writeLocalArchive } from '../src/lib/local-archive';

const signal = () => new AbortController().signal;
async function archive(secret: string, values = [new TextEncoder().encode('private history'), new Uint8Array(512_000).fill(17)]) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  async function* records() { for (const bytes of values) yield { type: 1, bytes }; }
  await writeLocalArchive(secret, records(), { write: async bytes => { parts.push(bytes.slice()); } }, signal());
  return new Blob(parts);
}
async function read(file: Blob, secret: string) {
  const values: Uint8Array<ArrayBuffer>[] = [];
  for await (const item of readLocalArchive(file, secret, signal())) values.push(item.bytes.slice());
  return values;
}

describe('bounded encrypted local archive framing', () => {
  it('round trips records, compresses before encrypting and randomizes every export', async () => {
    const secret = randomBase64Url(32);
    const first = await archive(secret);
    expect(first.size).toBeLessThan(2000);
    const values = await read(first, secret);
    expect(new TextDecoder().decode(values[0])).toBe('private history');
    expect(values[1]).toEqual(new Uint8Array(512_000).fill(17));
    expect(new Uint8Array(await first.arrayBuffer())).not.toEqual(new Uint8Array(await (await archive(secret)).arrayBuffer()));
    expect(await first.text()).not.toContain('private history');
  });

  it('fails closed for wrong keys, modified header/ciphertext, truncated and appended files', async () => {
    const secret = randomBase64Url(32);
    const file = await archive(secret);
    await expect(read(file, randomBase64Url(32))).rejects.toMatchObject({ code: 'AUTHENTICATION' });
    for (const at of [8, 32, 45, file.size - 1]) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      bytes[at] = bytes[at]! ^ 1;
      await expect(read(new Blob([bytes]), secret)).rejects.toThrow();
    }
    for (const end of [0, 39, 41, file.size - 1]) await expect(read(file.slice(0, end), secret)).rejects.toThrow();
    await expect(read(new Blob([file, new Uint8Array([0])]), secret)).rejects.toMatchObject({ code: 'FORMAT' });
  });

  it('rejects record reordering, missing authenticated terminator and unsupported versions', async () => {
    const secret = randomBase64Url(32);
    const file = await archive(secret);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const second = 44 + view.getUint32(40);
    const third = second + 4 + view.getUint32(second);
    await expect(read(new Blob([bytes.slice(0, 40), bytes.slice(second, third), bytes.slice(40, second), bytes.slice(third)]), secret)).rejects.toThrow();
    await expect(read(file.slice(0, third), secret)).rejects.toMatchObject({ code: 'TRUNCATED' });
    bytes[7] = 50;
    await expect(read(new Blob([bytes]), secret)).rejects.toMatchObject({ code: 'VERSION' });
  });

  it('bounds records and honors cancellation before writing', async () => {
    await expect(archive(randomBase64Url(32), [new Uint8Array(LOCAL_ARCHIVE_RECORD_LIMIT + 1)])).rejects.toMatchObject({ code: 'LIMIT' });
    const controller = new AbortController(); controller.abort();
    let writes = 0;
    async function* empty() { yield { type: 1, bytes: new Uint8Array() }; }
    await expect(writeLocalArchive(randomBase64Url(32), empty(), { write: async () => { writes++; } }, controller.signal)).rejects.toThrow();
    expect(writes).toBe(0);
  });
});
