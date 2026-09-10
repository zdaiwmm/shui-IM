export type CallConnectionStage = 'config' | 'websocket' | 'signaling' | 'sdp' | 'ice-gathering' | 'ice-checking' | 'dtls-srtp' | 'media' | 'quality' | 'recovery';
export type CallConnectionError = `${CallConnectionStage}:${string}`;

export type CallDiagnosticSnapshot = {
  callIdHash: string; kind: 'audio' | 'video'; role: 'caller' | 'callee'; stage: CallConnectionStage;
  stageStartedAt: number; events?: CallDiagnosticEvent[]; inboundLoss?: number; outboundLoss?: number; audioMuted?: boolean; iceState?: string; candidateType?: 'host' | 'srflx' | 'prflx' | 'relay'; candidateProtocol?: 'udp' | 'tcp' | 'tls'; relay?: boolean;
  rttMs?: number; jitterMs?: number; packetLoss?: number; estimatedBitrate?: number; reconnects: number; iceRestarts: number;
  audioOnly: boolean; setupMs?: number; failureStage?: CallConnectionStage; errorCode?: CallConnectionError;
};

export function createCallDiagnostics(input: Pick<CallDiagnosticSnapshot, 'callIdHash' | 'kind' | 'role'>, now = Date.now()): CallDiagnosticSnapshot {
  return { ...input, stage: 'config', stageStartedAt: now, reconnects: 0, iceRestarts: 0, audioOnly: false };
}

export function transitionCallStage(snapshot: CallDiagnosticSnapshot, stage: CallConnectionStage, now = Date.now(), failure?: { code: string }): CallDiagnosticSnapshot {
  return { ...snapshot, stage, stageStartedAt: now, ...(failure ? { failureStage: stage, errorCode: `${stage}:${failure.code}` as CallConnectionError } : {}) };
}

export function recordCallPath(snapshot: CallDiagnosticSnapshot, path: { type: 'host' | 'srflx' | 'prflx' | 'relay'; protocol: 'udp' | 'tcp' | 'tls'; relay?: boolean }): CallDiagnosticSnapshot {
  return { ...snapshot, candidateType: path.type, candidateProtocol: path.protocol, relay: path.relay ?? path.type === 'relay' };
}

export type CallDiagnosticEvent = { stage: CallConnectionStage; at: number; state: 'started' | 'completed' | 'failed'; code?: string; action?: string };
export const CALL_STAGE_POLICY: Record<CallConnectionStage, { timeoutMs: number; code: string; action: string }> = {
  config: { timeoutMs: 19_000, code: 'CONFIG_TIMEOUT', action: 'retry-config' },
  websocket: { timeoutMs: 30_000, code: 'WS_AUTH_TIMEOUT', action: 'reconnect-authenticate' },
  signaling: { timeoutMs: 45_000, code: 'SIGNAL_TIMEOUT', action: 'end-invitation' },
  sdp: { timeoutMs: 8_000, code: 'SDP_TIMEOUT', action: 'end-negotiation' },
  'ice-gathering': { timeoutMs: 12_000, code: 'ICE_GATHER_TIMEOUT', action: 'restart-path' },
  'ice-checking': { timeoutMs: 12_000, code: 'ICE_CHECK_TIMEOUT', action: 'restart-path' },
  'dtls-srtp': { timeoutMs: 10_000, code: 'DTLS_TIMEOUT', action: 'end-secure-transport' },
  media: { timeoutMs: 10_000, code: 'MEDIA_TIMEOUT', action: 'end-missing-audio' },
  quality: { timeoutMs: 12_000, code: 'STATS_TIMEOUT', action: 'retain-media-resample' },
  recovery: { timeoutMs: 60_000, code: 'RECOVERY_TIMEOUT', action: 'end-recovery' },
};
/** Stages overlap (trickle ICE and signaling); an unrelated stage cannot cancel a deadline. */
export class CallStageMonitor {
  private timers = new Map<CallConnectionStage, ReturnType<typeof setTimeout>>();
  constructor(private event: (event: CallDiagnosticEvent) => void, private expired: (stage: CallConnectionStage) => void) {}
  begin(stage: CallConnectionStage, timeoutMs = CALL_STAGE_POLICY[stage].timeoutMs) {
    if (this.timers.has(stage)) return;
    this.event({ stage, at: Date.now(), state: 'started' });
    this.timers.set(stage, setTimeout(() => {
      this.fail(stage, CALL_STAGE_POLICY[stage].code);
      this.expired(stage);
    }, Math.max(1, timeoutMs)));
  }
  complete(stage: CallConnectionStage) {
    if (!this.timers.has(stage)) return;
    this.cancel(stage);
    this.event({ stage, at: Date.now(), state: 'completed' });
  }
  fail(stage: CallConnectionStage, code: string) {
    this.cancel(stage);
    this.noteFailure(stage, code);
  }
  noteFailure(stage: CallConnectionStage, code: string) {
    this.event({ stage, at: Date.now(), state: 'failed', code, action: CALL_STAGE_POLICY[stage].action });
  }
  cancel(stage: CallConnectionStage) { clearTimeout(this.timers.get(stage)); this.timers.delete(stage); }
  clear() { for (const stage of this.timers.keys()) this.cancel(stage); }
}
