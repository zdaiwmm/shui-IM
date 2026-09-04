import { MAX_AUDIO_DURATION_MS } from './message-payload';

// A single portable format avoids sending a browser-specific recording that
// another enrolled device cannot play. Conversion stays entirely on-device.
export const VOICE_SAMPLE_RATE = 24_000;
export const MAX_VOICE_SAMPLES = VOICE_SAMPLE_RATE * MAX_AUDIO_DURATION_MS / 1000;

export function voiceTime(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function voiceWaveform(samples: Float32Array, count = 48): number[] {
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * samples.length / count);
    const end = Math.floor((index + 1) * samples.length / count);
    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    return Math.min(100, Math.round(peak * 100));
  });
}

export function encodeVoiceWav(samples: Float32Array): Blob {
  if (!samples.length || samples.length > MAX_VOICE_SAMPLES) throw new Error('录音长度不受支持');
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export const voiceIcons = {
  mic: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>',
  play: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 5v14M16 5v14" stroke-width="3.5"/></svg>',
  stop: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>',
  remove: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M9 6V3h6v3M7 6l1 15h8l1-15M10 10v7m4-7v7"/></svg>',
  send: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6" stroke-width="2.4"/></svg>',
  paperPlane: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 3-6.5 18-4-7.5L3 9.5 21 3Zm-10.5 10.5L21 3" stroke-width="1.8"/></svg>',
  lock: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="6" y="10" width="12" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  chevronUp: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
  chevronLeft: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg>',
};

export function waveformMarkup(waveform: number[]): string {
  return waveform.map((sample) => `<i style="--level:${Math.max(6, Math.min(100, sample))}%"></i>`).join('');
}
