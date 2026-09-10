import { canonicalStringify } from './canonical';
import { createCallDiagnostics, transitionCallStage, type CallDiagnosticSnapshot, type CallConnectionStage } from './call-connection';
import { openCallSignal, sealCallSignal, trustedCallMember } from './call-crypto';
import { CALL_CAPABILITY, type CallAction, type CallControllerOptions, type CallEnvelope, type CallKind, type CallIceConfiguration, type CallPayload, type CallServerEvent, type CallState } from './call-types';
import type { Vault } from './types';

type Context = { generation: number; roomId: string; deviceId: string; identity: string };
const ACTIVE_PHASES = new Set(['outgoing', 'incoming', 'connecting', 'connected', 'reconnecting']);
const RING_MS = 45_000;
const SETUP_MS = 25_000;
const RECONNECT_MS = 60_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const MEDIA_MS = 30_000;
const MAX_CANDIDATES = 256;
const statusByCode: Record<string, string> = {
  busy: '对方正在通话', offline: '对方暂时不在线', unavailable: '对方暂时无法接听',
  timeout: '对方未接听', declined: '对方已拒绝', canceled: '通话已取消',
  disconnected: '网络连接已中断', revoked: '设备权限已失效', expired: '通话请求已过期',
  'already-accepted': '已在其他设备接听', 'not-allowed': '暂时无法建立安全通话',
  INVALID_CALL: '通话请求无效', INVALID_CALL_SIGNATURE: '通话安全验证失败',
  CALL_EXPIRED: '通话请求已过期', CALL_REPLAY: '通话请求已处理', CALL_BUSY: '对方正在通话',
  CALL_UNAVAILABLE: '对方暂时不在线', CALL_NOT_FOUND: '通话已结束', CALL_FORBIDDEN: '暂时无法建立安全通话',
  CALL_ALREADY_ACCEPTED: '已在其他设备接听', CALL_TIMEOUT: '对方未接听', CALL_DECLINED: '对方已拒绝',
  CALL_ENDED: '通话已结束', CALL_DISCONNECTED: '网络连接已中断', CALL_DEVICE_INACTIVE: '设备权限已失效',
  CALL_RATE_LIMITED: '通话操作过于频繁，请稍后重试', CALL_CONFIG_INVALID: '通话网络配置暂不可用',
};

function emptyState(): CallState {
  return { phase: 'idle', callId: null, kind: 'audio', peerName: '对方', localStream: null, remoteStream: null,
    micMuted: false, cameraEnabled: false, remoteVideoEnabled: false, remoteMuted: false,
    facingMode: 'user', startedAt: null, statusText: '', quality: 'good', canSwitchCamera: false };
}
function stopStream(stream: MediaStream | null) { stream?.getTracks().forEach((track) => track.stop()); }
function mediaError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '请允许使用麦克风和摄像头后重试';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '未找到可用的麦克风或摄像头';
  if (name === 'NotReadableError' || name === 'TrackStartError') return '麦克风或摄像头正在被其他应用使用';
  if (name === 'TimeoutError') return '等待设备授权超时，请重试';
  return error instanceof Error && error.message.length < 90 ? error.message : '暂时无法接通，请稍后重试';
}

