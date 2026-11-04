import { createElement, Film, LockKeyhole, MoreHorizontal, Check } from 'lucide';
import { closeDialog, mountDialog } from './dialog';
import { bindHalfSheetHandle } from './half-sheet';
import { createVideoPoster } from './video-poster';
import { toBase64Url } from './base64';
import { uiLiteral } from './language';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './message-payload';
import {
  compactMp4,
  verifyMp4,
  clipSize,
  directBlob,
  LOCAL_VIDEO_LIMIT,
  resolveClips,
  type LinkClip,
} from './link-video';
import {
  listLinkVideos,
  readLinkVideo,
  storeLinkVideo,
  type VaultSession,
  type SavedLinkVideo,
} from './vault';

type Options = {
  root: HTMLElement;
  session: VaultSession;
  signal: AbortSignal;
  active: () => boolean;
  send: (file: File, id: string, signal: AbortSignal) => Promise<boolean>;
  largeVideoReady: () => boolean;
  start?: SavedLinkVideo;
  onDispose: () => void;
};
const el = <K extends keyof HTMLElementTagNameMap>(name: K, text?: string) => {
  const n = document.createElement(name);
  if (text) n.textContent = text;
  return n;
};
function button(text: string, click: () => void, cls = 'secondary-button') {
  const b = el('button', text);
  b.type = 'button';
  b.className = cls;
  b.onclick = click;
  return b;
}
function cover(file: SavedLinkVideo) {
  if (!file.poster) return createElement(Film);
  const img = el('img');
  img.alt = '';
  img.src = 'data:image/jpeg;base64,' + file.poster;
  return img;
}
export function localVideoTile(item: SavedLinkVideo, open: () => void, menu?: () => void) {
  const b = button('', () => {}, 'gallery-tile link-video-tile concealed');
  b.append(cover(item));
  const privateLabel = uiLiteral('仅自己可见 · 本设备');
  b.setAttribute('aria-label', item.name + (!item.shared ? ' · ' + privateLabel : ''));
  if (!item.shared) {
    const badge = el('span');
    badge.className = 'local-video-lock';
    badge.title = privateLabel;
    badge.append(createElement(LockKeyhole));
    b.append(badge);
  }
  let timer = 0,
    held = false,
    x = 0,
    y = 0;
  const clear = () => window.clearTimeout(timer);
  const hold = () => {
    clear();
    if (!b.isConnected) return;
    held = true;
    menu?.();
  };
  if (menu) {
    b.onpointerdown = (e) => {
      clear();
      if (!e.isPrimary || e.button !== 0) return;
      held = false;
      x = e.clientX;
      y = e.clientY;
      timer = window.setTimeout(hold, 500);
    };
    b.onpointermove = (e) => {
      if (Math.hypot(e.clientX - x, e.clientY - y) > 8) clear();
    };
    b.onpointerup = b.onpointercancel = b.onpointerleave = clear;
    b.oncontextmenu = (e) => {
      e.preventDefault();
      hold();
    };
  }
  b.onclick = () => {
    if (held) {
      held = false;
      return;
    }
    if (b.classList.contains('concealed')) {
      b.classList.remove('concealed');
      return;
    }
    open();
  };
  return b;
}
export function openLinkVideoSheet(opts: Options) {
  const { root, session } = opts;
  const life = new AbortController();
  const signal = AbortSignal.any([life.signal, opts.signal]);
  const sheet = el('div');
  sheet.className = 'link-video-sheet confirm-backdrop';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', uiLiteral('链接视频'));
  const panel = el('section');
  panel.className = 'confirm-dialog link-video-panel';
  const head = el('header'),
    title = el('h2'),
    body = el('div'),
    actions = el('footer'),
    status = el('p');
  body.className = 'link-video-body';
  status.setAttribute('role', 'status');
  status.className = 'field-hint';
  head.append(title);
  panel.append(head, body, status, actions);
  sheet.append(panel);

  const urls = new Set<string>();
  let busy = false,
    screen = 0;
  const active = () => !signal.aborted && opts.active();
  const badge = button('', show, 'link-video-resume');
  const banner = el('aside');
  banner.className = 'link-video-banner';
  banner.append(badge);
  let resumable = false;
  let mounted = false;
  let presentation: AbortController | undefined;
  let lookup: AbortController | undefined;
  let lookupTimer = 0;
  let retry: (() => Promise<void>) | undefined;
  function refresh() {
    if (!active() || mounted || !resumable) { banner.remove(); return; }
    const notices = root.querySelector('.chat-shell .system-notices');
    if (notices && banner.parentNode !== notices) notices.append(banner);
  }
  function report(text: string) {
    status.textContent = text;
    badge.textContent = text + ' ›';
  }
  function stopLookup() {
    clearTimeout(lookupTimer);
    lookup?.abort();
    lookup = undefined;
  }
  const clearUrls = () => {
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
  };
  const object = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
  };
  function reset(label: string) {
    screen++;
    stopLookup();
    clearUrls();
    title.textContent = label;
    head.replaceChildren(title);
    body.replaceChildren();
    actions.replaceChildren();
    status.textContent = '';
  }
  const close = () => closeDialog(sheet);
  function dispose() {
    if (life.signal.aborted) return;
    life.abort();
    opts.signal.removeEventListener('abort', dispose);
    presentation?.abort();
    closeDialog(sheet, { animate: false, restoreFocus: false });
    banner.remove();
    clearUrls();
    stopLookup();
    panel.querySelector('video')?.pause();
    body.replaceChildren();
    opts.onDispose();
  }
  function show() {
    if (!active() || mounted) return;
    closeDialog(sheet, { animate: false, restoreFocus: false });
    sheet.classList.remove('is-closing');
    sheet.inert = false;
    panel.style.removeProperty('--sheet-drag');
    banner.remove();
    root.append(sheet);
    mounted = true;
    presentation = new AbortController();
    mountDialog(sheet, {
      presentation: 'sheet', signal, isActive: active,
      onClose: () => {
        mounted = false;
        presentation?.abort();
        if (resumable && active() && root.querySelector('.chat-shell')) refresh();
        else dispose();
      },
    });
    const handle = panel.querySelector<HTMLButtonElement>('.half-sheet-handle')!;
    bindHalfSheetHandle(handle, panel, presentation.signal, close);
  }
  opts.signal.addEventListener('abort', dispose, { once: true });
  function taskScreen(name: string, message: string) {
    reset(uiLiteral('链接视频'));
    resumable = true;
    body.append(el('strong', name));
    report(message);
    actions.append(button(uiLiteral('取消'), dispose), button(uiLiteral('收起'), close, 'primary-button'));
  }
  const manage = async (fn: () => Promise<void>) => {
    if (busy || !active()) return;
    busy = true;

    try {
      await fn();
    } catch (err) {
      if (active()) {
        const storageError =
          err instanceof DOMException && ['NotReadableError', 'QuotaExceededError'].includes(err.name);
        const message = storageError
          ? uiLiteral('浏览器无法处理此视频。请在普通窗口重试，并检查设备可用空间。')
          : err instanceof Error
            ? err.message
            : uiLiteral('操作失败，请重试');
        report(message);
        if (retry && resumable) {
          const again = retry;
          actions.replaceChildren(button(uiLiteral('链接视频'), form), button(uiLiteral('重试'), () => void manage(again), 'primary-button'));
        }
      }
    } finally {
      busy = false;
    }
  };
  async function sendSaved(item: SavedLinkVideo) {
    retry = () => sendSaved(item);
    taskScreen(item.name, uiLiteral('正在本地无损压缩'));
    if (item.shared || (await listLinkVideos(session, signal)).some(row => row.id === item.id && row.shared)) {
      sent(uiLiteral('已发送至聊天'));
      return;
    }
    const file = await readLinkVideo(session, item.id, signal);
    const packed = await compactMp4(file, signal);
    signal.throwIfAborted();
    if (packed.size > MAX_VIDEO_BYTES) {
      saved(item, uiLiteral('单个视频不能超过 2 GiB'), true);
      return;
    }
    if (packed.size > MAX_IMAGE_BYTES && !opts.largeVideoReady()) {
      saved(item, uiLiteral('请先让所有已授权设备打开一次最新版，再发送大视频'), true);
      return;
    }
    report(uiLiteral('正在加密发送'));
    const ok = await opts.send(packed, item.id, signal);
    if (!active()) return;
    if (ok) sent(uiLiteral('已交给聊天发送'));
    else saved(item, uiLiteral('发送失败，可从本机重试'), true);
  }
  function sent(message: string) {
    reset(uiLiteral('链接视频'));
    report(message);
    resumable = !mounted;
    actions.append(button(uiLiteral('返回聊天'), dispose, 'primary-button'));
  }
  function saved(item: SavedLinkVideo, message: string, offerSend = false) {
    reset(uiLiteral('我的下载'));
    head.append(button(uiLiteral('链接视频'), form, 'link-video-text'));
    const stateIcon = createElement(offerSend ? Film : Check);
    stateIcon.classList.add('link-video-result-icon');
    body.append(stateIcon, el('strong', item.name), el('p', item.shared ? uiLiteral('已发送至聊天') : uiLiteral('仅自己可见 · 本设备')));
    report(message);
    actions.append(button(uiLiteral('我的下载'), () => void manage(library)));
    if (offerSend) actions.append(button(uiLiteral('发送至聊天'), () => void manage(() => sendSaved(item)), 'primary-button'));
    else actions.append(button(uiLiteral('查看视频'), () => void manage(() => view(item)), 'primary-button'));
  }
  function itemActions(item: SavedLinkVideo) {
    if (!active()) return;
    resumable = false;
    reset(uiLiteral('视频操作'));
    body.append(
      el('p', item.name),
      el('p', item.shared ? uiLiteral('已发送至聊天') : uiLiteral('仅自己可见 · 本设备')),
    );
    actions.append(button(uiLiteral('我的下载'), () => void manage(library)));
    if (!item.shared)
      actions.append(
        button(uiLiteral('发送至聊天'), () => void manage(() => sendSaved(item)), 'primary-button'),
      );
  }
  async function view(item: SavedLinkVideo) {
    resumable = false;
    retry = undefined;
    reset(uiLiteral('我的下载'));
    const file = await readLinkVideo(session, item.id, signal);
    if (!active()) return;
    const video = el('video');
    video.controls = true;
    video.playsInline = true;
    video.src = object(file);
    video.autoplay = true;
    body.append(video, el('p', item.name));
    actions.append(
      button(uiLiteral('返回'), () => void manage(library)),
      button(uiLiteral('更多操作'), () => itemActions(item)),
    );
  }
  async function library() {
    resumable = false;
    retry = undefined;
    reset(uiLiteral('我的下载'));
    const seq = screen;
    head.append(button(uiLiteral('链接视频'), form, 'link-video-text'));
    const items = await listLinkVideos(session, signal);
    if (!active() || seq !== screen) return;
    if (!items.length) {
      body.append(el('p', uiLiteral('暂无本机视频')));
      return;
    }
    const grid = el('div');
    grid.className = 'link-video-grid';
    body.append(grid);
    for (const item of items) {
      const cell = el('div');
      const menu = () => {
        if (busy || !active()) return;
        grid.querySelector('.link-video-menu')?.remove();
        const tip = el('div');
        tip.className = 'link-video-menu';
        const action = button(item.shared ? uiLiteral('已发送至聊天') : uiLiteral('发送至聊天'), () => {
          tip.remove();
          void manage(() => sendSaved(item));
        });
        action.disabled = !!item.shared;
        tip.append(
          action,
          button(uiLiteral('取消'), () => {
            tip.remove();
            more.focus();
          }),
        );
        cell.append(tip);
        (item.shared ? (tip.lastElementChild as HTMLButtonElement) : action).focus();
      };
      const more = button('', menu, 'link-video-more');
      more.setAttribute('aria-label', uiLiteral('更多操作'));
      more.append(createElement(MoreHorizontal));
      cell.append(
        localVideoTile(item, () => void manage(() => view(item)), menu),
        more,
        el('small', item.name),
      );
      grid.append(cell);
    }
    status.textContent = uiLiteral('长按视频封面可发送至聊天');
  }
  async function download(c: LinkClip, share: boolean) {
    retry = () => download(c, share);
    taskScreen(c.name, uiLiteral('正在直下本机'));
    const meter = el('progress');
    meter.setAttribute('aria-label', uiLiteral('正在直下本机'));
    const amount = el('small');
    body.append(meter, amount);
    let lastPaint = -Infinity;
    let item = (await listLinkVideos(session, signal)).find((i) => i.key === c.key);
    if (!item) {
      const blob = await directBlob(c.url, signal, LOCAL_VIDEO_LIMIT, (bytes, total) => {
        if (!active() || (performance.now() - lastPaint < 160 && bytes !== total)) return;
        lastPaint = performance.now();
        if (total > 0) { meter.max = total; meter.value = bytes; }
        const received = (bytes / 1048576).toFixed(1);
        amount.textContent = received + (total ? ' / ' + (total / 1048576).toFixed(1) : '') + ' MiB';
        report(uiLiteral('正在直下本机') + ' · ' + (total ? Math.min(100, Math.floor(bytes / total * 100)) + '%' : received + ' MiB'));
      });
      await verifyMp4(blob, signal);
      let poster: string | undefined;
      const url = URL.createObjectURL(blob);
      try {
        const p = await createVideoPoster(url, signal);
        poster = toBase64Url(await p.blob.arrayBuffer())
          .replace(/-/g, '+')
          .replace(/_/g, '/');
      } catch {
        signal.throwIfAborted();
      } finally {
        URL.revokeObjectURL(url);
      }
      report(uiLiteral('正在保存到本机'));
      item = await storeLinkVideo(
        session,
        {
          id: crypto.randomUUID(),
          key: c.key,
          name: c.name,
          size: blob.size,
          created: Date.now(),
          duration: c.duration,
          poster,
        },
        blob,
        signal,
      );
    }
    if (!active()) return;
    if (share) await sendSaved(item);
    else saved(item, uiLiteral('已保存到我的下载'));
  }
  function form() {
    resumable = false;
    retry = undefined;
    reset(uiLiteral('链接视频'));
    head.append(button(uiLiteral('我的下载'), () => void manage(library), 'link-video-text'));
    const field = el('div');
    field.className = 'link-video-field';
    const input = el('input');
    input.type = 'url';
    input.autocomplete = 'off';
    input.placeholder = uiLiteral('粘贴 X 帖子链接');
    input.setAttribute('aria-label', input.placeholder);
    const choices = el('div');
    let selected: LinkClip | undefined;
    const hint = uiLiteral('使用 FxTwitter 识别帖子，视频从 X 直下本机。');
    const parse = async () => {
      stopLookup();
      const owner = new AbortController();
      lookup = owner;
      const querySignal = AbortSignal.any([signal, owner.signal]);
      selected = undefined;
      choices.replaceChildren();
      actions.replaceChildren();
      clearUrls();
      status.textContent = uiLiteral('正在识别');
      let clips: LinkClip[];
      try {
        clips = await resolveClips(input.value, querySignal);
      } catch (error) {
        if (active() && !querySignal.aborted) {
          status.textContent = error instanceof Error ? error.message : uiLiteral('操作失败，请重试');
          actions.append(button(uiLiteral('重试'), () => void parse()));
        }
        return;
      }
      if (!active() || querySignal.aborted) return;
      const buttonList: HTMLButtonElement[] = [];
      const select = (c: LinkClip, index: number) => {
        selected = c;
        buttonList.forEach((b, i) => {
          b.setAttribute('aria-pressed', String(i === index));
        });
      };
      const seq = screen;
      for (const [i, c] of clips.entries()) {
        const b = button('', () => select(c, i), 'link-video-choice');
        const info = el('span');
        const duration = Math.floor(c.duration / 60) + ':' + String(Math.floor(c.duration % 60)).padStart(2, '0');
        const meta = el('small', duration);
        info.append(el('strong', c.name), meta);
        b.append(createElement(Film), info, createElement(Check));
        buttonList.push(b);
        choices.append(b);
        void clipSize(c, querySignal)
          .then((size) => {
            if (size && active() && b.isConnected)
              meta.append(' · ' + (size < 1048576 ? Math.ceil(size / 1024) + ' KiB' : (size / 1048576).toFixed(1) + ' MiB'));
          })
          .catch(() => {});
        if (c.cover)
          void directBlob(c.cover, querySignal, 3 * 1024 ** 2)
            .then((blob) => {
              if (active() && seq === screen && b.isConnected && blob.type.startsWith('image/')) {
                const img = el('img');
                img.alt = '';
                img.src = object(blob);
                b.firstChild?.replaceWith(img);
              }
            })
            .catch(() => {});
      }
      select(clips[0]!, 0);
      status.textContent = hint;
      actions.append(
        button(uiLiteral('仅下载'), () => {
          if (selected) void manage(() => download(selected!, false));
        }, 'primary-button'),
        button(
          uiLiteral('下载并发送'),
          () => {
            if (selected) void manage(() => download(selected!, true));
          },
        ),
      );
    };
    input.oninput = () => {
      stopLookup();
      clearUrls();
      if (input.value.trim()) lookupTimer = window.setTimeout(() => void parse(), 350);
      selected = undefined;
      choices.replaceChildren();
      actions.replaceChildren();
      status.textContent = hint;
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        void parse();
      }
    };
    field.append(input);
    body.append(field, choices);
    status.textContent = hint;
  }
  show();
  if (opts.start) void manage(() => view(opts.start!));
  else form();
  return { show, refresh, dispose };
}
