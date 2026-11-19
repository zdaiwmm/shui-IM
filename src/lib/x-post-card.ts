import { ChevronLeft, ChevronRight, createElement, Maximize, Play, Volume2, VolumeX, X } from 'lucide';
import { fromBase64Url } from './base64';
import { uiLiteral } from './language';
import { xArticleAuthor, type LinkPreview, type XPostPreview, type XPostVideoPreview } from './link-preview-data';
import type { YouTubePreview } from './link-preview-ui';
import { videoDurationLabel } from './video-download-policy';
import { newTabLink } from './web-links';

type CardOptions = {
  signal: AbortSignal;
  readText?(signal: AbortSignal): Promise<string>;
  openArticle?(origin: HTMLElement): (restoreFocus?: boolean) => void;
  loadVideo(id: string, signal: AbortSignal): Promise<string>;
  beforeLayoutChange?: () => void;
  onLayoutChange?: () => void;
};

type VideoCardData = {
  url: string; source: string; title?: string; description: string; image?: LinkPreview['image'];
  videos: XPostVideoPreview[]; originalLabel?: string; canCloseVideo?: boolean;
};

type NativeVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
};

type CardView = { conceal(): void; reveal(): void };
const views = new Set<CardView>();
let concealed = false;
let stopActiveVideo: (() => void) | undefined;

export function concealXPostCards(): void {
  concealed = true;
  for (const view of views) view.conceal();
}

export function revealXPostCards(): void {
  concealed = false;
  for (const view of views) view.reveal();
}

