export type RecoveryAction = 'retain-media' | 'recollect-and-restart' | 'refresh-config' | 'relay-only' | 'end-call';
export type QualityLevel = 'good' | 'degraded' | 'audio-only' | 'recovering';

export function recoveryAction(failures: number, relayAvailable: boolean): RecoveryAction {
  if (failures <= 0) return 'retain-media';
  if (failures === 1) return 'recollect-and-restart';
  if (failures === 2) return 'refresh-config';
  if (failures === 3 && relayAvailable) return 'relay-only';
  return 'end-call';
}

export function classifyQuality(input: { rttMs?: number; jitterMs?: number; packetLoss?: number; bitrateKbps?: number; candidateState: string; audioMuted?: boolean; recovering?: boolean }): QualityLevel {
  if (input.recovering) return 'recovering';
  const lowBitrate = input.bitrateKbps !== undefined && input.bitrateKbps < 300;
  const degraded = (input.rttMs ?? 0) > 450 || (input.jitterMs ?? 0) > 60 || (input.packetLoss ?? 0) >= 0.06 || lowBitrate || input.audioMuted || !['succeeded', 'connected', 'completed'].includes(input.candidateState);
  const audioOnly = (input.rttMs ?? 0) >= 800 || (input.jitterMs ?? 0) >= 120 || (input.packetLoss ?? 0) >= 0.2 || (input.bitrateKbps !== undefined && input.bitrateKbps < 120);
  if (audioOnly) return 'audio-only';
  return degraded ? 'degraded' : 'good';
}

/** Fixed initial thresholds, adjusted only after real path measurements. */
export const VIDEO_LIMITS = [
  { bitrate: 1_500_000, scale: 1, fps: 24 },
  { bitrate: 700_000, scale: 1, fps: 24 },
  { bitrate: 350_000, scale: 2, fps: 24 },
  { bitrate: 180_000, scale: 3, fps: 12 },
  { bitrate: 0, scale: 3, fps: 12 },
] as const;

export const WEAK_NETWORK_PROFILES = [
  ...[100, 300, 800].map((latencyMs) => ({ name: `latency-${latencyMs}`, latencyMs, uplinkLoss: 0, downlinkLoss: 0 })),
  ...[0.05, 0.1, 0.2].map((loss) => ({ name: `loss-${loss}`, latencyMs: 0, uplinkLoss: loss, downlinkLoss: loss })),
  { name: 'asymmetric-uplink', latencyMs: 300, uplinkLoss: 0.2, downlinkLoss: 0.02 },
  { name: 'asymmetric-downlink', latencyMs: 300, uplinkLoss: 0.02, downlinkLoss: 0.2 },
  { name: 'dns-config-delay', latencyMs: 800, uplinkLoss: 0, downlinkLoss: 0 },
  { name: 'ws-1s', latencyMs: 0, uplinkLoss: 0, downlinkLoss: 0, disconnectMs: 1000 },
  { name: 'ws-5s', latencyMs: 0, uplinkLoss: 0, downlinkLoss: 0, disconnectMs: 5000 },
  { name: 'ws-15s', latencyMs: 0, uplinkLoss: 0, downlinkLoss: 0, disconnectMs: 15000 },
] as const;
