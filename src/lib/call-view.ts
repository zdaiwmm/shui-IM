import type { CallState, CallViewActions } from './call-types';

const icons = {
  microphone: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v3m-3 0h6"/>',
  microphoneOff: '<path d="M9 9v3a3 3 0 0 0 5.1 2.1M9 5.3A3 3 0 0 1 15 6v4.8M5.5 10.5v1a6.5 6.5 0 0 0 10.6 5M18.5 10.5v1a6.6 6.6 0 0 1-.4 2.3M12 18v3m-3 0h6M3 3l18 18"/>',
  camera: '<rect x="3" y="6" width="12" height="12" rx="3"/><path d="m15 10 5-3v10l-5-3"/>',
  cameraOff: '<path d="M8 6h4a3 3 0 0 1 3 3v1l5-3v10l-5-3v1M3 7.5V15a3 3 0 0 0 3 3h6.5M3 3l18 18"/>',
  flip: '<path d="M5 8a8 8 0 0 1 13.4-2L21 9m0-6v6h-6M19 16a8 8 0 0 1-13.4 2L3 15m0 6v-6h6"/>',
  hangup: '<path d="M3.2 13.2a14 14 0 0 1 17.6 0c.7.6.9 1.5.5 2.3l-.6 1.2a1.5 1.5 0 0 1-1.9.7l-3-1.1a1.5 1.5 0 0 1-1-1.4v-1.4a10.7 10.7 0 0 0-5.6 0v1.4a1.5 1.5 0 0 1-1 1.4l-3 1.1a1.5 1.5 0 0 1-1.9-.7l-.6-1.2c-.4-.8-.2-1.7.5-2.3Z"/>',
  answer: '<path d="m7.4 3.5 1.8 3.7a1.7 1.7 0 0 1-.3 1.9l-1.3 1.3a15.8 15.8 0 0 0 6 6l1.3-1.3a1.7 1.7 0 0 1 1.9-.3l3.7 1.8a1.5 1.5 0 0 1 .7 1.9l-.6 1.5a2.5 2.5 0 0 1-2.7 1.5A20.3 20.3 0 0 1 2.5 6.1 2.5 2.5 0 0 1 4 3.4l1.5-.6a1.5 1.5 0 0 1 1.9.7Z"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  sound: '<path d="m11 4-6 5H2v6h3l6 5V4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
} as const;

type IconName = keyof typeof icons;
let nextViewId = 0;

