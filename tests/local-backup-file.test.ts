import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalBackupFile, MEMORY_BACKUP_LIMIT } from '../src/lib/local-backup-file';

afterEach(() => vi.unstubAllGlobals());
const unavailable = () => vi.stubGlobal('navigator', { storage: { getDirectory: async () => { throw new DOMException('Storage unavailable', 'UnknownError'); } } });

describe('bounded encrypted backup fallback', () => {
  it('preserves ciphertext bytes when WebKit cannot open OPFS', async () => {
    unavailable();
    const abort = new AbortController();
    const output = await createLocalBackupFile(abort.signal);
    const bytes = new Uint8Array([81,82,76,49,0,255]);
    await output.sink.write(bytes); bytes.fill(0);
    const file = await output.finish();
    output.handoff(); abort.abort();
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([81,82,76,49,0,255]);
    await output.dispose();
  });
  it('stops at a hard ciphertext limit instead of buffering an unbounded archive', async () => {
    unavailable();
    const output = await createLocalBackupFile(new AbortController().signal);
    const chunk = new Uint8Array(1024 * 1024);
    for (let i = 0; i < MEMORY_BACKUP_LIMIT / chunk.length; i++) await output.sink.write(chunk);
    await expect(output.sink.write(new Uint8Array([1]))).rejects.toThrow('64 MiB');
    await expect(output.finish()).rejects.toThrow('已关闭');
  });
  it('fails closed on cancellation and does not disguise quota exhaustion', async () => {
    unavailable();
    const abort = new AbortController();
    const output = await createLocalBackupFile(abort.signal);
    await output.sink.write(new Uint8Array([1])); abort.abort();
    await expect(output.finish()).rejects.toMatchObject({name:'AbortError'});
    await expect(createLocalBackupFile(abort.signal)).rejects.toMatchObject({name:'AbortError'});
    vi.stubGlobal('navigator', {storage:{getDirectory:async()=>{throw new DOMException('Full','QuotaExceededError');}}});
    await expect(createLocalBackupFile(new AbortController().signal)).rejects.toMatchObject({name:'QuotaExceededError'});
  });
});
