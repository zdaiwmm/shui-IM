/** A local, memory-only thumbnail. The caller supplies an already verified Blob URL. */
export async function createVideoPoster(url: string, signal?: AbortSignal): Promise<{ blob: Blob; width: number; height: number }> {
  signal?.throwIfAborted();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('error', failed);
        error ? reject(error) : resolve();
      };
      const aborted = () => finish(new DOMException('Session locked', 'AbortError'));
      const failed = () => finish(new Error('此浏览器无法预览该视频'));
      const loaded = () => finish();
      const timer = window.setTimeout(failed, 12_000);
      signal?.addEventListener('abort', aborted, { once: true });
      video.addEventListener('loadeddata', loaded, { once: true });
      video.addEventListener('error', failed, { once: true });
      video.src = url;
    });
    signal?.throwIfAborted();
    const seekTo = (target: number) => new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        video.removeEventListener('seeked', seeked);
        video.removeEventListener('error', failed);
        error ? reject(error) : resolve();
      };
      const aborted = () => finish(new DOMException('Session locked', 'AbortError'));
      const failed = () => finish(new Error('此浏览器无法预览该视频'));
      const seeked = () => finish();
      const timer = window.setTimeout(failed, 12_000);
      signal?.addEventListener('abort', aborted, { once: true });
      video.addEventListener('seeked', seeked, { once: true });
      video.addEventListener('error', failed, { once: true });
      try { video.currentTime = target; } catch { failed(); }
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频没有可显示的画面');
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('视频预览不可用');
    // Time zero and the first seeked event can still expose an undecoded black
    // frame for camera/WebM recordings. Try a few bounded positions and give
    // the decoder two paint frames before accepting a poster. A genuinely dark
    // video remains valid after the final candidate.
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const candidates = duration
      ? [Math.min(0.1, duration / 2), duration / 2, Math.max(0, duration - 0.08)]
      : [0.1];
    const hasVisiblePixels = () => {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const stride = Math.max(4, Math.floor(pixels.length / 256 / 4) * 4);
      for (let index = 0; index < pixels.length; index += stride) {
        if (pixels[index]! > 12 || pixels[index + 1]! > 12 || pixels[index + 2]! > 12) return true;
      }
      return false;
    };
    for (const [index, target] of candidates.entries()) {
      if (target > 0 && Math.abs(video.currentTime - target) > 0.002) await seekTo(target);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      signal?.throwIfAborted();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (hasVisiblePixels() || index === candidates.length - 1) break;
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      result => result ? resolve(result) : reject(new Error('视频预览不可用')), 'image/jpeg', 0.82));
    signal?.throwIfAborted();
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}
