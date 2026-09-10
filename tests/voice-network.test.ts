import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmVoiceUpload, voiceRequest } from '../src/lib/voice-network';
import { encryptAudioFile, decryptAudioFile } from '../src/lib/file-crypto';
import type { ImageUploadPlan } from '../src/lib/types';
import { ApiError } from '../src/lib/api';
afterEach(() => vi.useRealTimers());
describe('voice safe retry with original upload identity', () => {
  it('reconciles a lost completion acknowledgment without reuploading committed bytes', async () => {
    const chunks = new Map<number, ArrayBuffer>(); let plan: ImageUploadPlan | undefined; let completed = false, commits = 0, uploads = 0;
    const file = new File([new Uint8Array(100_000).fill(23)], 'voice.wav', { type: 'audio/wav' });
    const ids = new Set<string>();
    const status = async () => ({ uploadedIndexes: [...chunks.keys()], completed });
    const callbacks = {
      reserve: async (id: string) => { ids.add(id); }, status,
      upload: async (_id: string, index: number, bytes: ArrayBuffer) => { uploads++; chunks.set(index, bytes); },
      complete: async () => confirmVoiceUpload(async () => { completed = true; commits++; throw new TypeError('lost response'); }, status),
      savePlan: async (value: ImageUploadPlan) => { plan = value; },
    };
    const first = await encryptAudioFile(file, callbacks);
    const retried = await encryptAudioFile(file, callbacks, plan);
    expect(first).toEqual(retried); expect(ids.size).toBe(1); expect(commits).toBe(1); expect(uploads).toBe(chunks.size);
    const decrypted = await decryptAudioFile(first, async (_id, index) => chunks.get(index)!);
    expect(new Uint8Array(await decrypted.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });
  it('resumes the same encryption plan after an interrupted chunk', async () => {
    const chunks = new Map<number, ArrayBuffer>(); let plan: ImageUploadPlan | undefined; const attempts: Array<{ id: string; bytes: ArrayBuffer }> = [];
    const file = new File([new Uint8Array(50_000).fill(42)], 'voice.wav', { type: 'audio/wav' });
    const callbacks = { reserve: async () => {}, status: async () => ({ uploadedIndexes: [...chunks.keys()], completed: false }), complete: async () => {}, savePlan: async (value: ImageUploadPlan) => { plan = value; },
      upload: async (id: string, index: number, bytes: ArrayBuffer) => { attempts.push({ id, bytes }); if (attempts.length === 1) throw new TypeError('interrupted'); chunks.set(index, bytes); } };
    await expect(encryptAudioFile(file, callbacks)).rejects.toThrow('interrupted');
    await encryptAudioFile(file, callbacks, plan);
    expect(attempts[0]!.id).toBe(attempts[1]!.id); expect(new Uint8Array(attempts[0]!.bytes)).toEqual(new Uint8Array(attempts[1]!.bytes));
  });
  for (const code of ['VOICE_CONNECT_FAILED', 'VOICE_UPLOAD_INTERRUPTED', 'VOICE_ACK_UNKNOWN', 'VOICE_DOWNLOAD_INTERRUPTED'] as const) it(`reports ${code} after bounded retries`, async () => {
    vi.useFakeTimers(); const operation = vi.fn().mockRejectedValue(new TypeError('network'));
    const result = expect(voiceRequest(code, operation)).rejects.toMatchObject({ code });
    await vi.advanceTimersByTimeAsync(1750); await result; expect(operation).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not retry authorization failures and aborts pending transfer timers on lock', async () => {
    const rejected = vi.fn().mockRejectedValue(new ApiError('denied', 403, 'FORBIDDEN'));
    await expect(voiceRequest('VOICE_CONNECT_FAILED', rejected)).rejects.toMatchObject({ status: 403 }); expect(rejected).toHaveBeenCalledOnce();
    vi.useFakeTimers(); const abort = new AbortController(); const blocked = vi.fn(() => new Promise<void>(() => {}));
    const result = expect(voiceRequest('VOICE_UPLOAD_INTERRUPTED', blocked, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort(); await result; expect(vi.getTimerCount()).toBe(0);
  });
});
