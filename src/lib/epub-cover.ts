// Covers are derived only from authenticated originals, during the unlocked runtime.
let running = 0;
const queue: Array<() => Promise<void>> = [];
function pump(): void {
  while (running < 2 && queue.length) {
    running++;
    void queue.shift()!().finally(() => { running--; pump(); });
  }
}

export function observeEpubCover(host: HTMLElement, load: (signal: AbortSignal) => Promise<Blob>, signal: AbortSignal): void {
  if (signal.aborted) return;
  let url: string | undefined;
  let scheduled = false;
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);
  const observer = new IntersectionObserver(entries => {
    if (scheduled || !entries.some(entry => entry.isIntersecting)) return;
    scheduled = true; observer.disconnect();
    queue.push(async () => {
      if (workSignal.aborted || !host.isConnected) return;
      const deadline = window.setTimeout(() => controller.abort(), 30_000);
      let reader: import('./epub-reader').EpubReader | undefined;
      try {
        const blob = await load(workSignal);
        if (workSignal.aborted || !host.isConnected) return;
        const { EpubReader } = await import('./epub-reader');
        if (workSignal.aborted || !host.isConnected) return;
        reader = new EpubReader(() => undefined);
        workSignal.addEventListener('abort', () => reader?.destroy(), { once: true });
        await reader.load(new Uint8Array(await blob.arrayBuffer()));
        const cover = await reader.cover();
        if (!cover || workSignal.aborted || !host.isConnected) return;
        const decoded = document.createElement('img');
        const source = URL.createObjectURL(cover); decoded.src = source;
        const canvas = document.createElement('canvas');
        try {
          await decoded.decode();
          if (workSignal.aborted || !host.isConnected) return;
          const ratio = Math.min(1, 128 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
          canvas.width = Math.max(1, Math.round(decoded.naturalWidth * ratio));
          canvas.height = Math.max(1, Math.round(decoded.naturalHeight * ratio));
          canvas.getContext('2d')!.drawImage(decoded, 0, 0, canvas.width, canvas.height);
          const preview = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
          if (!preview || workSignal.aborted || !host.isConnected) return;
          const image = document.createElement('img');
          url = URL.createObjectURL(preview); image.src = url; image.alt = ''; image.className = 'file-epub-cover';
          host.querySelector('.file-format-icon')?.replaceWith(image);
        } finally { URL.revokeObjectURL(source); decoded.removeAttribute('src'); canvas.width = canvas.height = 0; }
      } catch { /* Invalid or absent covers retain the ordinary EPUB icon. */ }
      finally { reader?.destroy(); clearTimeout(deadline); }
    });
    pump();
  }, { rootMargin: '80px' });
  observer.observe(host);
  signal.addEventListener('abort', () => {
    observer.disconnect(); controller.abort();
    if (url) URL.revokeObjectURL(url);
    host.querySelector('.file-epub-cover')?.remove();
  }, { once: true });
}
