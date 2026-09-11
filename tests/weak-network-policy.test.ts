import { describe, expect, it } from 'vitest';
import { classifyQuality, recoveryAction, WEAK_NETWORK_PROFILES } from '../src/lib/call-network-policy';

describe('weak network fault injection policy', () => {
  it('covers latency, loss, asymmetric links, config delay and websocket flaps', () => {
    expect(WEAK_NETWORK_PROFILES.map((profile) => profile.name)).toEqual(expect.arrayContaining([
      'latency-100', 'latency-300', 'latency-800', 'loss-0.05', 'loss-0.1', 'loss-0.2',
      'asymmetric-uplink', 'asymmetric-downlink', 'dns-config-delay', 'ws-1s', 'ws-5s', 'ws-15s',
    ]));
  });
  it('escalates recovery without applying relay-only on the first failure', () => {
    expect([1, 2, 3, 4].map((count) => recoveryAction(count, true))).toEqual(['recollect-and-restart', 'refresh-config', 'relay-only', 'end-call']);
    expect(recoveryAction(3, false)).toBe('end-call');
  });
  it('preserves voice while degrading video and uses recovery hysteresis input', () => {
    expect(classifyQuality({ rttMs: 500, jitterMs: 70, packetLoss: 0.08, bitrateKbps: 600, candidateState: 'connected' })).toBe('degraded');
    expect(classifyQuality({ rttMs: 900, jitterMs: 140, packetLoss: 0.22, bitrateKbps: 90, candidateState: 'failed' })).toBe('audio-only');
    expect(classifyQuality({ rttMs: 1, jitterMs: 1, packetLoss: 0, bitrateKbps: 1000, candidateState: 'connected', recovering: true })).toBe('recovering');
  });
});
