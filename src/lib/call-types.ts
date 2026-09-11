import type { Vault } from './types';
import type { QualityLevel } from './call-network-policy';
import type { CallDiagnosticSnapshot } from './call-connection';

export const CALL_CAPABILITY = 'webrtc-call-v1';
export const CALL_PROTOCOL = 'quiet-room-call-v1';
export type CallKind = 'audio' | 'video';
export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type CallAction = 'invite' | 'accept' | 'signal' | 'decline' | 'end';

/** Routing metadata is visible; the complete media negotiation is encrypted and signed. */
export type CallEnvelope = {
  v: 1;
  protocol: typeof CALL_PROTOCOL;
  roomId: string;
  callId: string;
  eventId: string;
  senderId: string;
  recipientId: string;
  action: CallAction;
  createdAt: number;
  expiresAt: number;
  iv: string;
  ciphertext: string;
  signature: string;
};

export type CallPayload = {
  kind: CallKind;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  cameraEnabled?: boolean;
  micMuted?: boolean;
  reason?: string;
};

export type CallServerEvent = {
  type: 'call-state';
  callId: string;
  state: 'ringing' | 'accepted' | 'ended' | 'error';
  acceptedBy?: string;
  recipientId?: string;
  code?: string;
};

export type CallIceRoute = { url: string; kind: 'stun' | 'turn'; protocol: 'udp' | 'tcp' | 'tls'; region?: string };

export type CallIceConfiguration = {
  expiresAt?: number;
  iceRoutes?: CallIceRoute[];
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  relayConfigured: boolean;
  callIdentities?: unknown;
  /** Computed by the local verifier; never copied from server JSON. */
  verifiedPeerIds?: string[];
};

export type CallState = {
  phase: CallPhase;
  callId: string | null;
  kind: CallKind;
  peerName: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  micMuted: boolean;
  cameraEnabled: boolean;
  cameraPaused?: boolean;
  remoteVideoEnabled: boolean;
  remoteMuted: boolean;
  facingMode: 'user' | 'environment';
  startedAt: number | null;
  statusText: string;
  quality: QualityLevel;
  canSwitchCamera: boolean;
  diagnostics?: CallDiagnosticSnapshot;
};

export type CallControllerOptions = {
  getVault: () => Vault | null;
  send: (envelope: CallEnvelope) => void | Promise<void>;
  cancelSignals?: (callId: string) => void;
  getIceConfig: (signal?: AbortSignal) => Promise<CallIceConfiguration>;
  onChange: (state: CallState) => void;
  onPermissionChange: (active: boolean) => boolean | void | Promise<boolean | void>;
  onDiagnostics?: (snapshot: CallDiagnosticSnapshot) => void;
};

export type CallViewActions = {
  accept: () => void;
  decline: () => void;
  hangup: () => void;
  toggleMicrophone: () => void;
  toggleCamera: () => void;
  switchCamera: () => void;
  dismiss: () => void;
};
