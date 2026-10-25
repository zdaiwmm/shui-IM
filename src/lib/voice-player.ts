import { motion, retargetMotion } from './motion';
import { releaseSystemMediaSession } from './system-media-session';
import { VoiceNetworkError, VOICE_FAILURE_TEXT } from './voice-network';
import type { AudioPayload } from './types';
import { voiceIcons, voiceTime, voiceMessageSeconds, voiceMessageWidth } from './voice-audio';

/** Only one decrypted audio source, including pending downloads, is retained. */
export class VoicePlayback {
  private current: VoicePlayer | null = null;
  constructor(private readonly useChanged: () => void = () => {}) {}
  get playing(): boolean { return this.current?.playing ?? false; }
  changed(): void { this.useChanged(); }
  activate(player: VoicePlayer): void {
    if (this.current === player) return;
    this.current?.release(true); this.current = player;
  }
  stop(): void { this.current?.release(); this.current = null; }
  prune(): void { if (this.current && !this.current.element.isConnected) this.stop(); }
}

export class VoicePlayer {
  readonly element = document.createElement('div');
  private audio = new Audio();
  private actualPlayback = false;
  get playing(): boolean { return this.element.isConnected && this.actualPlayback && !this.audio.paused && !this.audio.ended && !this.audio.loop && Number.isFinite(this.audio.duration) && this.audio.duration > 0; }
  private url: string | null = null;
  private request: AbortController | null = null;
  private loading = false;
  private positionMs = 0;
  private pendingSeekMs: number | null = null;
  private stateMotion: Animation | null = null;
  private error = '';
  private readonly button: HTMLButtonElement;
  private readonly status: HTMLElement;

  constructor(private readonly payload: AudioPayload, private readonly playback: VoicePlayback,
    private readonly load: (signal: AbortSignal) => Promise<Blob>) {
    this.element.className = 'voice-player';
    this.element.style.setProperty('--voice-message-width', `${voiceMessageWidth(payload.durationMs)}px`);
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', `语音消息，${voiceTime(payload.durationMs)}`);
    this.element.innerHTML = `
      <button class="voice-control voice-play" type="button" aria-label="播放语音">
        <span class="voice-sound">${voiceIcons.sound}</span>
        <time class="voice-time" aria-label="${voiceMessageSeconds(payload.durationMs)}秒">${voiceMessageSeconds(payload.durationMs)}″</time>
      </button>
      <span class="voice-play-status" role="status" aria-live="polite"></span>`;
    this.button = this.element.querySelector('button')!;
    this.status = this.element.querySelector('.voice-play-status')!;
    this.audio.preload = 'metadata';
    this.audio.addEventListener('playing', () => { this.actualPlayback = true; this.playback.changed(); this.update(); });
    for (const event of ['pause', 'waiting', 'stalled', 'ended', 'error', 'emptied']) this.audio.addEventListener(event, () => { this.actualPlayback = false; this.playback.changed(); this.update(); });
    this.button.addEventListener('click', () => void this.toggle());
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.url && this.pendingSeekMs !== null && Number.isFinite(this.audio.duration)) {
        this.audio.currentTime = Math.min(this.pendingSeekMs / 1000, this.audio.duration);
        this.pendingSeekMs = null;
      }
      this.update();
    });
    for (const event of ['play', 'pause', 'timeupdate', 'ended']) this.audio.addEventListener(event, () => this.update());
    this.audio.addEventListener('error', () => {
      if (!this.url) return;
      this.release(); this.error = VOICE_FAILURE_TEXT.VOICE_DECODE_FAILED; this.element.dataset.errorCode = 'VOICE_DECODE_FAILED'; this.update();
    });
    this.update();
  }

  private async toggle(): Promise<void> {
    if (this.loading) { this.release(); return; }
    if (!this.audio.paused) { this.audio.pause(); return; }
    this.playback.activate(this);
    const request = this.request ??= new AbortController();
    this.error = '';
    try {
      if (!this.url) {
        this.loading = true; this.update();
        const blob = await this.load(request.signal);
        if (request.signal.aborted || !this.element.isConnected) return;
        this.url = URL.createObjectURL(blob); this.pendingSeekMs = this.positionMs; this.audio.src = this.url;
      }
      this.loading = false;
      if (this.audio.ended) { this.positionMs = 0; this.audio.currentTime = 0; }
      await this.audio.play();
    } catch (cause) {
      if (request.signal.aborted) return;
      this.release();
      this.error = cause instanceof Error && cause.name === 'NotAllowedError'
        ? '请再次点击播放语音' : cause instanceof VoiceNetworkError ? cause.message : VOICE_FAILURE_TEXT.VOICE_DECODE_FAILED;
      this.element.dataset.errorCode = cause instanceof VoiceNetworkError ? cause.code : cause instanceof Error && cause.name === 'NotAllowedError' ? 'PLAYBACK_GESTURE_REQUIRED' : 'VOICE_DECODE_FAILED';
    } finally {
      if (!request.signal.aborted) this.loading = false;
      this.update();
    }
  }

  private update(): void {
    if (this.url && this.pendingSeekMs === null) this.positionMs = Math.min(this.payload.durationMs, this.audio.currentTime * 1000 || 0);
    const state = this.loading ? 'loading' : this.error ? 'error' : this.audio.ended ? 'ended'
      : !this.audio.paused ? 'playing' : this.positionMs > 0 ? 'paused' : 'idle';
    if (this.element.dataset.playbackState !== state) {
      this.element.dataset.playbackState = state;
      this.stateMotion = retargetMotion(this.button, this.stateMotion,
        { opacity: .65 }, { opacity: 1 }, motion.feedback);
    }
    this.element.dataset.playing = String(this.playing);
    this.element.setAttribute('aria-busy', String(this.loading));
    this.button.setAttribute('aria-label', this.loading ? '取消加载语音' : this.error ? '重试播放语音' : this.audio.paused ? '播放语音' : '暂停语音');
    this.button.setAttribute('aria-description', `已播放${voiceTime(this.positionMs)}，共${voiceTime(this.payload.durationMs)}`);
    const status = this.error;
    if (this.status.textContent !== status) this.status.textContent = status;
  }

  release(preservePosition = false): void {
    const position = preservePosition && !this.audio.ended
      ? Math.min(this.payload.durationMs, this.audio.currentTime * 1000 || this.positionMs) : 0;
    this.stateMotion?.cancel(); this.stateMotion = null;
    this.request?.abort(); this.request = null; this.loading = false;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    releaseSystemMediaSession();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null; this.positionMs = position; this.pendingSeekMs = null; this.actualPlayback = false;
    this.error = ''; delete this.element.dataset.errorCode; this.update();
  }
}