function element<K extends keyof HTMLElementTagNameMap>(name: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  node.className = className;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const node = element('button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  return node;
}

function icon(symbol: Parameters<typeof createElement>[0]): SVGElement {
  const graphic = createElement(symbol);
  graphic.setAttribute('aria-hidden', 'true');
  return graphic;
}

export function renderXPostCard(preview: LinkPreview & { xPost: XPostPreview }, options: CardOptions): HTMLElement {
  const author = xArticleAuthor(preview);
  return renderVideoCard({
    url: preview.url, source: author ? preview.siteName : `${preview.siteName} · ${preview.title}`,
    ...(author ? { title: preview.title } : {}), description: preview.description, image: preview.image,
    videos: preview.xPost.videos,
  }, { ...options, openArticle: author ? options.openArticle : undefined,
    readText: !author && preview.xPost.canRead ? options.readText : undefined });
}

function cardIsLive(card: HTMLElement, signal: AbortSignal): boolean {
  return card.isConnected && !signal.aborted && !concealed && !document.hidden
    && !document.documentElement.classList.contains('privacy-obscured');
}

function watchCard(card: HTMLElement, signal: AbortSignal, view: CardView, dispose?: () => void): void {
  const release = () => {
    observer.disconnect();
    views.delete(view);
    signal.removeEventListener('abort', release);
    view.conceal();
    dispose?.();
  };
  const observer = new MutationObserver(() => { if (!card.isConnected) release(); });
  queueMicrotask(() => {
    if (signal.aborted || !card.isConnected) { release(); return; }
    observer.observe(card.getRootNode(), { childList: true, subtree: true });
    signal.addEventListener('abort', release, { once: true });
    views.add(view);
    view.reveal();
  });
}

export function renderYouTubeCard(url: string, id: string, options: CardOptions & {
  loadPreview(signal: AbortSignal): Promise<YouTubePreview>;
}): HTMLElement {
  const wrapper = element('div', 'youtube-card');
  const fallback = renderVideoCard({ url, source: 'YouTube', originalLabel: 'YouTube', description: '', videos: [] }, options);
  const status = element('p', 'x-post-feedback');
  status.setAttribute('role', 'status');
  const retry = button('x-post-text-toggle', uiLiteral('重试'));
  retry.textContent = uiLiteral('重试');
  retry.hidden = true;
  fallback.append(status, retry);
  wrapper.append(fallback);
  let visible = false;
  let complete = false;
  let failed = false;
  let request: AbortController | undefined;
  const live = () => cardIsLive(wrapper, options.signal);
  async function load() {
    if (!visible || !live() || complete || failed || request) return;
    const controller = new AbortController();
    request = controller;
    const current = () => !controller.signal.aborted && live();
    retry.hidden = true;
    status.textContent = uiLiteral('正在解析链接…');
    try {
      const video = await options.loadPreview(controller.signal);
      if (!current()) return;
      const description = video.description.replace(/\s+/g, ' ').trim().slice(0, 160).replace(/[\ud800-\udbff]$/u, '');
      const card = renderVideoCard({
        url, source: video.channel ? `YouTube · ${video.channel}` : 'YouTube', title: video.title, description,
        videos: video.playable ? [{ id, durationMs: video.durationMs, poster: video.poster }] : [],
        originalLabel: 'YouTube', canCloseVideo: true,
      }, { ...options, readText: video.description !== description ? async () => video.description : undefined });
      if (!video.playable) {
        status.textContent = uiLiteral('媒体载入失败，请重试');
        card.append(status);
      }
      options.beforeLayoutChange?.();
      complete = true;
      const restoreFocus = wrapper.contains(document.activeElement);
      wrapper.replaceChildren(card);
      if (restoreFocus) card.querySelector<HTMLElement>('.x-post-original')?.focus({ preventScroll: true });
      options.onLayoutChange?.();
      intersection.disconnect();
    } catch {
      if (current()) {
        options.beforeLayoutChange?.();
        failed = true;
        status.textContent = uiLiteral('暂时无法生成卡片，已保留链接。');
        retry.hidden = false;
        options.onLayoutChange?.();
      }
    } finally {
      if (request === controller) request = undefined;
    }
  }
  function cancel() {
    request?.abort();
    request = undefined;
  }
  const intersection = new IntersectionObserver(entries => {
    visible = Boolean(entries.at(-1)?.isIntersecting);
    if (visible) void load();
    else cancel();
  }, { rootMargin: '150px' });
  retry.addEventListener('click', () => { failed = false; void load(); });
  intersection.observe(wrapper);
  watchCard(wrapper, options.signal, { conceal: cancel, reveal: () => void load() }, () => intersection.disconnect());
  return wrapper;
}

function renderVideoCard(preview: VideoCardData, options: CardOptions): HTMLElement {
  const card = element('div', 'x-post-card');
  const live = () => cardIsLive(card, options.signal);
  const changeLayout = (update: () => void) => {
    const connected = card.isConnected;
    if (connected) options.beforeLayoutChange?.();
    update();
    if (connected) options.onLayoutChange?.();
  };
  const head = element('div', 'x-post-head');
  const source = element('strong', 'x-post-source');
  source.textContent = preview.source;
  const original = newTabLink(preview.url);
  original.className = 'x-post-original';
  const originalLabel = preview.originalLabel ?? uiLiteral('查看原帖');
  original.textContent = `${originalLabel} ↗`;
  original.setAttribute('aria-label', `${originalLabel} · ${uiLiteral('在新标签页打开')}`);
  head.append(source, original);
  card.append(head);
  if (preview.title) {
    const title = element('strong', 'x-post-article-title');
    title.textContent = preview.title;
    card.append(title);
  }

  const summary = element('p', 'x-post-copy');
  summary.textContent = preview.description;
  summary.hidden = !preview.description;
  card.append(summary);
  let collapseText: (() => void) | undefined;
  let closeArticle: ((restoreFocus?: boolean) => void) | undefined;
  const { openArticle, readText } = options;
  if (openArticle) {
    const toggle = button('x-post-text-toggle', uiLiteral('查看全文'));
    toggle.textContent = uiLiteral('查看全文');
    toggle.setAttribute('aria-haspopup', 'dialog');
    summary.dataset.truncated = 'true';
    toggle.addEventListener('click', () => {
      if (!live()) return;
      stopActiveVideo?.();
      closeArticle?.(false);
      closeArticle = openArticle(toggle);
    });
    card.append(toggle);
  } else if (readText) {
    const toggle = button('x-post-text-toggle', uiLiteral('查看全文'));
    const full = element('p', 'x-post-copy');
    const feedback = element('p', 'x-post-feedback');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    summary.dataset.truncated = 'true';
    let request: AbortController | undefined;
    const setExpanded = (expanded: boolean) => {
      const label = expanded ? uiLiteral('收起全文') : uiLiteral('查看全文');
      toggle.textContent = label;
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('aria-expanded', String(expanded));
      full.hidden = !expanded;
      if (!expanded) full.textContent = '';
      summary.hidden = expanded || !preview.description;
    };
    collapseText = () => {
      request?.abort();
      request = undefined;
      if (full.hidden && feedback.hidden) return;
      changeLayout(() => { feedback.hidden = true; setExpanded(false); });
    };
    setExpanded(false);
    toggle.addEventListener('click', async () => {
      if (!live()) return;
      if (!full.hidden) { collapseText?.(); return; }
      const controller = new AbortController();
      request = controller;
      changeLayout(() => {
        setExpanded(true);
        full.textContent = uiLiteral('正在加载…');
        feedback.hidden = true;
      });
      try {
        const text = await readText(controller.signal);
        if (!live() || controller.signal.aborted) return;
        changeLayout(() => { full.textContent = text; });
      } catch {
        if (!live() || controller.signal.aborted) return;
        changeLayout(() => {
          setExpanded(false);
          feedback.textContent = uiLiteral('暂时无法读取全文');
          feedback.hidden = false;
        });
      } finally {
        if (request === controller) request = undefined;
      }
    });
    card.append(toggle, full, feedback);
  }

  const media = preview.videos.length ? mountPostMedia(card, preview, options, live, changeLayout) : undefined;
  if (openArticle || collapseText || media) {
    const view = {
      conceal: () => {
        closeArticle?.(false);
        closeArticle = undefined;
        collapseText?.();
        media?.conceal();
      },
      reveal: () => { if (live()) media?.reveal(); },
    };
    watchCard(card, options.signal, view, media?.dispose);
  }
  return card;
}

function mountPostMedia(
  card: HTMLElement, preview: VideoCardData, options: CardOptions,
  live: () => boolean, changeLayout: (update: () => void) => void,
) {
  const media = element('div', 'x-post-media');
  media.dir = 'ltr';
  media.setAttribute('role', 'group');
  media.setAttribute('aria-label', uiLiteral('视频'));
  const track = element('div', 'x-post-track');
  const note = element('p', 'x-post-feedback');
  note.setAttribute('role', 'status');
  note.hidden = true;
  const setNote = (message = '') => {
    if (note.textContent === message && note.hidden === !message) return;
    changeLayout(() => {
      note.textContent = message;
      note.hidden = !message;
    });
  };
  let index = 0;
  let stopVideo: (() => void) | undefined;
  let resize: ResizeObserver | undefined;
  const updateAspectRatio = (ratio: number | undefined) => {
    const aspectRatio = ratio === undefined ? '' : String(ratio);
    if (track.style.getPropertyValue('--x-post-ratio') === aspectRatio) return;
    changeLayout(() => { track.style.setProperty('--x-post-ratio', aspectRatio); });
  };
  const slides = preview.videos.map((clip, position) => {
    const stage = element('div', 'x-post-stage');
    stage.inert = position !== 0;
    if (stage.inert) stage.setAttribute('aria-hidden', 'true');
    const image = element('img', 'x-post-poster');
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    const poster = clip.poster ?? (position === 0 ? preview.image : undefined);
    let aspectRatio = poster ? poster.width / poster.height : undefined;
    if (poster) stage.append(image);
    let posterUrl: string | undefined;
    let resumeAt = 0;
    const play = button('x-post-play', uiLiteral('播放视频'));
    const duration = clip.durationMs ? element('span', 'x-post-duration') : undefined;
    if (duration) {
      duration.textContent = videoDurationLabel(clip.durationMs);
      stage.append(duration);
    }
    const full = button('x-post-fullscreen', uiLiteral('全屏播放'));
    const mute = button('x-post-mute', uiLiteral('开启声音'));
    const close = preview.canCloseVideo ? button('youtube-stop', uiLiteral('关闭')) : undefined;
    if (close) { close.append(icon(X)); close.hidden = true; }
    mute.hidden = true;
    play.append(icon(Play));
    full.append(icon(Maximize));
    full.hidden = true;
    const setPlayState = (state: 'idle' | 'loading' | 'retry' | 'playing') => {
      play.hidden = state === 'playing';
      if (duration) duration.hidden = state === 'playing' || state === 'retry';
      play.dataset.state = state;
      play.setAttribute('aria-disabled', String(state === 'loading'));
      play.setAttribute('aria-label', state === 'loading' ? uiLiteral('正在加载视频')
        : state === 'retry' ? uiLiteral('点按播放视频') : uiLiteral('播放视频'));
    };
    let retryPlayback: (() => void) | undefined;
    play.addEventListener('click', async () => {
      if (position !== index || !live() || play.dataset.state === 'loading') return;
      if (retryPlayback) { retryPlayback(); return; }
      stopActiveVideo?.();
      setNote();
      setPlayState('loading');
      const controller = new AbortController();
      const video: NativeVideo = element('video', 'x-post-video');
      video.playsInline = true;
      video.defaultMuted = video.muted = true;
      video.dataset.userPlayback = 'true';
      video.controls = true;
      video.preload = 'none';
      video.crossOrigin = 'anonymous';
      video.disablePictureInPicture = true;
      video.disableRemotePlayback = true;
      if (posterUrl) video.poster = posterUrl;
      video.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback');
      video.setAttribute('aria-label', uiLiteral('视频'));
      video.hidden = true;
      stage.insertBefore(video, play);
      const current = () => !controller.signal.aborted && live() && position === index;
      const stop = () => {
        controller.abort();
        if (video.ended) resumeAt = 0;
        else if (video.currentTime > 0) resumeAt = video.currentTime;
        video.pause();
        if (video.webkitDisplayingFullscreen) {
          try { video.webkitExitFullscreen?.(); } catch { /* Removing the source also stops native playback. */ }
        }
        if (document.fullscreenElement === video) void document.exitFullscreen().catch(() => undefined);
        video.removeAttribute('src');
        video.load();
        const restoreFocus = document.activeElement === video || document.activeElement === full
          || document.activeElement === mute || document.activeElement === close;
        video.remove();
        full.hidden = mute.hidden = true;
        if (close) close.hidden = true;
        retryPlayback = undefined;
        setPlayState('idle');
        if (restoreFocus && live()) play.focus({ preventScroll: true });
        if (stopVideo === stop) stopVideo = undefined;
        if (stopActiveVideo === stop) stopActiveVideo = undefined;
      };
      stopActiveVideo = stopVideo = stop;
      if (close) {
        close.hidden = false;
        close.addEventListener('click', stop, { signal: controller.signal });
      }
      const fail = () => {
        if (!current()) return;
        stop();
        setNote(uiLiteral('媒体载入失败，请重试'));
      };
      const playVideo = () => {
        setNote();
        setPlayState('loading');
        void video.play().catch(error => {
          if (!current()) return;
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            setPlayState('retry');
            setNote(uiLiteral('点按播放视频'));
          } else fail();
        });
      };
      const updateMute = () => {
        const silent = video.muted || video.volume === 0;
        mute.setAttribute('aria-label', silent ? uiLiteral('开启声音') : uiLiteral('静音'));
        mute.replaceChildren(icon(silent ? VolumeX : Volume2));
      };
      updateMute();
      mute.addEventListener('click', () => {
        if (!current()) return;
        const silent = video.muted || video.volume === 0;
        if (silent && video.volume === 0) video.volume = 1;
        video.muted = !silent;
        updateMute();
      }, { signal: controller.signal });
      video.addEventListener('volumechange', updateMute, { signal: controller.signal });
      const updateVideoAspect = () => {
        if (!current() || !video.videoWidth || !video.videoHeight) return;
        aspectRatio = video.videoWidth / video.videoHeight;
        updateAspectRatio(aspectRatio);
      };
      video.addEventListener('resize', updateVideoAspect, { signal: controller.signal });
      video.addEventListener('loadedmetadata', () => {
        if (!current()) return;
        updateVideoAspect();
        if (resumeAt > 0 && resumeAt < video.duration) video.currentTime = resumeAt;
        full.hidden = mute.hidden = false;
      }, { signal: controller.signal });
      video.addEventListener('playing', () => {
        video.dataset.actualPlayback = 'true';
        setPlayState('playing');
        if (document.activeElement === play) video.focus({ preventScroll: true });
      }, { signal: controller.signal });
      for (const type of ['pause', 'waiting', 'stalled', 'ended', 'emptied']) {
        video.addEventListener(type, () => { delete video.dataset.actualPlayback; }, { signal: controller.signal });
      }
      video.addEventListener('error', fail, { signal: controller.signal });
      full.addEventListener('click', () => {
        if (!current()) return;
        const unavailable = () => { if (current()) setNote(uiLiteral('暂时无法进入全屏')); };
        setNote();
        if (video.webkitEnterFullscreen) {
          try { video.webkitEnterFullscreen(); return; } catch { /* Desktop WebKit can use element fullscreen. */ }
        }
        try {
          if (document.fullscreenEnabled && video.requestFullscreen) {
            void video.requestFullscreen().then(() => {
              if (!current() && document.fullscreenElement === video) void document.exitFullscreen().catch(() => undefined);
            }, unavailable);
          } else unavailable();
        } catch { unavailable(); }
      }, { signal: controller.signal });
      // Open WebKit's per-element media permission inside the tap. The source arrives with the ticket.
      video.load();
      try {
        const url = await options.loadVideo(clip.id, controller.signal);
        if (!current()) return;
        video.src = url;
        video.hidden = false;
        retryPlayback = playVideo;
        playVideo();
      } catch { fail(); }
    });
    stage.append(play, full, mute);
    if (close) stage.append(close);
    track.append(stage);
    return {
      stage,
      get aspectRatio() { return aspectRatio; },
      reveal: () => {
        if (!poster || posterUrl) return;
        posterUrl = URL.createObjectURL(new Blob([fromBase64Url(poster.data)], { type: poster.mimeType }));
        image.src = posterUrl;
      },
      conceal: () => {
        image.removeAttribute('src');
        if (posterUrl) URL.revokeObjectURL(posterUrl);
        posterUrl = undefined;
        resumeAt = 0;
      },
    };
  });
  updateAspectRatio(slides[0]?.aspectRatio);
  media.append(track);
  if (slides.length > 1) {
    track.tabIndex = 0;
    const page = element('span', 'x-post-page');
    page.setAttribute('aria-live', 'polite');
    const previous = button('x-post-edge x-post-edge-previous', uiLiteral('上一个视频'));
    const next = button('x-post-edge x-post-edge-next', uiLiteral('下一个视频'));
    previous.append(icon(ChevronLeft));
    next.append(icon(ChevronRight));
    const updatePage = () => {
      page.textContent = `${index + 1} / ${slides.length}`;
      previous.setAttribute('aria-disabled', String(index === 0));
      next.setAttribute('aria-disabled', String(index === slides.length - 1));
    };
    const select = (target: number) => {
      const from = slides[index];
      const to = slides[target];
      if (!from || !to || target === index) return;
      const shiftFocus = from.stage.contains(document.activeElement);
      stopVideo?.();
      from.stage.inert = true;
      from.stage.setAttribute('aria-hidden', 'true');
      to.stage.inert = false;
      to.stage.removeAttribute('aria-hidden');
      index = target;
      updateAspectRatio(to.aspectRatio);
      updatePage();
      setNote();
      if (shiftFocus || (document.activeElement === previous && target === 0)
        || (document.activeElement === next && target === slides.length - 1)) track.focus({ preventScroll: true });
    };
    const snapToPage = () => { track.scrollLeft = index * track.clientWidth; };
    const go = (delta: number) => {
      select(index + delta);
      snapToPage();
    };
    track.addEventListener('scroll', () => {
      if (track.clientWidth) select(Math.round(track.scrollLeft / track.clientWidth));
    }, { passive: true });
    previous.addEventListener('click', () => go(-1));
    next.addEventListener('click', () => go(1));
    media.addEventListener('keydown', event => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.target instanceof HTMLVideoElement) return;
      event.preventDefault();
      go(event.key === 'ArrowLeft' ? -1 : 1);
    });
    let trackWidth = 0;
    resize = new ResizeObserver(() => {
      const width = track.clientWidth;
      if (width === trackWidth) return;
      trackWidth = width;
      snapToPage();
    });
    resize.observe(track);
    updatePage();
    media.append(page, previous, next);
  }
  card.append(media, note);
  return {
    reveal: () => { for (const slide of slides) slide.reveal(); },
    conceal: () => {
      stopVideo?.();
      for (const slide of slides) slide.conceal();
      setNote();
    },
    dispose: () => resize?.disconnect(),
  };
}
