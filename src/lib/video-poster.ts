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
    // Time zero may expose an undecoded/empty frame, especially for camera
    // recordings. Seek a little into the original before capturing its poster.
    const target = Number.isFinite(video.duration) ? Math.min(0.1, video.duration / 2) : 0.1;
    if (target > 0) await new Promise<void>((resolve, reject) => {
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
    signal?.throwIfAborted();
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频没有可显示的画面');
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('视频预览不可用');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
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
