import { describe, expect, it } from 'vitest';
import { isAudioManifest, isImageManifest, isMessagePayload, MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_MS } from '../src/lib/message-payload';
import { encryptAudioFile, decryptAudioFile, encryptImageFile } from '../src/lib/file-crypto';
import { encodeVoiceWav, voiceTime, voiceWaveform, VOICE_SAMPLE_RATE, MAX_VOICE_SAMPLES } from '../src/lib/voice-audio';
import { randomBase64Url } from '../src/lib/base64';
import type { ImageUploadPlan } from '../src/lib/types';

function audioPayload() {
  return {
    v: 1, kind: 'audio', durationMs: 1500, waveform: [0, 30, 100], sentAt: new Date().toISOString(),
    audio: {
      v: 1, blobId: crypto.randomUUID(), key: randomBase64Url(32), ivPrefix: randomBase64Url(8),
      chunkSize: 2 * 1024 * 1024, chunkCount: 1, originalSize: 72_044,
      originalName: '语音消息.wav', mimeType: 'audio/wav', lastModified: 0, sha256: 'a'.repeat(64),
    },
  };
}

describe('encrypted voice payload', () => {
  it('validates voice separately from image and gallery payloads', () => {
    const payload = audioPayload();
    expect(isMessagePayload(payload)).toBe(true);
    expect(isAudioManifest(payload.audio)).toBe(true);
    expect(isImageManifest(payload.audio)).toBe(false);
    expect(isMessagePayload({ ...payload, kind: 'image', image: payload.audio })).toBe(false);
    expect(isMessagePayload({ ...payload, debug: true })).toBe(false);
    for (const durationMs of [0, 499, NaN, Infinity, 1.5, MAX_AUDIO_DURATION_MS + 1]) {
      expect(isMessagePayload({ ...payload, durationMs })).toBe(false);
    }
    for (const waveform of [[], Array(65).fill(1), [-1], [101], [NaN], [1.2], ['10'], [null]]) {
      expect(isMessagePayload({ ...payload, waveform })).toBe(false);
    }
    expect(isAudioManifest({ ...payload.audio, originalSize: MAX_AUDIO_BYTES + 1 })).toBe(false);
    for (const mimeType of ['image/png', 'text/html', 'audio/unknown', 'audio/wav;evil=true']) {
      expect(isAudioManifest({ ...payload.audio, mimeType })).toBe(false);
    }
  });

  it('supports private generic voice reply references with strict versions', () => {
    const payload = audioPayload();
    const replyTo = { clientMsgId: crypto.randomUUID(), serverSeq: 1, senderId: crypto.randomUUID(), kind: 'audio', preview: '语音消息' };
    expect(isMessagePayload({ ...payload, v: 2, replyTo })).toBe(true);
    expect(isMessagePayload({ ...payload, replyTo })).toBe(false);
    expect(isMessagePayload({ ...payload, v: 2 })).toBe(false);
    expect(isMessagePayload({ v: 2, kind: 'text', text: '收到', sentAt: payload.sentAt, replyTo })).toBe(true);
    expect(isMessagePayload({ ...payload, v: 2, replyTo: { ...replyTo, transcript: 'plaintext' } })).toBe(false);
  });
});

describe('portable local voice encoding', () => {
  it('writes mono PCM WAV with clipping and exact lengths', async () => {
    const blob = encodeVoiceWav(new Float32Array([-2, -1, 0, 1, 2, NaN]));
    const bytes = await blob.arrayBuffer(); const view = new DataView(bytes);
    expect(blob.type).toBe('audio/wav');
    expect(bytes.byteLength).toBe(56);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(VOICE_SAMPLE_RATE);
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, -32768, 0, 32767, 32767, 0]);
    expect(() => encodeVoiceWav(new Float32Array(0))).toThrow();
    expect(MAX_VOICE_SAMPLES * 2 + 44).toBeLessThan(MAX_AUDIO_BYTES);
  });
  it('derives bounded waveforms and safe clock labels', () => {
    expect(voiceWaveform(new Float32Array([-0.5, 1, 0, 0.25]), 2)).toEqual([100, 25]);
    expect(voiceWaveform(new Float32Array())).toEqual(Array(48).fill(0));
    expect(voiceTime(61_999)).toBe('1:01');
    expect(voiceTime(NaN)).toBe('0:00');
  });
});

describe('voice attachment encryption', () => {
  it('resumes exact ciphertext chunks, decrypts original audio and detects tampering', async () => {
    const samples = new Float32Array(1_100_000).fill(0.25);
    const file = new File([encodeVoiceWav(samples)], 'voice.wav', { type: 'audio/wav', lastModified: 10 });
    const chunks = new Map<number, ArrayBuffer>();
    let plan: ImageUploadPlan | undefined;
    let interrupted = true;
    const callbacks = {
      reserve: async () => {}, status: async () => ({ uploadedIndexes: [...chunks.keys()], completed: false }),
      upload: async (_blobId: string, index: number, bytes: ArrayBuffer) => {
        if (index === 1 && interrupted) throw new Error('offline');
        chunks.set(index, bytes);
      },
      complete: async () => {}, savePlan: async (value: ImageUploadPlan) => { plan = value; },
    };
    await expect(encryptImageFile(file, callbacks)).rejects.toThrow('图片');
    await expect(encryptAudioFile(file, callbacks)).rejects.toThrow('offline');
    const firstCiphertext = chunks.get(0);
    interrupted = false;
    const manifest = await encryptAudioFile(file, callbacks, plan);
    expect(manifest.blobId).toBe(plan!.blobId);
    expect(chunks.get(0)).toBe(firstCiphertext);
    const restored = await decryptAudioFile(manifest, async (_blobId, index) => chunks.get(index)!);
    expect(restored.type).toBe('audio/wav');
    expect(await restored.arrayBuffer()).toEqual(await file.arrayBuffer());
    await expect(decryptAudioFile({ ...manifest, sha256: '0'.repeat(64) }, async (_blobId, index) => chunks.get(index)!)).rejects.toThrow('完整性');
    const damaged = chunks.get(0)!.slice(0); new Uint8Array(damaged)[30] ^= 1;
    await expect(decryptAudioFile(manifest, async (_blobId, index) => index === 0 ? damaged : chunks.get(index)!)).rejects.toThrow();
    await expect(decryptAudioFile(manifest, async () => new ArrayBuffer(1))).rejects.toThrow('长度');
    const controller = new AbortController(); controller.abort();
    await expect(decryptAudioFile(manifest, async () => { throw Error('must not fetch'); }, undefined, controller.signal)).rejects.toThrow();
  });
});
