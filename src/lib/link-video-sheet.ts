import { createElement, Film, LockKeyhole, MoreHorizontal, Check } from 'lucide';
import { closeDialog, mountDialog } from './dialog';
import { bindHalfSheetHandle } from './half-sheet';
import { createVideoPoster } from './video-poster';
import { toBase64Url } from './base64';
import { uiLiteral } from './language';
import { MAX_IMAGE_BYTES } from './message-payload';
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
  start?: SavedLinkVideo;
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
  root.append(sheet);
  const urls = new Set<string>();
  let busy = false,
    screen = 0;
  const active = () => !signal.aborted && opts.active() && sheet.isConnected;
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
    clearUrls();
    title.textContent = label;
    head.replaceChildren(title);
    body.replaceChildren();
    actions.replaceChildren();
    status.textContent = '';
  }
  const close = () => closeDialog(sheet);
  mountDialog(sheet, {
    presentation: 'sheet',
    signal: opts.signal,
    isActive: opts.active,
    onClose: () => {
      life.abort();
      clearUrls();
      body.replaceChildren();
    },
  });
  const handle = panel.querySelector<HTMLButtonElement>('.half-sheet-handle')!;
  bindHalfSheetHandle(handle, panel, signal, close);
  const manage = async (fn: () => Promise<void>) => {
    if (busy || !active()) return;
    busy = true;
    body.inert = head.inert = actions.inert = true;
    panel.classList.add('link-working');
    const scope = screen;
    try {
      await fn();
    } catch (err) {
      if (active() && scope <= screen)
        status.textContent = err instanceof Error ? err.message : uiLiteral('操作失败，请重试');
    } finally {
      busy = false;
      body.inert = head.inert = actions.inert = false;
      panel.classList.remove('link-working');
    }
  };
  async function sendSaved(item: SavedLinkVideo) {
    if (item.shared) {
      status.textContent = uiLiteral('已发送至聊天');
      return;
    }
    status.textContent = uiLiteral('正在本地无损压缩');
    if ((await listLinkVideos(session, signal)).some((saved) => saved.id === item.id && saved.shared)) {
      status.textContent = uiLiteral('已发送至聊天');
      return;
    }
    const file = await readLinkVideo(session, item.id, signal);
    const packed = await compactMp4(file, signal);
    signal.throwIfAborted();
    if (packed.size > MAX_IMAGE_BYTES) {
      status.textContent = uiLiteral('超过 256 MiB，已保留在本机');
      return;
    }
    status.textContent = uiLiteral('正在加密发送');
    const ok = await opts.send(packed, item.id, signal);
    if (active()) status.textContent = ok ? uiLiteral('已交给聊天发送') : uiLiteral('发送失败，可从本机重试');
  }
  function itemActions(item: SavedLinkVideo) {
    if (!active()) return;
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
    reset(uiLiteral('我的下载'));
    const file = await readLinkVideo(session, item.id, signal);
    if (!active()) return;
    const video = el('video');
    video.controls = true;
    video.playsInline = true;
    video.src = object(file);
    body.append(video, el('p', item.name));
    actions.append(
      button(uiLiteral('返回'), () => void manage(library)),
      button(uiLiteral('更多操作'), () => itemActions(item)),
    );
  }
  async function library() {
    reset(uiLiteral('我的下载'));
    head.append(button(uiLiteral('链接视频'), form, 'link-video-text'));
    const items = await listLinkVideos(session, signal);
    if (!active()) return;
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
      );
      grid.append(cell);
    }
    status.textContent = uiLiteral('长按视频封面可发送至聊天');
  }
  async function download(c: LinkClip, share: boolean) {
    let item = (await listLinkVideos(session, signal)).find((i) => i.key === c.key);
    if (!item) {
      status.textContent = uiLiteral('正在直下本机');
      const blob = await directBlob(c.url, signal, LOCAL_VIDEO_LIMIT, (n, total) => {
        if (active())
          status.textContent =
            uiLiteral('正在直下本机') +
            ' · ' +
            (total ? Math.floor((n / total) * 100) + '%' : Math.ceil(n / 1048576) + ' MiB');
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
      status.textContent = uiLiteral('正在保存到本机');
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
    itemActions(item);
    if (share) await sendSaved(item);
    else status.textContent = uiLiteral('已保存到我的下载');
  }
  function form() {
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
      selected = undefined;
      choices.replaceChildren();
      actions.replaceChildren();
      clearUrls();
      status.textContent = uiLiteral('正在识别');
      const clips = await resolveClips(input.value, signal);
      if (!active()) return;
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
        b.append(
          createElement(Film),
          el(
            'span',
            c.name +
              ' · ' +
              Math.floor(c.duration / 60) +
              ':' +
              String(Math.floor(c.duration % 60)).padStart(2, '0'),
          ),
          createElement(Check),
        );
        buttonList.push(b);
        choices.append(b);
        void clipSize(c, signal)
          .then((size) => {
            const label = b.querySelector('span');
            if (size && label && active() && b.isConnected)
              label.append(' · ' + (size / 1048576).toFixed(1) + ' MiB');
          })
          .catch(() => {});
        if (c.cover)
          void directBlob(c.cover, signal, 3 * 1024 ** 2)
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
        }),
        button(
          uiLiteral('下载并发送'),
          () => {
            if (selected) void manage(() => download(selected!, true));
          },
          'primary-button',
        ),
      );
    };
    input.oninput = () => {
      selected = undefined;
      choices.replaceChildren();
      actions.replaceChildren();
      status.textContent = hint;
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        void manage(parse);
      }
    };
    field.append(
      input,
      button(uiLiteral('识别'), () => void manage(parse), 'link-video-text'),
    );
    body.append(field, choices);
    status.textContent = hint;
  }
  if (opts.start) void manage(() => view(opts.start!));
  else form();
}
