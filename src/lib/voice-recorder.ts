import { AUDIO_MIME_TYPES, MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_MS, MIN_AUDIO_DURATION_MS } from './message-payload';
import { encodeVoiceWav, MAX_VOICE_SAMPLES, VOICE_SAMPLE_RATE, voiceIcons, voiceTime, voiceWaveform, waveformMarkup } from './voice-audio';

export type VoiceDraft = { file: File; durationMs: number; waveform: number[]; clientMsgId: string };
type State = 'requesting' | 'recording' | 'processing' | 'paused' | 'sending';
type Mode = 'hold' | 'locked';
const CANCEL_DISTANCE = 220;
const CANCEL_RESET_DISTANCE = 196;
const CANCEL_MOTION_MS = 360;

export class VoiceRecorder {
  readonly signal: AbortSignal;
  private readonly abort = new AbortController();
  private state: State = 'requesting';
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: number | null = null;
  private permissionTimer: number | null = null;
  private startedAt = 0;
  private segmentDurationMs = 0;
  private samples = new Float32Array(0);
  private liveLevels: number[] = [];
  private chunks: Blob[] = [];
  private chunkBytes = 0;
  private preview = new Audio();
  private previewUrl: string | null = null;
  private draft: VoiceDraft | null = null;
  private readonly clientMsgId = crypto.randomUUID();
  private message = '';
  private sendAttempted = false;
  private starting = false;
  private holdReleased = false;
  private cancelReady = false;
  private sendAfterProcessing = false;
  private waveform: number[] | null = null;
  private readonly waveBars: HTMLElement[];
  private renderedWaveform = '';
  private renderedToggleIcon = '';
  private renderedPreviewIcon = '';
  private renderedSendIcon = '';
  private sendMotion: Animation | null = null;
  private holdEntryMotion: Animation | null = null;
  private cancelMotionTimer: number | null = null;

  constructor(private readonly host: HTMLElement, private readonly callbacks: {
    permission: (active: boolean) => boolean | void | Promise<boolean | void>;
    cancel: () => void;
    fail: (message: string) => void;
    send: (draft: VoiceDraft, signal: AbortSignal) => Promise<void>;
  }, private mode: Mode = 'locked') {
    this.signal = this.abort.signal;
    host.innerHTML = `
      <div class="voice-recording-bar">
        <div class="voice-recording-info"><span class="voice-recording-dot" aria-hidden="true"></span><time class="voice-recording-time">0:00,00</time></div>
        <span class="voice-slide-hint" role="status" aria-live="polite">${voiceIcons.chevronLeft}<span class="voice-release-label"></span></span>
        <span class="voice-submit-label" aria-hidden="true"></span>
        <button type="button" class="voice-cancel" aria-label="取消录音">取消</button>
        <div class="voice-draft-timeline">
          <div class="voice-recording-wave voice-waveform" aria-hidden="true">${waveformMarkup(Array(48).fill(0))}</div>
          <button type="button" class="voice-preview" aria-label="试听录音"><span class="voice-preview-icon">${voiceIcons.play}</span><span class="voice-preview-time">0:00</span></button>
        </div>
      </div>
      <span class="voice-recording-state" role="status" aria-live="polite"></span>
      <button type="button" class="voice-control voice-discard" aria-label="取消录音">${voiceIcons.remove}</button>
      <button type="button" class="voice-control voice-toggle" aria-label="暂停录音">${voiceIcons.pause}</button>
      <div class="voice-hold-orb" aria-hidden="true">${voiceIcons.mic}</div>
      <button type="button" class="voice-control voice-send" aria-label="发送语音">${voiceIcons.send}</button>
      <p class="voice-recording-hint" role="status" aria-live="polite"></p>`;
    this.waveBars = Array.from(host.querySelectorAll<HTMLElement>('.voice-recording-wave i'));
    this.resetDrag();
    host.querySelector('.voice-discard')!.addEventListener('click', () => this.cancel());
    host.querySelector('.voice-cancel')!.addEventListener('click', () => this.cancel());
    host.querySelector('.voice-toggle')!.addEventListener('click', () => {
      if (this.state === 'recording') this.pause();
      else if (this.state === 'paused') void this.start();
    });
    host.querySelector('.voice-preview')!.addEventListener('click', () => void this.playPreview());
    host.querySelector('.voice-send')!.addEventListener('click', () => void this.send());
    for (const event of ['play', 'pause', 'ended', 'timeupdate']) this.preview.addEventListener(event, () => this.update());
    this.update();
  }