/** One foreground, one-to-one call. No media, SDP, candidates or keys are persisted. */
export class CallController {
  private current: CallState = emptyState();
  private generation = 0;
  private receiveEpoch = 0;
  private disposed = false;
  private connected = true;
  private context: Context | null = null;
  private pc: RTCPeerConnection | null = null;
  private caller = false;
  private peerId: string | null = null;
  private serverWinner: string | null = null;
  private invited = new Set<string>();
  private peerKeys = new Map<string, string>();
  private incomingOffer: RTCSessionDescriptionInit | null = null;
  private incomingExpiresAt = 0;
  private pendingLocalCandidates: RTCIceCandidateInit[] = [];
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];
  private replay = new Map<string, number>();
  private terminalCalls = new Map<string, number>();
  private receiveQueue: Promise<void> = Promise.resolve();
  private sendQueue: Promise<void> = Promise.resolve();
  private phaseTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private credentialTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPermissions = new Set<() => void>();
  private permissionCount = 0;
  private mediaBusy = false;
  private negotiating = false;
  private localSignalsReady = false;
  private initialDescriptionSent = false;
  private restartRequested = false;
  private reconnectAttempts = 0;
  private lastStats: { received: number; lost: number } | null = null;
  private poorSamples = 0;
  private goodSamples = 0;
  private qualityLevel = 0;
  private audioSender: RTCRtpSender | null = null;
  private videoSender: RTCRtpSender | null = null;
  private diagnostics: CallDiagnosticSnapshot | null = null;
  private relayConfigured = false;
  private readonly onlineHandler = () => { if (this.active && this.current.startedAt) this.scheduleReconnect(); };

  constructor(private readonly options: CallControllerOptions) {
    if (typeof window !== 'undefined') window.addEventListener('online', this.onlineHandler);
  }
  get state(): CallState { return { ...this.current }; }
  get active(): boolean { return ACTIVE_PHASES.has(this.current.phase); }

  private emit(changes: Partial<CallState> = {}) {
    this.current = { ...this.current, ...changes };
    if (!this.disposed) this.options.onChange({ ...this.state, ...(this.diagnostics ? { diagnostics: this.diagnostics } : {}) });
  }
  get diagnosticsSnapshot(): CallDiagnosticSnapshot | null { return this.diagnostics ? { ...this.diagnostics } : null; }
  private diagnosticStage(stage: CallConnectionStage, code?: string) {
    if (!this.diagnostics) return;
    this.diagnostics = transitionCallStage(this.diagnostics, stage, Date.now(), code ? { code } : undefined);
    this.options.onDiagnostics?.({ ...this.diagnostics });
  }
  private capture(vault: Vault): Context {
    return { generation: this.generation, roomId: vault.roomId, deviceId: vault.identity.publicBundle.deviceId,
      identity: canonicalStringify(vault.identity.publicBundle) };
  }
  private valid(context: Context): boolean {
    const vault = this.options.getVault();
    return !this.disposed && context.generation === this.generation && vault !== null && vault.roomId === context.roomId &&
      vault.identity.publicBundle.deviceId === context.deviceId && canonicalStringify(vault.identity.publicBundle) === context.identity &&
      vault.protocol === 'mls-rfc9420' && vault.mls?.phase === 'active' &&
      vault.members.some((member) => member.deviceId === context.deviceId && member.status === 'active' && !member.revokedAt);
  }
  private vault(): Vault {
    const vault = this.options.getVault();
    if (!vault || vault.protocol !== 'mls-rfc9420' || vault.mls?.phase !== 'active') throw new Error('请先解锁并连接安全会话');
    return vault;
  }
  private requireBrowser() {
    if (typeof RTCPeerConnection === 'undefined' || !globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持实时通话，请使用新版浏览器');
    if (!this.connected) throw new Error('网络尚未连接，请稍后重试');
  }
  private rememberPeer(vault: Vault, peerId: string) {
    const peer = trustedCallMember(vault, peerId);
    this.peerKeys.set(peerId, canonicalStringify({ encryptionKey: peer.encryptionKey, signingKey: peer.signingKey }));
  }
  private peerStillTrusted(peerId: string): boolean {
    try {
      const peer = trustedCallMember(this.vault(), peerId);
      return this.peerKeys.get(peerId) === canonicalStringify({ encryptionKey: peer.encryptionKey, signingKey: peer.signingKey });
    } catch { return false; }
  }
  private setPhaseTimeout(ms: number, text: string, reason: string) {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    const generation = this.generation;
    this.phaseTimer = setTimeout(() => {
      if (generation === this.generation && this.active) void this.finish(text, reason, true);
    }, Math.max(1, ms));
  }
  private begin(kind: CallKind, callId: string, caller: boolean, vault: Vault) {
    this.cleanup(false);
    this.current = { ...emptyState(), kind, callId, phase: caller ? 'outgoing' : 'incoming', statusText: caller ? '正在准备通话…' : `${kind === 'video' ? '视频' : '语音'}通话邀请` };
    this.caller = caller;
    this.context = this.capture(vault);
    this.diagnostics = createCallDiagnostics({ callIdHash: this.redactCallId(callId), kind, role: caller ? 'caller' : 'callee' });
    this.emit();
  }
  private redactCallId(callId: string): string {
    let hash = 2166136261;
    for (let i = 0; i < callId.length; i += 1) hash = Math.imul(hash ^ callId.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  async start(kind: CallKind): Promise<void> {
    if (this.disposed || this.active) return;
    let context: Context | null = null;
    try {
      this.requireBrowser();
      const vault = this.vault();
      const peers = vault.members.filter((member) => member.role !== vault.role && member.status === 'active' && !member.revokedAt && member.capabilities?.includes(CALL_CAPABILITY));
      if (!peers.length) throw new Error('对方设备暂不支持通话，请双方刷新页面后重试');
      this.begin(kind, crypto.randomUUID(), true, vault);
      context = this.context!;
      peers.forEach((peer) => { this.rememberPeer(vault, peer.deviceId); this.invited.add(peer.deviceId); });
      this.setPhaseTimeout(MEDIA_MS + SETUP_MS, '准备通话超时，请重试', 'timeout');
      const pc = await this.createPeer(context);
      if (!pc || !this.valid(context)) return;
      const stream = await this.acquireMedia(kind === 'video', context);
      if (!this.valid(context)) { stopStream(stream); return; }
      await this.bindInitialMedia(pc, stream);
      if (!this.valid(context)) return;
      const offer = await pc.createOffer();
      if (!this.valid(context)) return;
      await pc.setLocalDescription(offer);
      if (!this.valid(context)) return;
      const description = { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp };
      this.emit({ phase: 'outgoing', statusText: '正在呼叫…' });
      this.incomingExpiresAt = Date.now() + RING_MS;
      this.setPhaseTimeout(RING_MS, '对方未接听', 'timeout');
      for (const peerId of [...this.invited]) await this.sendTo(peerId, 'invite', { kind, description, cameraEnabled: this.current.cameraEnabled, micMuted: false }, context);
    } catch (error) {
      if (!context || this.valid(context)) await this.finish(mediaError(error), 'failed', true);
    }
  }

  receive(envelope: CallEnvelope): Promise<void> {
    const receiveEpoch = this.receiveEpoch;
    this.receiveQueue = this.receiveQueue.then(async () => {
      if (this.disposed || receiveEpoch !== this.receiveEpoch) return;
      if (!envelope || (this.replay.get(`${envelope.senderId}:${envelope.eventId}`) ?? 0) > Date.now()) return;
      const vault = this.options.getVault();
      if (!vault) return;
      const context = this.capture(vault);
      let payload: CallPayload;
      let verifiedKeys: string;
      try {
        const peer = trustedCallMember(vault, envelope.senderId);
        verifiedKeys = canonicalStringify({ encryptionKey: peer.encryptionKey, signingKey: peer.signingKey });
        payload = await openCallSignal(vault, envelope);
      } catch { return; }
      if (!this.valid(context)) return;
      try {
        const peer = trustedCallMember(this.vault(), envelope.senderId);
        if (verifiedKeys !== canonicalStringify({ encryptionKey: peer.encryptionKey, signingKey: peer.signingKey })) return;
      } catch { return; }
      const now = Date.now();
      for (const [id, expiry] of this.replay) if (expiry <= now) this.replay.delete(id);
      const replayId = `${envelope.senderId}:${envelope.eventId}`;
      if (this.replay.has(replayId)) return;
      if (this.replay.size >= 2048) return;
      this.replay.set(replayId, envelope.expiresAt);
      try { await this.receiveVerified(envelope, payload, this.vault()); }
      catch (error) { if (this.context && this.valid(this.context) && envelope.callId === this.current.callId) await this.finish(mediaError(error), 'failed', true); }
    }).catch(() => {});
    return this.receiveQueue;
  }

  private async receiveVerified(envelope: CallEnvelope, payload: CallPayload, vault: Vault) {
    if (envelope.action === 'invite') {
      if (this.isTerminal(envelope.callId)) return;
      if (this.active) {
        if (envelope.callId !== this.current.callId) await this.sendStandalone(vault, envelope.senderId, envelope.callId, 'decline', { kind: payload.kind, reason: 'busy' });
        return;
      }
      this.begin(payload.kind, envelope.callId, false, vault);
      this.peerId = envelope.senderId;
      this.rememberPeer(vault, envelope.senderId);
      this.incomingOffer = payload.description!;
      this.incomingExpiresAt = envelope.expiresAt;
      this.emit({ remoteVideoEnabled: payload.cameraEnabled ?? payload.kind === 'video', remoteMuted: payload.micMuted ?? false });
      this.setPhaseTimeout(Math.min(RING_MS, envelope.expiresAt - Date.now()), '未接听', 'timeout');
      return;
    }
    if (!this.active || envelope.callId !== this.current.callId || !this.context) return;
    if (payload.kind !== this.current.kind) return;
    if (!this.peerStillTrusted(envelope.senderId)) return;
    const context = this.context;
    if (envelope.action === 'accept') {
      if (!this.caller || this.peerId || !this.invited.has(envelope.senderId) || (this.serverWinner && this.serverWinner !== envelope.senderId)) return;
      if (this.current.phase !== 'outgoing' || !this.pc) return;
      this.peerId = envelope.senderId;
      this.emit({ phase: 'connecting', statusText: '正在安全连接…', remoteVideoEnabled: payload.cameraEnabled ?? this.current.kind === 'video', remoteMuted: payload.micMuted ?? false });
      this.setPhaseTimeout(SETUP_MS, '连接超时，请重试', 'timeout');
      await this.pc.setRemoteDescription(payload.description!);
      if (!this.valid(context)) return;
      this.localSignalsReady = true;
      await this.applyVideoLimit(context);
      await this.flushRemoteCandidates(context);
      await this.flushLocalCandidates(context);
      return;
    }
    if (envelope.action === 'decline' && this.caller && !this.peerId && this.invited.has(envelope.senderId)) {
      // A deliberate refusal on any invited device ends this ringing attempt for all devices.
      await this.finish(statusByCode[payload.reason ?? ''] ?? '对方已拒绝', 'declined', false);
      return;
    }
    if (envelope.senderId !== this.peerId) return;
    if (envelope.action === 'end' || envelope.action === 'decline') {
      await this.finish(statusByCode[payload.reason ?? ''] ?? '通话已结束', payload.reason ?? 'ended', false);
      return;
    }
    if (envelope.action !== 'signal') return;
    if (payload.cameraEnabled !== undefined || payload.micMuted !== undefined) this.emit({
      ...(payload.cameraEnabled !== undefined ? { remoteVideoEnabled: payload.cameraEnabled } : {}),
      ...(payload.micMuted !== undefined ? { remoteMuted: payload.micMuted } : {}),
    });
    if (payload.candidate) {
      if (!this.pc?.remoteDescription) {
        if (this.pendingRemoteCandidates.length < MAX_CANDIDATES) this.pendingRemoteCandidates.push(payload.candidate);
      } else await this.addRemoteCandidate(payload.candidate, context);
    }
    if (payload.description && this.pc && this.current.phase !== 'incoming') await this.receiveDescription(payload.description, context);
  }

  async accept(): Promise<void> {
    if (this.current.phase !== 'incoming' || !this.context || !this.peerId || !this.incomingOffer || this.disposed) return;
    const context = this.context;
    const offer = this.incomingOffer;
    try {
      this.requireBrowser();
      if (Date.now() >= this.incomingExpiresAt || !this.peerStillTrusted(this.peerId)) throw new Error('通话邀请已过期');
      this.emit({ phase: 'connecting', statusText: '正在准备接听…' });
      // Keep the original invitation deadline while waiting for permission; do not accept an expired call.
      const pc = await this.createPeer(context);
      if (!pc || !this.valid(context)) return;
      await pc.setRemoteDescription(offer);
      if (!this.valid(context)) return;
      const stream = await this.acquireMedia(this.current.kind === 'video', context);
      if (!this.valid(context)) { stopStream(stream); return; }
      if (Date.now() >= this.incomingExpiresAt) { stopStream(stream); throw new Error('通话邀请已过期'); }
      await this.bindInitialMedia(pc, stream);
      if (!this.valid(context)) return;
      const answer = await pc.createAnswer();
      if (!this.valid(context)) return;
      await pc.setLocalDescription(answer);
      if (!this.valid(context)) return;
      this.setPhaseTimeout(SETUP_MS, '连接超时，请重试', 'timeout');
      this.emit({ statusText: '正在安全连接…' });
      await this.sendTo(this.peerId!, 'accept', { kind: this.current.kind, description: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp }, cameraEnabled: this.current.cameraEnabled, micMuted: this.current.micMuted }, context);
      if (!this.valid(context)) return;
      this.initialDescriptionSent = true;
      this.localSignalsReady = this.serverWinner === context.deviceId;
      await this.applyVideoLimit(context);
      await this.flushRemoteCandidates(context);
      if (this.localSignalsReady) await this.flushLocalCandidates(context);
    } catch (error) { if (this.valid(context)) await this.finish(mediaError(error), 'failed', true); }
  }

  decline(): Promise<void> { return this.finish('已拒绝', 'declined', true, 'decline'); }
  hangup(reason = 'ended'): Promise<void> { return this.finish(statusByCode[reason] ?? '通话已结束', reason, true); }

  private applyVerifiedPeerIds(config: CallIceConfiguration): boolean {
    if (!Array.isArray(config.verifiedPeerIds)) return false;
    const verified = new Set(config.verifiedPeerIds);
    if (this.peerId && !verified.has(this.peerId)) return false;
    if (this.caller && !this.peerId) {
      for (const peerId of this.invited) {
        if (!verified.has(peerId)) { this.invited.delete(peerId); this.peerKeys.delete(peerId); }
      }
      if (!this.invited.size) return false;
    }
    return true;
  }
  private async createPeer(context: Context): Promise<RTCPeerConnection | null> {
    this.diagnosticStage('config');
    const config = await this.options.getIceConfig();
    this.relayConfigured = config.relayConfigured;
    if (!this.valid(context)) return null;
    if (!this.applyVerifiedPeerIds(config)) {
      // Refuse unproven device encryption keys before requesting any capture or creating an SDP.
      this.peerId = null;
      this.invited.clear();
      this.peerKeys.clear();
      throw new Error('对方未准备好安全通话，请双方重新打开页面');
    }
    const pc = new RTCPeerConnection({
      iceServers: config.iceServers,
      iceTransportPolicy: config.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
      // Pre-gather candidates while media permission and signaling are in flight.
      // This materially reduces the chance that a slow DNS/TURN lookup outlives
      // the initial offer window on a lossy connection.
      iceCandidatePoolSize: 4,
    });
    this.pc = pc;
    this.diagnosticStage('ice-gathering');
    this.emit({ remoteStream: new MediaStream() });
    pc.onicecandidate = (event) => {
      if (!this.valid(context) || !event.candidate) return;
      const candidate = event.candidate.toJSON();
      // Callees also wait until their signed answer has been sent; signaling is ordered below.
      if (!this.peerId || !this.localSignalsReady) {
        if (this.pendingLocalCandidates.length < MAX_CANDIDATES) this.pendingLocalCandidates.push(candidate);
      } else void this.sendTo(this.peerId, 'signal', { kind: this.current.kind, candidate }, context).catch(() => this.connectionFailed(context));
    };
    pc.ontrack = (event) => {
      if (!this.valid(context)) { event.track.stop(); return; }
      const stream = this.current.remoteStream;
      if (!stream || stream.getTracks().some((track) => track.id === event.track.id)) return;
      stream.addTrack(event.track);
      event.track.onended = () => { if (this.valid(context) && event.track.kind === 'video') this.emit({ remoteVideoEnabled: false }); };
      this.emit();
    };
    pc.onconnectionstatechange = () => this.connectionStateChanged(context);
    pc.oniceconnectionstatechange = () => this.connectionStateChanged(context);
    return pc;
  }

  private async acquireMedia(video: boolean, context: Context, audio = true): Promise<MediaStream> {
    if (!this.valid(context)) throw new Error('通话已结束');
    this.permissionCount += 1;
    if (this.permissionCount === 1) this.options.onPermissionChange(true);
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectPending: (error: Error) => void = () => {};
    const release = async (): Promise<boolean> => {
      if (finished) return false;
      finished = true;
      if (timer) clearTimeout(timer);
      this.pendingPermissions.delete(cancel);
      this.permissionCount = Math.max(0, this.permissionCount - 1);
      if (!this.permissionCount) return Boolean(await this.options.onPermissionChange(false));
      return false;
    };
    const cancel = () => { void release().finally(() => rejectPending(new Error('通话已结束'))); };
    this.pendingPermissions.add(cancel);
    const request = Promise.resolve().then(() => {
      if (finished || !this.valid(context)) throw new Error('通话已结束');
      return navigator.mediaDevices.getUserMedia({
      audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
      video: video ? { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: { ideal: this.current.facingMode } } : false,
      });
    });
    const result = new Promise<MediaStream>((resolve, reject) => {
      rejectPending = reject;
      timer = setTimeout(() => { void release().finally(() => reject(new DOMException('等待设备授权超时，请重试', 'TimeoutError'))); }, MEDIA_MS);
      request.then(async (stream) => {
        if (finished || !this.valid(context)) { stopStream(stream); await release(); reject(new Error('通话已结束')); return; }
        const permissionInvalidated = await release();
        // The permission callback can lock/destroy the call synchronously.
        if (permissionInvalidated || !this.valid(context)) { stopStream(stream); reject(new Error('通话已结束')); return; }
        resolve(stream);
      }, (error: unknown) => { void release().finally(() => reject(error)); });
    });
    return result;
  }

  private async bindInitialMedia(pc: RTCPeerConnection, stream: MediaStream) {
    const context = this.context!;
    const audio = stream.getAudioTracks()[0] ?? null;
    const video = stream.getVideoTracks()[0] ?? null;
    const transceivers = pc.getTransceivers();
    this.emit({ localStream: stream, cameraEnabled: video !== null });
    const attach = async (kind: 'audio' | 'video', track: MediaStreamTrack | null): Promise<RTCRtpSender> => {
      const existing = transceivers.find((item) => item.receiver.track.kind === kind);
      if (existing) {
        existing.direction = 'sendrecv';
        await existing.sender.replaceTrack(track);
        if (this.valid(context)) existing.sender.setStreams(stream);
        return existing.sender;
      }
      return pc.addTransceiver(track ?? kind, { direction: 'sendrecv', streams: [stream] }).sender;
    };
    this.audioSender = await attach('audio', audio);
    if (!this.valid(context)) return;
    this.videoSender = await attach('video', video);
    if (!this.valid(context)) return;
    this.observeLocalTracks(stream, context);
    this.emit({ localStream: stream, cameraEnabled: video !== null });
    void this.refreshCameras(context);
    void this.applyVideoLimit(context);
  }

  private observeLocalTracks(stream: MediaStream, context: Context) {
    for (const track of stream.getTracks()) {
      track.onmute = () => {
        if (this.valid(context)) this.emit({ statusText: track.kind === 'audio' ? '麦克风暂时不可用' : '摄像头暂时不可用' });
      };
      track.onunmute = () => { if (this.valid(context) && this.current.phase === 'connected') this.emit({ statusText: '' }); };
      track.onended = () => {
        if (!this.valid(context)) return;
        if (track.kind === 'audio') void this.finish('麦克风已断开，通话结束', 'media-ended', true);
        else {
          stream.removeTrack(track);
          this.emit({ cameraEnabled: false });
          void this.sendMediaState(context);
        }
      };
    }
  }

  private async refreshCameras(context: Context) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (this.valid(context)) this.emit({ canSwitchCamera: devices.filter((device) => device.kind === 'videoinput').length > 1 });
    } catch { /* Device labels/count may be unavailable without permission. */ }
  }

  toggleMicrophone() {
    if (!this.active || !this.context || !this.current.localStream) return;
    const muted = !this.current.micMuted;
    this.current.localStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    this.emit({ micMuted: muted });
    void this.sendMediaState(this.context);
  }

  async toggleCamera(): Promise<void> {
    if (!this.active || !this.context || !this.videoSender || this.mediaBusy || !this.current.localStream) return;
    const context = this.context;
    if (this.current.cameraEnabled) {
      this.current.localStream.getVideoTracks().forEach((track) => { track.onended = null; track.stop(); this.current.localStream?.removeTrack(track); });
      this.emit({ cameraEnabled: false });
      await this.videoSender.replaceTrack(null).catch(() => {});
      if (this.valid(context)) await this.sendMediaState(context);
      return;
    }
    this.mediaBusy = true;
    let stream: MediaStream | null = null;
    try {
      stream = await this.acquireMedia(true, context, false);
      if (!this.valid(context)) { stopStream(stream); return; }
      const track = stream.getVideoTracks()[0];
      if (!track) { stopStream(stream); throw new Error('未找到可用的摄像头'); }
      await this.videoSender!.replaceTrack(track);
      if (!this.valid(context)) { stopStream(stream); return; }
      this.current.localStream!.addTrack(track);
      this.observeLocalTracks(this.current.localStream!, context);
      this.emit({ cameraEnabled: true });
      await this.applyVideoLimit(context);
      await this.sendMediaState(context);
      void this.refreshCameras(context);
    } catch (error) { stopStream(stream); if (this.valid(context)) this.emit({ statusText: mediaError(error) }); }
    finally { if (this.valid(context)) this.mediaBusy = false; }
  }

  async switchCamera(): Promise<void> {
    if (!this.current.cameraEnabled || !this.current.canSwitchCamera || !this.context || !this.videoSender || this.mediaBusy) return;
    const context = this.context;
    const previousFacing = this.current.facingMode;
    this.mediaBusy = true;
    // Mobile browsers may only allow one camera at a time. Stop the old camera first.
    this.current.localStream?.getVideoTracks().forEach((track) => { track.onended = null; track.stop(); this.current.localStream?.removeTrack(track); });
    this.emit({ cameraEnabled: false, facingMode: previousFacing === 'user' ? 'environment' : 'user' });
    let replacement: MediaStream | null = null;
    try {
      replacement = await this.acquireMedia(true, context, false);
      if (!this.valid(context)) { stopStream(replacement); return; }
      const track = replacement.getVideoTracks()[0];
      if (!track) throw new Error('暂时无法切换摄像头');
      await this.videoSender.replaceTrack(track);
      if (!this.valid(context)) { stopStream(replacement); return; }
      this.current.localStream!.addTrack(track);
      this.observeLocalTracks(this.current.localStream!, context);
      this.emit({ cameraEnabled: true });
      await this.applyVideoLimit(context);
      await this.sendMediaState(context);
    } catch (error) {
      stopStream(replacement);
      if (this.valid(context)) { this.emit({ cameraEnabled: false, facingMode: previousFacing, statusText: mediaError(error) }); await this.sendMediaState(context); }
    } finally { if (this.valid(context)) this.mediaBusy = false; }
  }

  private sendMediaState(context: Context) {
    if (!this.peerId || !this.localSignalsReady) return Promise.resolve();
    return this.sendTo(this.peerId, 'signal', { kind: this.current.kind, cameraEnabled: this.current.cameraEnabled, micMuted: this.current.micMuted }, context).catch(() => {});
  }
  private sendTo(recipientId: string, action: CallAction, payload: CallPayload, context: Context): Promise<void> {
    const callId = this.current.callId;
    const result = this.sendQueue.then(async () => {
      if (!callId || !this.valid(context) || !this.peerStillTrusted(recipientId)) return;
      const envelope = await sealCallSignal(this.vault(), recipientId, callId, action, payload);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!this.valid(context) || !this.peerStillTrusted(recipientId)) return;
        if (!this.connected) await new Promise<void>((resolve, reject) => {
          const started = Date.now();
          const wait = () => {
            if (!this.valid(context)) return reject(new Error('通话已结束'));
            if (this.connected) return resolve();
            if (Date.now() - started >= 30_000) return reject(new Error('网络连接已中断'));
            setTimeout(wait, 250);
          };
          wait();
        });
        try { this.options.send(envelope); return; }
        catch (error) {
          if (attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    });
    this.sendQueue = result.catch(() => {});
    return result;
  }
  private async sendStandalone(vault: Vault, recipientId: string, callId: string, action: CallAction, payload: CallPayload) {
    const generation = this.generation;
    try {
      const envelope = await sealCallSignal(vault, recipientId, callId, action, payload);
      const current = this.options.getVault();
      if (this.generation !== generation || !this.connected || !current || current.roomId !== vault.roomId || canonicalStringify(current.identity.publicBundle) !== canonicalStringify(vault.identity.publicBundle)) return;
      trustedCallMember(current, recipientId);
      this.options.send(envelope);
    } catch { /* Best effort cancellation must not delay releasing capture devices. */ }
  }
  private async flushLocalCandidates(context: Context) {
    if (!this.peerId) return;
    while (this.pendingLocalCandidates.length) {
      const candidate = this.pendingLocalCandidates[0]!;
      if (!this.valid(context)) return;
      await this.sendTo(this.peerId, 'signal', { kind: this.current.kind, candidate }, context);
      this.pendingLocalCandidates.shift();
    }
  }
  private async flushRemoteCandidates(context: Context) {
    for (const candidate of this.pendingRemoteCandidates.splice(0)) {
      if (!this.valid(context)) return;
      await this.addRemoteCandidate(candidate, context);
    }
  }
  private async addRemoteCandidate(candidate: RTCIceCandidateInit, context: Context) {
    if (!this.pc || !this.valid(context)) return;
    try { await this.pc.addIceCandidate(candidate); }
    catch { /* A valid, delayed candidate from the previous ICE generation can arrive after restart. */ }
  }

  private isTerminal(callId: string): boolean {
    const now = Date.now();
    for (const [id, expiry] of this.terminalCalls) if (expiry <= now) this.terminalCalls.delete(id);
    return this.terminalCalls.has(callId);
  }
  private rememberTerminal(callId: string) {
    this.isTerminal(callId);
    if (callId.length <= 128 && this.terminalCalls.size < 2048) this.terminalCalls.set(callId, Date.now() + 60_000);
  }
  serverEvent(event: CallServerEvent) {
    if (this.disposed || typeof event.callId !== 'string' || !event.callId) return;
    if (event.state === 'ended') this.rememberTerminal(event.callId);
    if (!this.active && event.state === 'accepted' && event.acceptedBy && event.acceptedBy !== this.options.getVault()?.identity.publicBundle.deviceId) this.rememberTerminal(event.callId);
    if (!this.active || event.callId !== this.current.callId || !this.context) return;
    if (event.state === 'accepted' && event.acceptedBy) {
      if (this.caller) {
        if (this.invited.has(event.acceptedBy)) this.serverWinner = event.acceptedBy;
      } else if (event.acceptedBy !== this.context.deviceId) void this.finish('已在其他设备接听', 'already-accepted', false);
      else {
        this.serverWinner = event.acceptedBy;
        if (this.initialDescriptionSent) {
          this.localSignalsReady = true;
          void this.flushLocalCandidates(this.context).catch(() => {});
        }
      }
    } else if (event.state === 'error' && event.code === 'CALL_ALREADY_ACCEPTED' && this.caller && this.serverWinner) {
      // A later invite to another device can race the first successful acceptance.
      return;
    } else if (event.state === 'error' && event.code === 'CALL_UNAVAILABLE' && this.caller && !this.peerId && event.recipientId) {
      if (!this.invited.has(event.recipientId)) return;
      this.invited.delete(event.recipientId);
      if (!this.invited.size) void this.finish(statusByCode.CALL_UNAVAILABLE!, 'unavailable', false);
    } else if (event.state === 'ended' || event.state === 'error') {
      void this.finish(statusByCode[event.code ?? ''] ?? (event.state === 'error' ? '暂时无法接通，请重试' : '通话已结束'), event.code ?? 'ended', false);
    }
  }
  setConnection(connected: boolean) {
    this.connected = connected;
    if (!this.active) return;
    if (!connected) {
      this.emit({ statusText: this.current.startedAt ? '连接中断，正在恢复…' : '网络连接中断…', ...(this.current.startedAt ? { phase: 'reconnecting' as const } : {}) });
      this.setPhaseTimeout(RECONNECT_MS, '网络连接已中断', 'disconnected');
    } else if (this.current.startedAt || this.restartRequested) {
      if (this.pc?.connectionState === 'connected' || this.pc?.iceConnectionState === 'connected' || this.pc?.iceConnectionState === 'completed') this.connectionStateChanged(this.context!);
      else this.scheduleReconnect();
    } else if (this.current.phase === 'incoming' || this.current.phase === 'outgoing') {
      this.emit({ statusText: this.current.phase === 'incoming' ? `${this.current.kind === 'video' ? '视频' : '语音'}通话邀请` : '正在呼叫…' });
      this.setPhaseTimeout(this.incomingExpiresAt - Date.now(), this.caller ? '对方未接听' : '未接听', 'timeout');
    }
  }
  updateMembers() {
    if (!this.active || !this.context) return;
    if (!this.valid(this.context)) { void this.finish('设备权限已失效', 'revoked', false); return; }
    if (this.peerId && !this.peerStillTrusted(this.peerId)) { void this.finish('对方设备权限已失效', 'revoked', false); return; }
    for (const deviceId of this.invited) if (!this.peerStillTrusted(deviceId)) this.invited.delete(deviceId);
    if (this.caller && !this.peerId && !this.invited.size) void this.finish('对方设备暂时无法通话', 'revoked', false);
  }

  private connectionFailed(context: Context) { if (this.valid(context)) this.scheduleReconnect(); }
  private connectionStateChanged(context: Context) {
    if (!this.valid(context) || !this.pc || !this.active) return;
    const pc = this.pc;
    if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      if (!this.connected) return;
      if (this.phaseTimer) clearTimeout(this.phaseTimer);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.phaseTimer = null;
      this.reconnectTimer = null;
      this.restartRequested = false;
      this.reconnectAttempts = 0;
      this.diagnosticStage('dtls-srtp');
      this.diagnosticStage('media');
      this.diagnosticStage('quality');
      this.emit({ phase: 'connected', startedAt: this.current.startedAt ?? Date.now(), statusText: '' });
      if (!this.statsTimer) this.statsTimer = setInterval(() => { void this.inspectQuality(context); }, 4000);
      if (!this.credentialTimer) this.scheduleCredentialRenewal(context);
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
      this.diagnosticStage('recovery', pc.iceConnectionState === 'failed' ? 'ice-failed' : 'transport-disconnected');
      this.scheduleReconnect();
    }
  }
  private scheduleReconnect() {
    if (!this.context || !this.peerId || !this.pc || this.current.phase === 'incoming') return;
    this.restartRequested = true;
    if (this.current.phase !== 'reconnecting') {
      this.emit({ phase: 'reconnecting', statusText: '网络不稳定，正在重新连接…', quality: 'poor' });
      this.setPhaseTimeout(RECONNECT_MS, '网络连接已中断', 'disconnected');
    }
    if (this.reconnectTimer || !this.connected) return;
    if (this.reconnectAttempts >= RECONNECT_DELAYS_MS.length) return;
    const context = this.context;
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempts++] ?? RECONNECT_DELAYS_MS.at(-1)!;
    if (this.diagnostics) {
      this.diagnostics = { ...this.diagnostics, reconnects: this.diagnostics.reconnects + 1 };
      this.options.onDiagnostics?.({ ...this.diagnostics });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.restartIce(context).then((restarted) => {
        if (!restarted && this.valid(context) && this.active) this.scheduleReconnect();
      });
    }, delay);
  }
  private scheduleCredentialRenewal(context: Context, delay = (this.caller ? 60 : 61) * 60_000) {
    if (this.credentialTimer) clearTimeout(this.credentialTimer);
    this.credentialTimer = setTimeout(() => {
      this.credentialTimer = null;
      if (!this.valid(context) || !this.active) return;
      if (this.current.phase !== 'connected' || !this.connected) { this.scheduleCredentialRenewal(context, 60_000); return; }
      void this.restartIce(context).then((renewed) => {
        if (this.valid(context) && this.active) this.scheduleCredentialRenewal(context, renewed ? (this.caller ? 60 : 61) * 60_000 : 60_000);
      });
    }, delay);
  }
  private async refreshPeerConfiguration(pc: RTCPeerConnection, context: Context): Promise<boolean> {
    const config = await this.options.getIceConfig();
    if (!this.valid(context) || pc !== this.pc) return false;
    this.relayConfigured = config.relayConfigured;
    if (!this.applyVerifiedPeerIds(config)) {
      void this.finish('对方身份验证已失效，请重新发起通话', 'unverified', false);
      return false;
    }
    const relayOnly = this.reconnectAttempts >= 3 && this.relayConfigured;
    pc.setConfiguration({ ...pc.getConfiguration(), iceServers: config.iceServers, iceTransportPolicy: relayOnly ? 'relay' : config.iceTransportPolicy });
    if (relayOnly && this.diagnostics) this.diagnostics = { ...this.diagnostics, relay: true };
    if (this.current.startedAt) this.scheduleCredentialRenewal(context);
    return true;
  }
  private async restartIce(context: Context): Promise<boolean> {
    const pc = this.pc;
    if (!pc || !this.valid(context) || !this.connected || !this.peerId || this.negotiating || pc.signalingState !== 'stable') return false;
    this.negotiating = true;
    if (this.diagnostics) this.diagnostics = { ...this.diagnostics, iceRestarts: this.diagnostics.iceRestarts + 1 };
    this.localSignalsReady = false;
    try {
      if (!(await this.refreshPeerConfiguration(pc, context))) return false;
      const offer = await pc.createOffer({ iceRestart: true });
      if (!this.valid(context)) return false;
      await pc.setLocalDescription(offer);
      if (!this.valid(context)) return false;
      await this.sendTo(this.peerId, 'signal', { kind: this.current.kind, description: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } }, context);
      if (this.valid(context)) { this.localSignalsReady = true; await this.flushLocalCandidates(context); }
      return this.valid(context);
    } catch { return false; /* Recovery timeout or credential retry handles a failed request. */ }
    finally {
      if (this.valid(context)) {
        this.negotiating = false;
        if (pc.signalingState === 'stable') this.localSignalsReady = true;
      }
    }
  }
  private async receiveDescription(description: RTCSessionDescriptionInit, context: Context) {
    const pc = this.pc;
    if (!pc || !this.peerId || !this.valid(context)) return;
    const collision = description.type === 'offer' && (this.negotiating || pc.signalingState !== 'stable');
    // The caller is the impolite peer; the callee rolls back on simultaneous ICE restarts.
    if (collision && this.caller) return;
    if (collision) {
      await pc.setLocalDescription({ type: 'rollback' });
      if (!this.valid(context)) return;
    }
    if (description.type === 'answer' && pc.signalingState !== 'have-local-offer') return;
    if (description.type === 'offer') {
      this.localSignalsReady = false;
      try { await this.refreshPeerConfiguration(pc, context); } catch { /* Keep usable existing credentials if the configuration service is temporarily unavailable. */ }
      if (!this.valid(context)) return;
    }
    await pc.setRemoteDescription(description);
    if (!this.valid(context)) return;
    await this.flushRemoteCandidates(context);
    if (description.type === 'offer') {
      const answer = await pc.createAnswer();
      if (!this.valid(context)) return;
      await pc.setLocalDescription(answer);
      if (!this.valid(context)) return;
      await this.sendTo(this.peerId, 'signal', { kind: this.current.kind, description: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } }, context);
      if (this.valid(context)) { this.localSignalsReady = true; await this.flushLocalCandidates(context); }
    }
    if (this.valid(context) && pc.signalingState === 'stable') this.connectionStateChanged(context);
  }

  private async inspectQuality(context: Context) {
    const pc = this.pc;
    if (!pc || !this.valid(context) || this.current.phase !== 'connected') return;
    try {
      const stats = await pc.getStats();
      if (!this.valid(context)) return;
      let received = 0; let lost = 0; let rtt = 0; let jitter = 0; let bitrate = 0;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && !report.isRemote) { received += Number(report.packetsReceived ?? 0); lost += Math.max(0, Number(report.packetsLost ?? 0)); jitter = Math.max(jitter, Number(report.jitter ?? 0)); }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) rtt = Math.max(rtt, Number(report.currentRoundTripTime ?? 0));
        if (report.type === 'remote-inbound-rtp') rtt = Math.max(rtt, Number(report.roundTripTime ?? 0));
        if (report.type === 'outbound-rtp') bitrate += Number(report.bytesSent ?? 0);
      });
      if (this.diagnostics) {
        stats.forEach((report) => {
          if (report.type !== 'candidate-pair' || report.state !== 'succeeded' || (!report.nominated && !report.selected)) return;
          const local = stats.get(report.localCandidateId);
          const type = local?.candidateType === 'relay' ? 'relay' : local?.candidateType === 'srflx' ? 'srflx' : local?.candidateType === 'host' ? 'host' : undefined;
          const protocol = local?.protocol === 'tls' ? 'tls' : local?.protocol === 'tcp' ? 'tcp' : local?.protocol === 'udp' ? 'udp' : undefined;
          if (type && protocol) this.diagnostics = { ...this.diagnostics!, candidateType: type, candidateProtocol: protocol, relay: type === 'relay' };
        });
      }
      const previous = this.lastStats;
      this.lastStats = { received, lost };
      const receivedDelta = previous ? Math.max(0, received - previous.received) : 0;
      const lostDelta = previous ? Math.max(0, lost - previous.lost) : 0;
      const loss = receivedDelta + lostDelta > 0 ? lostDelta / (receivedDelta + lostDelta) : 0;
      if (this.diagnostics) {
        this.diagnostics = { ...this.diagnostics, iceState: pc.iceConnectionState, rttMs: rtt ? Math.round(rtt * 1000) : undefined, jitterMs: jitter ? Math.round(jitter * 1000) : undefined, packetLoss: loss, estimatedBitrate: bitrate, audioOnly: this.qualityLevel >= 3 };
        this.options.onDiagnostics?.({ ...this.diagnostics });
      }
      const poor = rtt > 0.45 || jitter > 0.06 || loss > 0.06;
      this.poorSamples = poor ? this.poorSamples + 1 : 0;
      this.goodSamples = poor ? 0 : this.goodSamples + 1;
      if (poor && this.current.quality !== 'poor') this.emit({ quality: 'poor' });
      if (this.goodSamples >= 3 && this.current.quality !== 'good') this.emit({ quality: 'good' });
      if (this.poorSamples >= 3 && this.current.cameraEnabled) {
        this.poorSamples = 0;
        this.qualityLevel = Math.min(3, this.qualityLevel + 1);
        if (this.qualityLevel === 3) {
          await this.toggleCamera();
          if (this.valid(context)) this.emit({ statusText: '网络较弱，已关闭摄像头以保持语音清晰' });
        } else await this.applyVideoLimit(context);
      } else if (this.goodSamples >= 8 && this.qualityLevel > 0 && this.current.cameraEnabled) {
        this.goodSamples = 0;
        this.qualityLevel -= 1;
        await this.applyVideoLimit(context);
      }
    } catch { /* Stats support varies; media itself remains usable. */ }
  }
  private async applyVideoLimit(context: Context) {
    const sender = this.videoSender;
    if (!sender || !this.valid(context)) return;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      const limits = [{ bitrate: 1_500_000, scale: 1, fps: 24 }, { bitrate: 700_000, scale: 1.5, fps: 20 }, { bitrate: 350_000, scale: 2, fps: 15 }];
      const limit = limits[Math.min(2, this.qualityLevel)]!;
      for (const encoding of parameters.encodings) { encoding.maxBitrate = limit.bitrate; encoding.scaleResolutionDownBy = limit.scale; encoding.maxFramerate = limit.fps; }
      await sender.setParameters(parameters);
    } catch { /* Some browsers set encodings only after negotiation. Native congestion control still applies. */ }
  }

  private async finish(text: string, reason: string, notify: boolean, action: CallAction = 'end'): Promise<void> {
    const callId = this.current.callId;
    const kind = this.current.kind;
    const vault = this.options.getVault();
    const recipients = this.peerId ? [this.peerId] : [...this.invited];
    const wasActive = this.active;
    if (callId && wasActive) this.rememberTerminal(callId);
    this.cleanup();
    this.emit({ phase: 'ended', localStream: null, remoteStream: null, cameraEnabled: false, remoteVideoEnabled: false, statusText: text });
    if (notify && wasActive && callId && vault) await Promise.all(recipients.map((peer) => this.sendStandalone(vault, peer, callId, action, { kind, reason })));
  }
  private cleanup(invalidateReceives = true) {
    this.generation += 1;
    if (invalidateReceives) this.receiveEpoch += 1;
    // A finished call must not carry a stale transport-down flag into the
    // next call. The WebSocket owner will report the current transport state
    // again before any subsequent signaling is sent.
    this.connected = true;
    this.context = null;
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.credentialTimer) clearTimeout(this.credentialTimer);
    this.phaseTimer = null; this.statsTimer = null; this.reconnectTimer = null; this.credentialTimer = null;
    for (const stream of [this.current.localStream, this.current.remoteStream]) {
      stream?.getTracks().forEach((track) => { track.onended = null; track.onmute = null; track.onunmute = null; track.stop(); });
    }
    const pc = this.pc;
    if (pc) {
      pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null;
      pc.getSenders().forEach((sender) => sender.track?.stop());
      pc.close();
    }
    this.pc = null;
    for (const cancel of [...this.pendingPermissions]) cancel();
    this.audioSender = null; this.videoSender = null; this.peerId = null; this.serverWinner = null;
    this.invited.clear(); this.peerKeys.clear(); this.incomingOffer = null; this.incomingExpiresAt = 0;
    this.pendingLocalCandidates = []; this.pendingRemoteCandidates = [];
    this.mediaBusy = false; this.negotiating = false; this.restartRequested = false; this.localSignalsReady = false; this.initialDescriptionSent = false;
    this.lastStats = null; this.poorSamples = 0; this.goodSamples = 0; this.qualityLevel = 0; this.reconnectAttempts = 0;
  }
  dismiss() {
    if (this.active || this.disposed) return;
    this.cleanup();
    this.current = emptyState();
    this.emit();
  }
  destroy() {
    if (this.disposed) return;
    // finish synchronously stops tracks and closes the connection before its first await.
    void this.finish('通话已结束', 'locked', true);
    this.disposed = true;
    this.replay.clear();
    this.terminalCalls.clear();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
  }
}
