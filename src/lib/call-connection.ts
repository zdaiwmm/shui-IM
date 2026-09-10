export type CallConnectionStage = 'config' | 'websocket' | 'signaling' | 'sdp' | 'ice-gathering' | 'ice-checking' | 'dtls-srtp' | 'media' | 'quality' | 'recovery';
export type CallConnectionError = `${CallConnectionStage}:${string}`;

export type CallDiagnosticSnapshot = {
  callIdHash: string; kind: 'audio' | 'video'; role: 'caller' | 'callee'; stage: CallConnectionStage;
  stageStartedAt: number; iceState?: string; candidateType?: 'host' | 'srflx' | 'relay'; candidateProtocol?: 'udp' | 'tcp' | 'tls'; relay?: boolean;
  rttMs?: number; jitterMs?: number; packetLoss?: number; estimatedBitrate?: number; reconnects: number; iceRestarts: number;
  audioOnly: boolean; setupMs?: number; failureStage?: CallConnectionStage; errorCode?: CallConnectionError;
};

export function createCallDiagnostics(input: Pick<CallDiagnosticSnapshot, 'callIdHash' | 'kind' | 'role'>, now = Date.now()): CallDiagnosticSnapshot {
  return { ...input, stage: 'config', stageStartedAt: now, reconnects: 0, iceRestarts: 0, audioOnly: false };
}

export function transitionCallStage(snapshot: CallDiagnosticSnapshot, stage: CallConnectionStage, now = Date.now(), failure?: { code: string }): CallDiagnosticSnapshot {
  return { ...snapshot, stage, stageStartedAt: now, ...(failure ? { failureStage: stage, errorCode: `${stage}:${failure.code}` as CallConnectionError } : {}) };
}

export function recordCallPath(snapshot: CallDiagnosticSnapshot, path: { type: 'host' | 'srflx' | 'relay'; protocol: 'udp' | 'tcp' | 'tls'; relay?: boolean }): CallDiagnosticSnapshot {
  return { ...snapshot, candidateType: path.type, candidateProtocol: path.protocol, relay: path.relay ?? path.type === 'relay' };
}