  animateHoldFrom(origin: DOMRect): void {
    if (this.signal.aborted || this.mode !== 'hold' || this.reducedMotion) return;
    const orb = this.host.querySelector<HTMLElement>('.voice-hold-orb');
    if (!orb || typeof orb.animate !== 'function') return;
    const destination = orb.getBoundingClientRect();
    if (!destination.width) return;
    const x = origin.x + origin.width / 2 - destination.x - destination.width / 2;
    const y = origin.y + origin.height / 2 - destination.y - destination.height / 2;
    this.holdEntryMotion?.cancel();
    const motion = orb.animate([
      { translate: `${x}px ${y}px`, scale: String(origin.width / destination.width), opacity: 0.75 },
      { translate: '0px 0px', scale: '1', opacity: 1 },
    ], { duration: 340, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    this.holdEntryMotion = motion;
    motion.onfinish = () => { if (this.holdEntryMotion === motion) this.holdEntryMotion = null; };
  }

  moveHold(deltaX: number): void {
    if (this.signal.aborted || this.mode !== 'hold' || this.holdReleased || !['requesting', 'recording'].includes(this.state)) return;
    const left = Math.max(0, -deltaX);
    // Keep the microphone visibly attached to the finger for a longer travel.
    // The logarithmic tail still prevents it from leaving the composer, but the
    // larger resistance length avoids the earlier near-stop after a short drag.
    const resistance = deltaX < 0 ? 220 : 72;
    const drag = Math.sign(deltaX) * resistance * Math.log1p(Math.abs(deltaX) / resistance);
    this.cancelReady = this.cancelReady ? left >= CANCEL_RESET_DISTANCE : left >= CANCEL_DISTANCE;
    this.host.style.setProperty('--voice-drag-x', `${drag}px`);
    this.host.style.setProperty('--voice-cancel-progress', String(Math.min(1, left / CANCEL_DISTANCE)));
    this.updateHoldFeedback();
  }

  releaseHold(cancelled = false): void {
    if (this.signal.aborted || this.mode !== 'hold' || this.holdReleased) return;
    this.holdReleased = true;
    if (cancelled) { this.cancel(); return; }
    if (this.cancelReady) { this.cancel(true); return; }
    // Releasing a hold must not begin recording after a late grant.
    // Privacy teardown still applies to hands-free
    // requests when a native permission prompt takes focus.
    if (this.state === 'requesting') { this.cancel(); return; }
    if (this.state === 'recording') this.pause(true);
  }

  private resetDrag(): void {
    this.cancelReady = false;
    this.host.dataset.gesture = 'hold';
    this.host.style.setProperty('--voice-drag-x', '0px');
    this.host.style.setProperty('--voice-cancel-progress', '0');
    this.updateHoldFeedback();
  }

  private updateHoldFeedback(): void {
    const label = this.host.querySelector<HTMLElement>('.voice-release-label');
    if (!label) return;
    const action = this.state === 'requesting' ? 'pending' : this.cancelReady ? 'cancel' : 'send';
    this.host.dataset.holdAction = action;
    const text = action === 'pending' ? '等待麦克风…'
      : action === 'cancel' ? '松手取消录制'
        : '松手发送，左滑取消录制';
    if (label.textContent !== text) label.textContent = text;
  }

  private cancel(animate = false): void {
    if (this.signal.aborted || this.state === 'sending') return;
    const animateExit = animate && this.host.isConnected && !this.reducedMotion;
    const dragX = this.host.style.getPropertyValue('--voice-drag-x');
    // Capture and plaintext end synchronously. The optional retiring shapes
    // contain no duration, waveform, recording, or actionable controls.
    this.destroy();
    if (animateExit) {
      this.host.dataset.gesture = 'cancelling';
      this.host.style.setProperty('--voice-drag-x', dragX);
      this.host.innerHTML = `<div class="voice-cancel-bar" aria-hidden="true"></div><div class="voice-cancel-orb" aria-hidden="true">${voiceIcons.mic}</div>`;
      this.cancelMotionTimer = window.setTimeout(() => {
        this.cancelMotionTimer = null;
        this.host.replaceChildren();
        this.callbacks.cancel();
      }, CANCEL_MOTION_MS);
      return;
    }
    this.callbacks.cancel();
  }

  async start(): Promise<void> {
    if (this.signal.aborted || this.sendAttempted || this.starting || !['requesting', 'paused'].includes(this.state)) return;
    this.starting = true;
    this.clearPreview();
    this.state = 'requesting';
    this.message = '';
    this.update();
    try {
      const ownershipInvalidated = Boolean(await this.callbacks.permission(true));
      if (ownershipInvalidated || this.signal.aborted) return;
      this.permissionTimer = window.setTimeout(() => this.fail('等待麦克风授权超时，请点击录音重试'), 30_000);
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        throw new Error('当前环境不能录音，请使用 HTTPS 和支持麦克风的新版浏览器');
      }
      // Let the OS select the complete input route. Hard channel/processing
      // constraints can reject or retain a stale built-in route when a
      // Bluetooth headset connects between recordings.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (this.signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const permissionInvalidated = Boolean(await this.endPermission());
      if (permissionInvalidated || this.signal.aborted) {
        stream.getTracks().forEach(track => track.stop());
        if (this.stream === stream) this.stream = null;
        return;
      }
      this.context = new AudioContext();
      void this.context.resume().catch(() => {});
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.context.createMediaStreamSource(stream).connect(this.analyser);
      const mimeType = AUDIO_MIME_TYPES.find(type => type !== 'audio/wav' && MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('当前浏览器没有可用的录音格式，请更新浏览器');
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      this.recorder = recorder;
      this.chunks = [];
      this.chunkBytes = 0;
      recorder.ondataavailable = event => {
        if (this.signal.aborted) return;
        this.chunkBytes += event.data.size;
        if (this.chunkBytes > MAX_AUDIO_BYTES) { this.fail('录音超过大小限制，请重新录制'); return; }
        if (event.data.size) this.chunks.push(event.data);
      };
      recorder.onerror = () => this.fail('麦克风录音中断，请检查设备后重试');
      recorder.onstop = () => {
        if (this.signal.aborted) return;
        // Never auto-send after interruptions or the duration limit.
        if (this.state === 'recording') {
          this.segmentDurationMs = performance.now() - this.startedAt;
          this.sendAfterProcessing = false;
          this.mode = 'locked';
          this.resetDrag();
          this.state = 'processing';
          this.message = '录音已停止，可试听后发送';
        }
        void this.finishSegment(recorder.mimeType);
      };
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (this.state === 'recording') { this.message = '麦克风已断开，已保留录音'; this.pause(); }
      }));
      this.startedAt = performance.now();
      this.state = 'recording';
      recorder.start(1000);
      this.timer = window.setInterval(() => {
        if (this.state !== 'recording') return;
        const values = new Uint8Array(256);
        this.analyser?.getByteTimeDomainData(values);
        let peak = 0;
        for (const value of values) peak = Math.max(peak, Math.abs(value - 128) / 128);
        this.liveLevels.push(Math.round(peak * 100));
        if (this.liveLevels.length > 48) this.liveLevels.shift();
        if (this.durationMs + performance.now() - this.startedAt >= MAX_AUDIO_DURATION_MS) {
          this.message = '已到 5 分钟上限，可试听后发送';
          this.pause();
        } else this.update();
      }, 100);
      this.update();
      if (this.mode === 'locked') this.host.querySelector<HTMLButtonElement>('.voice-toggle')?.focus({ preventScroll: true });
    } catch (cause) {
      if (this.signal.aborted) return;
      const name = cause instanceof DOMException ? cause.name : '';
      this.fail(name === 'NotAllowedError' ? '未获得麦克风权限，请在浏览器网站设置中允许麦克风后重试'
        : name === 'NotFoundError' ? '未找到麦克风，请连接麦克风后重试'
          : name === 'NotReadableError' ? '麦克风被占用或不可用，请关闭其他录音应用后重试'
            : cause instanceof Error ? cause.message : '无法开始录音，请重试');
    } finally { this.starting = false; }
  }

  private get durationMs(): number { return Math.round(this.samples.length / VOICE_SAMPLE_RATE * 1000); }

  private pause(sendAfterProcessing = false): void {
    if (this.state !== 'recording') return;
    const send = this.host.querySelector<HTMLButtonElement>('.voice-send')!;
    const previousBounds = this.mode === 'locked' && !this.reducedMotion ? send.getBoundingClientRect() : null;
    this.sendMotion?.cancel(); this.sendMotion = null;
    this.segmentDurationMs = performance.now() - this.startedAt;
    const interrupted = this.recorder?.state === 'inactive' || this.stream?.getAudioTracks().some(track => track.readyState === 'ended');
    const reachedLimit = this.durationMs + this.segmentDurationMs >= MAX_AUDIO_DURATION_MS;
    this.sendAfterProcessing = sendAfterProcessing && !interrupted && !reachedLimit;
    if (sendAfterProcessing && reachedLimit) this.message = '已到 5 分钟上限，可试听后发送';
    else if (sendAfterProcessing && interrupted) this.message = '录音已停止，可试听后发送';
    this.mode = 'locked';
    this.resetDrag();
    this.state = 'processing';
    this.stopTimer();
    if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    this.stream?.getTracks().forEach(track => track.stop());
    this.update();
    if (previousBounds?.width) {
      const bounds = send.getBoundingClientRect();
      if (bounds.width && bounds.height) {
        const x = previousBounds.x + previousBounds.width / 2 - bounds.x - bounds.width / 2;
        const y = previousBounds.y + previousBounds.height / 2 - bounds.y - bounds.height / 2;
        this.animateSend(`translate3d(${x}px, ${y}px, 0) scale(${previousBounds.width / bounds.width}, ${previousBounds.height / bounds.height})`);
      }
    }
  }

  private get reducedMotion(): boolean { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  private animateSend(fromTransform: string): void {
    if (this.signal.aborted || this.state === 'requesting' || this.reducedMotion) return;
    const send = this.host.querySelector<HTMLButtonElement>('.voice-send');
    if (!send || send.hidden || typeof send.animate !== 'function') return;
    this.sendMotion?.cancel();
    const motion = send.animate([{ transform: fromTransform }, { transform: 'translate3d(0, 0, 0) scale(1)' }], {
      duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
    this.sendMotion = motion;
    motion.onfinish = () => { if (this.sendMotion === motion) this.sendMotion = null; };
  }

  private async finishSegment(mimeType: string): Promise<void> {
    this.stopTimer();
    this.stream?.getTracks().forEach(track => track.stop());
    const context = this.context;
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    this.update();
    try {
      if (!context || !blob.size) throw new Error('没有录到声音，请重新录制');
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (this.signal.aborted) return;
      // Bound decoded length by both the measured segment and the total limit.
      const length = Math.min(MAX_VOICE_SAMPLES - this.samples.length,
        Math.floor(Math.min(decoded.duration, this.segmentDurationMs / 1000) * VOICE_SAMPLE_RATE));
      if (length < 1) throw new Error('录音太短，请重新录制');
      const offline = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE);
      const source = offline.createBufferSource(); source.buffer = decoded;
      source.connect(offline.destination); source.start();
      const rendered = await offline.startRendering();
      if (this.signal.aborted) return;
      const combined = new Float32Array(this.samples.length + length);
      combined.set(this.samples); combined.set(rendered.getChannelData(0), this.samples.length);
      this.samples = combined;
      this.draft = null;
      this.waveform = null;
      this.state = 'paused';
    } catch (cause) {
      if (!this.signal.aborted) this.fail(cause instanceof Error ? cause.message : '录音处理失败，请重新录制');
    } finally {
      if (context?.state !== 'closed') void context?.close().catch(() => {});
      if (this.context === context) this.context = null;
      this.stream = null;
      this.recorder = null;
      this.analyser = null;
    }
    if (this.signal.aborted) return;
    const shouldSend = this.sendAfterProcessing;
    this.sendAfterProcessing = false;
    if (shouldSend && this.durationMs >= MIN_AUDIO_DURATION_MS) await this.send();
    else this.update();
  }

  private getDraft(): VoiceDraft {
    this.draft ??= {
      file: new File([encodeVoiceWav(this.samples)], '语音消息.wav', { type: 'audio/wav' }),
      durationMs: this.durationMs, waveform: this.getWaveform(), clientMsgId: this.clientMsgId,
    };
    return this.draft;
  }

  private async playPreview(): Promise<void> {
    if (this.state !== 'paused') return;
    if (!this.preview.paused) { this.preview.pause(); return; }
    try {
      if (!this.previewUrl) {
        this.previewUrl = URL.createObjectURL(this.getDraft().file);
        this.preview.src = this.previewUrl;
      }
      if (this.preview.ended) this.preview.currentTime = 0;
      await this.preview.play();
    } catch {
      if (!this.signal.aborted) { this.message = '无法试听，请再次点击播放'; this.update(); }
    }
  }

  private async send(): Promise<void> {
    if (this.signal.aborted) return;
    if (this.state === 'recording') { this.pause(true); return; }
    if (this.state !== 'paused' || this.durationMs < MIN_AUDIO_DURATION_MS) return;
    const restoreSendFocus = this.host.contains(document.activeElement);
    this.preview.pause();
    this.sendMotion?.cancel(); this.sendMotion = null;
    this.sendAttempted = true;
    this.state = 'sending'; this.message = '正在加密并上传，完成后进入待发箱'; this.update();
    try {
      await this.callbacks.send(this.getDraft(), this.signal);
    } catch (cause) {
      if (this.signal.aborted) return;
      this.state = 'paused';
      this.message = `${cause instanceof Error ? cause.message : '语音发送失败'}。录音已保留，可再次发送`;
      this.update();
      if (restoreSendFocus) this.host.querySelector<HTMLButtonElement>('.voice-send')?.focus({ preventScroll: true });
    }
  }

  private update(): void {
    if (this.signal.aborted) return;
    this.host.dataset.state = this.state;
    this.host.dataset.mode = this.mode;
    const submitting = this.state === 'sending' || (this.state === 'processing' && this.sendAfterProcessing);
    this.host.dataset.submitting = String(submitting);
    this.host.setAttribute('aria-busy', String(submitting));
    const labels: Record<State, string> = { requesting: '等待麦克风权限', recording: '正在录音', processing: '正在处理录音', paused: '录音已暂停', sending: '正在发送语音' };
    const status = this.host.querySelector<HTMLElement>('.voice-recording-state')!;
    if (status.textContent !== labels[this.state]) status.textContent = labels[this.state];
    const elapsed = this.state === 'recording' ? this.durationMs + performance.now() - this.startedAt : this.durationMs;
    this.host.querySelector('time')!.textContent = `${voiceTime(elapsed)},${String(Math.floor(elapsed % 1000 / 10)).padStart(2, '0')}`;
    const levels = this.state === 'recording'
      ? [...Array(Math.max(0, 48 - this.liveLevels.length)).fill(0), ...this.liveLevels] : this.getWaveform();
    const waveformKey = levels.join(',');
    if (this.renderedWaveform !== waveformKey) {
      levels.forEach((level, index) => this.waveBars[index]?.style.setProperty('--level', `${Math.max(6, Math.min(100, level))}%`));
      this.renderedWaveform = waveformKey;
    }
    const progress = this.durationMs ? this.preview.currentTime * 1000 / this.durationMs : 0;
    this.waveBars.forEach((bar, index) => bar.classList.toggle('is-played', index / 48 < progress));
    const holding = this.mode === 'hold' && ['requesting', 'recording'].includes(this.state);
    if (holding) this.updateHoldFeedback();
    const drafting = ['processing', 'paused'].includes(this.state) && !submitting;
    this.host.querySelector<HTMLElement>('.voice-recording-info')!.hidden = drafting || submitting;
    this.host.querySelector<HTMLElement>('.voice-slide-hint')!.hidden = !holding;
    this.host.querySelector<HTMLElement>('.voice-hold-orb')!.hidden = !holding;
    this.host.querySelector<HTMLElement>('.voice-draft-timeline')!.hidden = !drafting;
    this.host.querySelector<HTMLElement>('.voice-cancel')!.hidden = holding || drafting || submitting;
    const submitLabel = this.host.querySelector<HTMLElement>('.voice-submit-label')!;
    submitLabel.hidden = !submitting;
    submitLabel.textContent = submitting ? this.state === 'sending' ? '正在发送语音…' : '正在处理录音…' : '';
    const toggle = this.host.querySelector<HTMLButtonElement>('.voice-toggle')!;
    toggle.hidden = holding || this.state === 'requesting' || submitting;
    toggle.disabled = this.sendAttempted || !['recording', 'paused'].includes(this.state) || this.durationMs >= MAX_AUDIO_DURATION_MS;
    const toggleIcon = this.state === 'recording' ? voiceIcons.pause : voiceIcons.mic;
    if (this.renderedToggleIcon !== toggleIcon) { toggle.innerHTML = toggleIcon; this.renderedToggleIcon = toggleIcon; }
    toggle.setAttribute('aria-label', this.state === 'recording' ? '暂停录音' : '继续录音');
    toggle.title = this.state === 'recording' ? '暂停以试听或继续录音' : '继续录音';
    const play = this.host.querySelector<HTMLButtonElement>('.voice-preview')!;
    play.disabled = this.state !== 'paused' || !this.samples.length;
    const previewIcon = this.preview.paused ? voiceIcons.play : voiceIcons.pause;
    if (this.renderedPreviewIcon !== previewIcon) {
      this.host.querySelector('.voice-preview-icon')!.innerHTML = previewIcon;
      this.renderedPreviewIcon = previewIcon;
    }
    this.host.querySelector('.voice-preview-time')!.textContent = voiceTime(!this.preview.paused ? this.preview.currentTime * 1000 : this.durationMs);
    play.setAttribute('aria-label', this.preview.paused ? '试听录音' : '暂停试听');
    const send = this.host.querySelector<HTMLButtonElement>('.voice-send')!;
    send.hidden = holding || this.state === 'requesting' || submitting;
    send.disabled = this.state === 'recording' ? elapsed < MIN_AUDIO_DURATION_MS : this.state !== 'paused' || this.durationMs < MIN_AUDIO_DURATION_MS;
    const sendIcon = drafting ? voiceIcons.paperPlane : voiceIcons.send;
    if (this.renderedSendIcon !== sendIcon) { send.innerHTML = sendIcon; this.renderedSendIcon = sendIcon; }
    const discard = this.host.querySelector<HTMLButtonElement>('.voice-discard')!;
    discard.hidden = !drafting;
    discard.disabled = this.state === 'sending';
    const hint = submitting ? '' : this.message || (this.state === 'requesting' ? '请允许麦克风访问' : this.state === 'processing' ? '正在处理录音…'
      : this.state === 'paused' && this.durationMs < MIN_AUDIO_DURATION_MS ? '录音太短，请继续录制至少半秒' : '');
    const hintElement = this.host.querySelector<HTMLElement>('.voice-recording-hint')!;
    hintElement.hidden = !hint;
    if (hintElement.textContent !== hint) hintElement.textContent = hint;
  }

  private getWaveform(): number[] {
    return this.waveform ??= voiceWaveform(this.samples);
  }

  private endPermission(): boolean | void | Promise<boolean | void> {
    if (this.permissionTimer !== null) window.clearTimeout(this.permissionTimer);
    this.permissionTimer = null;
    return this.callbacks.permission(false);
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private clearPreview(): void {
    this.preview.pause(); this.preview.removeAttribute('src'); this.preview.load();
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  private fail(message: string): void {
    this.destroy();
    this.callbacks.fail(message);
  }

  destroy(): void {
    // Teardown must also remove an already-aborted cancellation animation.
    if (this.cancelMotionTimer !== null) window.clearTimeout(this.cancelMotionTimer);
    this.cancelMotionTimer = null;
    this.host.replaceChildren();
    if (this.signal.aborted) return;
    this.abort.abort(); this.endPermission(); this.stopTimer();
    this.sendMotion?.cancel(); this.sendMotion = null;
    this.holdEntryMotion?.cancel(); this.holdEntryMotion = null;
    if (this.recorder) {
      this.recorder.ondataavailable = null; this.recorder.onstop = null; this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    }
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context?.state !== 'closed') void this.context?.close().catch(() => {});
    this.clearPreview();
    this.samples = new Float32Array(0); this.chunks = []; this.liveLevels = []; this.draft = null; this.waveform = null;
    this.sendAfterProcessing = false;
    this.recorder = null; this.stream = null; this.context = null; this.analyser = null;
  }
}
