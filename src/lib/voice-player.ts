import type { AudioPayload } from './types';
import { voiceIcons, voiceTime, waveformMarkup } from './voice-audio';

/** Only one decrypted audio source, including pending downloads, is retained. */
export class VoicePlayback {
  private current: VoicePlayer | null = null;
  activate(player: VoicePlayer): void {
    if (this.current === player) return;
    this.stop(); this.current = player;
  }
  stop(): void { this.current?.release(); this.current = null; }
  prune(): void { if (this.current && !this.current.element.isConnected) this.stop(); }
}

export class VoicePlayer {
  readonly element = document.createElement('div');
  private audio = new Audio();
  private url: string | null = null;
  private request: AbortController | null = null;
  private loading = false;
  private error = '';
  private readonly button: HTMLButtonElement;
  private readonly seek: HTMLInputElement;
  private readonly time: HTMLElement;
  private readonly status: HTMLElement;

  constructor(private readonly payload: AudioPayload, private readonly playback: VoicePlayback,
    private readonly load: (signal: AbortSignal) => Promise<Blob>) {
    this.element.className = 'voice-player';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', `语音消息，${voiceTime(payload.durationMs)}`);
    this.element.innerHTML = `
      <button class="voice-control voice-play" type="button" aria-label="播放语音">${voiceIcons.play}</button>
      <div class="voice-timeline"><div class="voice-waveform" aria-hidden="true">${waveformMarkup(payload.waveform)}</div>
        <input class="voice-seek" type="range" min="0" max="${payload.durationMs}" step="100" value="0" aria-label="语音播放进度" disabled />
      </div><time class="voice-time">${voiceTime(payload.durationMs)}</time>
      <span class="voice-play-status" role="status" aria-live="polite"></span>`;
    this.button = this.element.querySelector('button')!;
    this.seek = this.element.querySelector('input')!;
    this.time = this.element.querySelector('time')!;
    this.status = this.element.querySelector('.voice-play-status')!;
    this.audio.preload = 'metadata';
    this.button.addEventListener('click', () => void this.toggle());
    this.seek.addEventListener('input', () => {
      if (!this.url || !Number.isFinite(this.audio.duration)) return;
      this.audio.currentTime = Math.min(Number(this.seek.value) / 1000, this.audio.duration);
      this.update();
    });
    for (const event of ['play', 'pause', 'timeupdate', 'ended', 'loadedmetadata']) this.audio.addEventListener(event, () => this.update());
    this.audio.addEventListener('error', () => {
      if (!this.url) return;
      this.error = '语音无法播放，点按重试'; this.update();
    });
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
        this.url = URL.createObjectURL(blob); this.audio.src = this.url;
      }
      this.loading = false;
      if (this.audio.ended) this.audio.currentTime = 0;
      await this.audio.play();
    } catch (cause) {
      if (request.signal.aborted) return;
      this.release();
      this.error = cause instanceof Error && cause.name === 'NotAllowedError'
        ? '请再次点击播放语音' : '语音加载或播放失败，点按重试';
    } finally {
      if (!request.signal.aborted) this.loading = false;
      this.update();
    }
  }

  private update(): void {
    const current = Math.min(this.payload.durationMs, this.audio.currentTime * 1000 || 0);
    this.element.dataset.playing = String(!this.audio.paused);
    this.element.setAttribute('aria-busy', String(this.loading));
    this.button.innerHTML = this.loading ? voiceIcons.stop : this.audio.paused ? voiceIcons.play : voiceIcons.pause;
    this.button.setAttribute('aria-label', this.loading ? '取消加载语音' : this.error ? '重试播放语音' : this.audio.paused ? '播放语音' : '暂停语音');
    this.seek.disabled = !this.url || !Number.isFinite(this.audio.duration);
    this.seek.value = String(current);
    this.seek.setAttribute('aria-valuetext', `${voiceTime(current)}，共 ${voiceTime(this.payload.durationMs)}`);
    this.element.querySelectorAll<HTMLElement>('.voice-waveform i').forEach((bar, i) => {
      bar.classList.toggle('is-played', (i + 1) / this.payload.waveform.length <= current / this.payload.durationMs);
    });
    this.time.textContent = voiceTime(current > 0 && !this.audio.ended ? current : this.payload.durationMs);
    const status = this.loading ? '正在解密语音…' : this.error;
    if (this.status.textContent !== status) this.status.textContent = status;
  }

  release(): void {
    this.request?.abort(); this.request = null; this.loading = false;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null; this.error = ''; this.update();
  }
}