function svg(name: IconName): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[name]}</svg>`;
}

function setIcon(element: HTMLElement, name: IconName): void {
  if (element.dataset.icon === name) return;
  element.dataset.icon = name;
  element.innerHTML = svg(name);
}

function formatDuration(startedAt: number): string {
  const total = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** Owns presentation only. The controller owns permissions, tracks, keys and calls. */
export class CallView {
  readonly element: HTMLElement;
  private readonly actions: CallViewActions;
  private readonly remoteVideo: HTMLVideoElement;
  private readonly localVideo: HTMLVideoElement;
  private readonly backgroundVideo: HTMLVideoElement;
  private readonly peerName: HTMLElement;
  private readonly status: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly callType: HTMLElement;
  private readonly remoteHint: HTMLElement;
  private readonly avatar: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly previewMuted: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly incoming: HTMLElement;
  private readonly ended: HTMLElement;
  private readonly mic: HTMLButtonElement;
  private readonly camera: HTMLButtonElement;
  private readonly flip: HTMLButtonElement;
  private readonly hangup: HTMLButtonElement;
  private readonly answer: HTMLButtonElement;
  private readonly dismiss: HTMLButtonElement;
  private readonly playback: HTMLButtonElement;
  private state: CallState | null = null;
  private destroyed = false;
  private focusFrame: number | null = null;
  private readonly tick: ReturnType<typeof setInterval>;

  constructor(actions: CallViewActions) {
    this.actions = actions;
    const id = `call-view-${++nextViewId}`;
    this.element = document.createElement('section');
    this.element.className = 'call-view';
    this.element.hidden = true;
    this.element.tabIndex = -1;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', `${id}-name`);
    this.element.setAttribute('aria-describedby', `${id}-status`);
    this.element.innerHTML = `
      <div class="call-backdrop" aria-hidden="true">
        <video class="call-background-video" autoplay muted playsinline disablepictureinpicture tabindex="-1"></video>
      </div>
      <video class="call-remote-video" autoplay playsinline disablepictureinpicture tabindex="-1" aria-label="对方的视频"></video>
      <div class="call-video-shade" aria-hidden="true"></div>
      <div class="call-identity">
        <div class="call-avatar" aria-hidden="true">${svg('person')}</div>
        <p class="call-type"></p>
        <h1 class="call-peer-name" id="${id}-name">对方</h1>
        <p class="call-status" id="${id}-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <span class="call-timer" role="timer" aria-live="off" hidden></span>
      </div>
      <div class="call-local-preview" hidden>
        <video class="call-local-video" autoplay muted playsinline disablepictureinpicture tabindex="-1" aria-label="你的视频预览"></video>
        <span class="call-preview-name">你</span>
        <span class="call-preview-muted" aria-label="你的麦克风已静音" hidden>${svg('microphoneOff')}</span>
      </div>
      <div class="call-bottom">
        <p class="call-remote-hint" hidden></p>
        <button class="call-playback" type="button" hidden>${svg('sound')}<span>点击播放声音</span></button>
        <div class="call-toolbar" role="group" aria-label="通话控制">
          <button class="call-control call-mic" type="button" aria-label="关闭麦克风" aria-pressed="false"><span class="call-control-disc">${svg('microphone')}</span><span class="call-control-label">静音</span></button>
          <button class="call-control call-camera" type="button" aria-label="关闭摄像头" aria-pressed="false"><span class="call-control-disc">${svg('camera')}</span><span class="call-control-label">摄像头</span></button>
          <button class="call-control call-flip" type="button" aria-label="切换前后摄像头"><span class="call-control-disc">${svg('flip')}</span><span class="call-control-label">翻转</span></button>
          <button class="call-control call-hangup" type="button" aria-label="挂断通话"><span class="call-control-disc">${svg('hangup')}</span><span class="call-control-label">挂断</span></button>
        </div>
        <div class="call-incoming" role="group" aria-label="来电操作" hidden>
          <button class="call-control call-decline" type="button" aria-label="拒绝来电"><span class="call-control-disc">${svg('hangup')}</span><span class="call-control-label">拒绝</span></button>
          <button class="call-control call-answer" type="button" aria-label="接听来电"><span class="call-control-disc">${svg('answer')}</span><span class="call-control-label">接听</span></button>
        </div>
        <div class="call-ended" hidden><button class="call-dismiss" type="button">返回聊天</button></div>
      </div>`;

    const find = <T extends HTMLElement>(selector: string) => this.element.querySelector<T>(selector)!;
    this.remoteVideo = find<HTMLVideoElement>('.call-remote-video');
    this.localVideo = find<HTMLVideoElement>('.call-local-video');
    this.backgroundVideo = find<HTMLVideoElement>('.call-background-video');
    this.localVideo.muted = this.localVideo.defaultMuted = true;
    this.backgroundVideo.muted = this.backgroundVideo.defaultMuted = true;
    this.peerName = find('.call-peer-name');
    this.status = find('.call-status');
    this.timer = find('.call-timer');
    this.callType = find('.call-type');
    this.remoteHint = find('.call-remote-hint');
    this.avatar = find('.call-avatar');
    this.preview = find('.call-local-preview');
    this.previewMuted = find('.call-preview-muted');
    this.toolbar = find('.call-toolbar');
    this.incoming = find('.call-incoming');
    this.ended = find('.call-ended');
    this.mic = find<HTMLButtonElement>('.call-mic');
    this.camera = find<HTMLButtonElement>('.call-camera');
    this.flip = find<HTMLButtonElement>('.call-flip');
    this.hangup = find<HTMLButtonElement>('.call-hangup');
    this.answer = find<HTMLButtonElement>('.call-answer');
    this.dismiss = find<HTMLButtonElement>('.call-dismiss');
    this.playback = find<HTMLButtonElement>('.call-playback');

    this.mic.addEventListener('click', () => this.actions.toggleMicrophone());
    this.camera.addEventListener('click', () => this.actions.toggleCamera());
    this.flip.addEventListener('click', () => this.actions.switchCamera());
    this.hangup.addEventListener('click', () => this.actions.hangup());
    this.answer.addEventListener('click', () => this.actions.accept());
    find('.call-decline').addEventListener('click', () => this.actions.decline());
    this.dismiss.addEventListener('click', () => this.actions.dismiss());
    this.playback.addEventListener('click', () => { void this.playRemote(); });
    document.addEventListener('keydown', this.onKeyDown, true);
    window.visualViewport?.addEventListener('resize', this.updateViewport);
    window.visualViewport?.addEventListener('scroll', this.updateViewport);
    window.addEventListener('resize', this.updateViewport);
    this.tick = setInterval(() => this.updateTimer(), 1000);
    this.updateViewport();
  }

  update(state: CallState): void {
    if (this.destroyed) return;
    const previous = this.state;
    this.state = state;
    const active = state.phase !== 'idle' && state.phase !== 'ended';
    const connected = state.phase === 'connected' || state.phase === 'reconnecting';
    const remoteVisible = connected && state.remoteVideoEnabled && Boolean(state.remoteStream);
    const localVisible = active && state.cameraEnabled && Boolean(state.localStream);
    this.element.hidden = state.phase === 'idle';
    this.element.dataset.phase = state.phase;
    this.element.classList.toggle('call-has-remote-video', remoteVisible);
    this.element.classList.toggle('call-has-local-video', localVisible);
    this.element.classList.toggle('call-local-mirrored', state.facingMode === 'user');
    this.element.classList.toggle('call-poor-connection', state.quality !== 'good');
    this.peerName.textContent = state.peerName || '对方';
    this.callType.textContent = state.kind === 'video' ? '视频通话' : '语音通话';
    const fallbackStatus = {
      idle: '', outgoing: '正在呼叫…', incoming: '邀请你通话', connecting: '正在连接…',
      connected: '通话中', reconnecting: '网络不稳定，正在重连…', ended: '通话已结束',
    }[state.phase];
    const statusText = state.statusText || fallbackStatus;
    if (this.status.textContent !== statusText) this.status.textContent = statusText;
    this.avatar.hidden = remoteVisible;
    this.preview.hidden = !localVisible;
    this.previewMuted.hidden = !state.micMuted;
    this.toolbar.hidden = state.phase === 'incoming' || !active;
    this.incoming.hidden = state.phase !== 'incoming';
    this.ended.hidden = state.phase !== 'ended';
    this.mic.disabled = !active || state.phase === 'incoming' || !state.localStream;
    this.mic.setAttribute('aria-pressed', String(state.micMuted));
    this.mic.setAttribute('aria-label', state.micMuted ? '打开麦克风' : '关闭麦克风');
    this.mic.querySelector('.call-control-label')!.textContent = state.micMuted ? '已静音' : '静音';
    setIcon(this.mic.querySelector('.call-control-disc')!, state.micMuted ? 'microphoneOff' : 'microphone');
    this.camera.disabled = !connected || !state.localStream;
    this.camera.setAttribute('aria-pressed', String(state.cameraEnabled));
    this.camera.setAttribute('aria-label', state.cameraPaused ? '停用视频自动恢复' : state.cameraEnabled ? '关闭摄像头' : '打开摄像头');
    this.camera.querySelector('.call-control-label')!.textContent = state.cameraPaused ? '视频已暂停' : state.cameraEnabled ? '摄像头' : '已关闭';
    setIcon(this.camera.querySelector('.call-control-disc')!, state.cameraEnabled ? 'camera' : 'cameraOff');
    this.flip.disabled = !connected || !state.cameraEnabled || !state.canSwitchCamera;
    this.flip.hidden = !state.canSwitchCamera;
    this.answer.setAttribute('aria-label', state.kind === 'video' ? '接听视频通话' : '接听语音通话');
    setIcon(this.answer.querySelector('.call-control-disc')!, state.kind === 'video' ? 'camera' : 'answer');
    this.updateTimer();

    const remoteHint = connected ? [
      state.remoteMuted ? '对方已静音' : '',
      state.kind === 'video' && !state.remoteVideoEnabled ? '对方已关闭摄像头' : '',
      state.quality !== 'good' && state.phase !== 'reconnecting' ? ({ good: '', degraded: '视频画质已降低', 'audio-only': '已暂停视频，语音保持连接', recovering: '视频画质逐步恢复中' }[state.quality]) : '',
    ].filter(Boolean).join(' · ') : '';
    this.remoteHint.textContent = remoteHint;
    this.remoteHint.hidden = !remoteHint;

    this.bindStream(this.localVideo, active ? state.localStream : null);
    this.bindStream(this.backgroundVideo, localVisible && !remoteVisible ? state.localStream : null);
    const remoteChanged = this.bindStream(this.remoteVideo, active ? state.remoteStream : null);
    if (remoteChanged && this.remoteVideo.srcObject) void this.playRemote();
    if (!active || !state.remoteStream) this.playback.hidden = true;

    const entering = (!previous || previous.phase === 'idle') && state.phase !== 'idle';
    const enteringEnd = previous?.phase !== 'ended' && state.phase === 'ended';
    const controlsReplaced = previous?.phase === 'incoming' && state.phase !== 'incoming';
    if (entering || enteringEnd || controlsReplaced) this.scheduleFocus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.tick);
    if (this.focusFrame !== null) cancelAnimationFrame(this.focusFrame);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.visualViewport?.removeEventListener('resize', this.updateViewport);
    window.visualViewport?.removeEventListener('scroll', this.updateViewport);
    window.removeEventListener('resize', this.updateViewport);
    for (const video of [this.remoteVideo, this.localVideo, this.backgroundVideo]) {
      video.pause();
      video.srcObject = null;
    }
    this.state = null;
    this.element.remove();
  }

  private bindStream(video: HTMLVideoElement, stream: MediaStream | null): boolean {
    if (video.srcObject === stream) return false;
    video.srcObject = stream;
    if (stream && video.muted) void video.play().catch(() => { /* A hidden preview needs no user interruption. */ });
    return true;
  }

  private async playRemote(): Promise<void> {
    const stream = this.remoteVideo.srcObject;
    if (!stream || this.destroyed) return;
    try {
      await this.remoteVideo.play();
      if (this.remoteVideo.srcObject === stream && !this.destroyed) this.playback.hidden = true;
    } catch {
      if (this.remoteVideo.srcObject === stream && !this.destroyed) this.playback.hidden = false;
    }
  }

  private updateTimer(): void {
    const state = this.state;
    const visible = state?.startedAt != null && (state.phase === 'connected' || state.phase === 'reconnecting');
    this.timer.hidden = !visible;
    if (visible) {
      const duration = formatDuration(state.startedAt!);
      this.timer.textContent = duration;
      this.timer.setAttribute('aria-label', `通话时长 ${duration}`);
    }
  }

  private scheduleFocus(): void {
    if (this.focusFrame !== null) cancelAnimationFrame(this.focusFrame);
    this.focusFrame = requestAnimationFrame(() => {
      this.focusFrame = null;
      if (!this.element.isConnected || this.element.hidden || this.destroyed) return;
      const target = this.state?.phase === 'incoming' ? this.answer : this.state?.phase === 'ended' ? this.dismiss : this.hangup;
      target.focus({ preventScroll: true });
    });
  }

  private readonly updateViewport = (): void => {
    const viewport = window.visualViewport;
    this.element.style.setProperty('--call-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    this.element.style.setProperty('--call-viewport-top', `${viewport?.offsetTop ?? 0}px`);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed || this.element.hidden || !this.element.isConnected || document.documentElement.classList.contains('privacy-obscured')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.state?.phase === 'incoming') this.actions.decline();
      else if (this.state?.phase === 'ended') this.actions.dismiss();
      else this.actions.hangup();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = Array.from(this.element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      .filter(button => !button.hidden && button.getClientRects().length > 0);
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) {
      event.preventDefault();
      this.element.focus({ preventScroll: true });
    } else if (event.shiftKey && (document.activeElement === first || !this.element.contains(document.activeElement))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (document.activeElement === last || !this.element.contains(document.activeElement))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };
}
