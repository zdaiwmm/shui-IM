import { createElement, Film, LockKeyhole, MoreHorizontal, Check, Link, X } from 'lucide';
import { closeDialog, mountDialog } from './dialog';
import { bindHalfSheetHandle } from './half-sheet';
import { createVideoPoster } from './video-poster';
import { toBase64Url } from './base64';
import { uiLiteral } from './language';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './message-payload';
import { mountLinkVideoCapsule, type LinkVideoPhase } from './link-video-capsule';
import { downloadLinkSource, prepareLinkSourceDownload, finishLinkSourceDownload, cancelLinkSourceDownload } from './link-source-transfer';
import { isLinkVideoSendConfirmed, listPendingLinkDownloads, listPendingLinkSends, setLinkVideoPendingSend } from './vault';
import { withSavedLinkVideoSend } from './link-video-send';
import { videoDurationLabel } from './video-download-policy';
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
  send: (file: File, id: string, signal: AbortSignal, progress?: (ratio:number)=>void) => Promise<boolean>;
  largeVideoReady: () => boolean;
  prepareSend?: (ids:string[],signal:AbortSignal)=>Promise<void>;
  queue?: (items: { id: string; name: string; duration: number }[]) => void;
  cancelQueued?: (ids:string[])=>Promise<void>;
  queuedState?: (id: string, text: string, phase?: LinkVideoPhase, ratio?: number) => void;
  start?: SavedLinkVideo;
  resume?: boolean;
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
  const duration = el('span', videoDurationLabel(item.duration * 1000));
  duration.className = 'video-duration';
  b.append(duration);
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
  const work = new AbortController();
  const signal = AbortSignal.any([life.signal, opts.signal, work.signal]);
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
  let minimizeOnStart=Boolean(opts.resume);
  let queuedIds:string[] = [];
  let busy = false,
    screen = 0;
  const active = () => !signal.aborted && opts.active();
  const badge = button('', show, 'link-video-resume');
  const capsule = mountLinkVideoCapsule(badge);
  let phase: LinkVideoPhase = 'download';
  let batch: HTMLElement | undefined;
  let currentRow: HTMLElement | undefined;
  let currentTaskId: string | undefined;
  const banner = el('aside');
  banner.className = 'link-video-banner';
  banner.dataset.noticePriority = '55';
  banner.append(badge);
  let resumable = false;
  let mounted = false;
  let presentation: AbortController | undefined;
  let lookup: AbortController | undefined;
  let lookupTimer = 0;
  let retry: (() => Promise<unknown>) | undefined;
  function refresh() {
    if (!active() || mounted || !resumable) { banner.remove(); return; }
    const notices = root.querySelector('.chat-shell .system-notices');
    if (notices && banner.parentNode !== notices) notices.append(banner);
  }
  function report(text: string, next = phase, ratio?: number) {
    phase = next;
    if (currentTaskId) opts.queuedState?.(currentTaskId, text, next, ratio);
    status.textContent = text;
    if (currentRow) {
      currentRow.querySelector('small')!.textContent = text;
      const meter = currentRow.querySelector('progress')!;
      if (ratio !== undefined || next === 'done') meter.value = next === 'done' ? 1 : ratio!;
      else if (next === 'failed') { if (!meter.hasAttribute('value')) meter.value = 0; }
      else meter.removeAttribute('value');
      currentRow.dataset.phase = next;
    }
    capsule.update({ text, phase, ratio });
    if (phase === 'failed') banner.dataset.tone = 'error';
    else delete banner.dataset.tone;
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
    if (!batch) clearUrls();
    title.textContent = label;
    head.replaceChildren(title);
    body.replaceChildren();
    actions.replaceChildren();
    status.className = 'field-hint';
    panel.insertBefore(status, actions);
    status.textContent = '';
  }
  const close = () => closeDialog(sheet);
  function dispose() {
    if (life.signal.aborted) return;
    life.abort();
    capsule.dispose();
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
  const cancel = async () => {
    work.abort(new DOMException('Task cancelled','AbortError'));
    const cancellationSignal=new AbortController().signal;
    try { await opts.cancelQueued?.(queuedIds); for(const id of queuedIds) await cancelLinkSourceDownload(session,id,cancellationSignal); dispose(); }
    catch { report(uiLiteral('取消失败，请重试'),'failed'); }
  };
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
    body.append(batch ?? el('strong', name));
    report(message);
    actions.append(button(uiLiteral('取消'), () => void cancel()), button(uiLiteral('收起'), close, 'primary-button'));
    if(minimizeOnStart){minimizeOnStart=false;queueMicrotask(close);}
  }
  const manage = async (fn: () => Promise<unknown>) => {
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
        report(message, 'failed');
        if (retry && resumable) {
          const again = retry;
          actions.replaceChildren(button(uiLiteral('链接视频'), form), button(uiLiteral('重试'), () => void manage(again), 'primary-button'));
        }
      }
    } finally {
      busy = false;
    }
  };
  async function sendSaved(item: SavedLinkVideo, explicit=false):Promise<boolean> {
    currentTaskId = item.id;
    if(explicit){queuedIds=[item.id];await opts.prepareSend?.(queuedIds,signal);signal.throwIfAborted();}
    phase = 'prepare';
    retry = () => sendSaved(item);
    taskScreen(item.name, uiLiteral('正在本地无损压缩'));
    if ((await listLinkVideos(session, signal)).some(row => row.id === item.id && isLinkVideoSendConfirmed(row))) {
      sent(uiLiteral('已发送至聊天'));
      return true;
    }
    return withSavedLinkVideoSend(session,item.id,signal,async()=>{
    const file = await readLinkVideo(session, item.id, signal);
    const packed = await compactMp4(file, signal);
    signal.throwIfAborted();
    if (packed.size > MAX_VIDEO_BYTES) {
      saved(item, uiLiteral('单个视频不能超过 2 GiB'), true);
      return false;
    }
    if (packed.size > MAX_IMAGE_BYTES && !opts.largeVideoReady()) {
      saved(item, uiLiteral('有设备的旧版仅支持 256 MiB 以内的视频；发送此原件前需更新该设备'), true);
      return false;
    }
    report(uiLiteral('正在加密发送'), 'upload');
    const ok = await opts.send(packed,item.id,signal,ratio=>report(uiLiteral('加密上传中')+` · ${Math.floor(ratio*100)}%`,'upload',ratio));
    if (!active()) return false;
    if (ok) {
      if (batch) report(uiLiteral('已交给聊天发送'), 'done');
      else sent(uiLiteral('已交给聊天发送'));
    }
    else saved(item, uiLiteral('发送失败，可从本机重试'), true);
    return ok;
    });
  }
  function sent(message: string) {
    reset(uiLiteral('链接视频'));
    report(message, 'done');
    if (batch) body.append(batch);
    resumable = !mounted;
    actions.append(button(uiLiteral('返回聊天'), dispose, 'primary-button'));
  }
  function saved(item: SavedLinkVideo, message: string, offerSend = false) {
    if (batch) {
      body.replaceChildren(batch);
      report(message, offerSend ? 'failed' : 'done');
      return;
    }
    reset(uiLiteral('我的下载'));
    head.append(button(uiLiteral('链接视频'), form, 'link-video-text'));
    const result = el('article'); result.className = 'link-video-result';
    result.append(localVideoTile(item, () => void manage(() => view(item))),
      el('strong', item.name), el('p', item.shared ? uiLiteral('已发送至聊天') : uiLiteral('仅自己可见 · 本设备')));
    body.append(result);
    report(message, offerSend ? 'failed' : 'done');
    actions.append(button(uiLiteral('我的下载'), () => void manage(library)));
    if (offerSend) actions.append(button(uiLiteral('发送至聊天'), () => void manage(() => sendSaved(item,true)), 'primary-button'));
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
    actions.append(
      button(uiLiteral('发送至聊天'), () => void manage(() => sendSaved(item,true)), 'primary-button'),
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
    batch = currentRow = undefined;
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
        const action = button(uiLiteral('发送至聊天'), () => {
          tip.remove();
          void manage(() => sendSaved(item,true));
        });
        tip.append(
          action,
          button(uiLiteral('取消'), () => {
            tip.remove();
            more.focus();
          }),
        );
        cell.append(tip);
        action.focus();
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
  async function download(c: LinkClip, share: boolean, requestedId?: string) {
    phase = 'download';
    requestedId ??= crypto.randomUUID();
    currentTaskId = requestedId;
    retry = () => download(c, share, requestedId);
    taskScreen(c.name, uiLiteral('正在直下本机'));
    const meter = el('progress');
    meter.setAttribute('aria-label', uiLiteral('正在直下本机'));
    const amount = el('small');
    if (!batch) body.append(meter, amount);
    let lastPaint = -Infinity;
    let item = (await listLinkVideos(session, signal)).find((i) => i.key === c.key);
    if (!item) {
      const track = (bytes:number,total:number) => {
        if (!active() || (performance.now() - lastPaint < 160 && bytes !== total)) return;
        lastPaint = performance.now();
        if (requestedId) opts.queuedState?.(requestedId, uiLiteral('下载中') + (total ? ` · ${Math.floor(bytes / total * 100)}%` : ''));
        if (total > 0) { meter.max = total; meter.value = bytes; }
        const received = (bytes / 1048576).toFixed(1);
        amount.textContent = received + (total ? ' / ' + (total / 1048576).toFixed(1) : '') + ' MiB';
        report(uiLiteral('正在直下本机') + ' · ' + (total ? Math.min(100, Math.floor(bytes / total * 100)) + '%' : received + ' MiB'), 'download', total ? bytes / total : undefined);
      };
      const blob = await downloadLinkSource(session,c,requestedId,share,signal,track) ?? await directBlob(c.url,signal,LOCAL_VIDEO_LIMIT,track);
      await verifyMp4(blob, signal);
      let poster: string | undefined;
      let duration=c.duration;
      const url = URL.createObjectURL(blob);
      try {
        const p = await createVideoPoster(url, signal);
        if(p.durationMs)duration=p.durationMs/1000;
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
          id: requestedId ?? crypto.randomUUID(),
          key: c.key,
          name: c.name,
          size: blob.size,
          created: Date.now(),
          duration,
          poster,
        },
        blob,
        signal,
      );
    }
    if (!active()) return;
    if (share) {
      if(await sendSaved(item))await finishLinkSourceDownload(session,requestedId,signal);
    } else {
      await finishLinkSourceDownload(session,requestedId,signal);
      saved(item, uiLiteral('已保存到我的下载'));
    }
  }
  async function runSelected(clips: LinkClip[], share: boolean) {
    const stored = await listLinkVideos(session, signal);
    const pending=await listPendingLinkDownloads(session,signal);
    const entries = clips.map(clip => ({ clip, id: stored.find(item => item.key === clip.key)?.id ?? pending.find(item=>item.clip.key===clip.key)?.id ?? crypto.randomUUID() }));
    batch = el('div');
    batch.className = 'link-video-batch';
    batch.append(el('strong', uiLiteral('视频') + ` · ${entries.length}`));
    const rows = entries.map(({clip}) => {
      const row = el('div');
      row.className = 'link-video-batch-row';
      const art = el('span');
      art.className = 'link-video-batch-cover';
      const image = [...body.querySelectorAll<HTMLImageElement>('.link-video-choice img')].find(img => img.closest('button')?.dataset.clipKey === clip.key);
      art.append(image ? image.cloneNode() : createElement(Film));
      const info = el('div');
      const meter = el('progress');
      meter.max = 1; meter.value = 0;
      meter.setAttribute('aria-label', clip.name);
      info.append(el('strong',clip.name), el('small',uiLiteral('等待处理')), meter);
      row.append(art,info); batch!.append(row); return row;
    });
    queuedIds=entries.map(entry=>entry.id);
    if(share)await opts.prepareSend?.(queuedIds,signal);signal.throwIfAborted();
    if(share)for(const entry of entries)if(stored.some(item=>item.id===entry.id)){
      await setLinkVideoPendingSend(session,entry.id,true);signal.throwIfAborted();
    }
    for(const entry of entries)if(!stored.some(item=>item.id===entry.id)){
      const plan=await prepareLinkSourceDownload(session,entry.clip,entry.id,share,signal);
      void plan;
    }
    queuedIds=entries.map(entry=>entry.id);
    if (share) opts.queue?.(entries.map(({clip,id}) => ({id,name:clip.name,duration:clip.duration})));
    let next = 0;
    const run = async () => {
      retry = run;
      while (next < entries.length) {
        const { clip, id } = entries[next]!;
        currentRow = rows[next]; currentTaskId = id;
        opts.queuedState?.(id, uiLiteral('正在下载'));
        try { await download(clip, share, id); }
        catch (error) { opts.queuedState?.(id, uiLiteral('下载失败 · 在任务面板重试'), 'failed'); retry = run; throw error; }
        if (!active()) return;
        // Do not load another potentially large file while this upload failed.
        if (phase === 'failed') { retry = run; actions.replaceChildren(button(uiLiteral('取消'), () => void cancel()), button(uiLiteral('重试'), () => void manage(run), 'primary-button')); return; }
        next++;
      }
      sent(share ? uiLiteral('已交给聊天发送') : uiLiteral('已保存到我的下载'));
      if(!share)actions.prepend(button(uiLiteral('我的下载'), () => void manage(library)));
    };
    await run();
  }
  function form() {
    batch = currentRow = undefined;
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
    const clear = button('', () => {
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.focus();
    }, 'link-video-clear');
    clear.setAttribute('aria-label', uiLiteral('清空链接'));
    clear.append(createElement(X));
    const choices = el('div');
    choices.className = 'link-video-choices';
    const summary = el('div');
    summary.className = 'link-video-section';
    const empty = el('div');
    empty.className = 'link-video-empty';
    empty.append(createElement(Film), el('strong',uiLiteral('粘贴链接，选择想分享的视频')));
    const selected = new Map<string, LinkClip>();
    const hint = uiLiteral('使用 FxTwitter 识别帖子，视频从 X 直下本机。');
    const parse = async () => {
      stopLookup();
      const owner = new AbortController();
      lookup = owner;
      const querySignal = AbortSignal.any([signal, owner.signal]);
      selected.clear();
      choices.replaceChildren();
      summary.replaceChildren();
      empty.hidden = true;
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
      const all = button(uiLiteral('全选'), () => {
        const deselect = selected.size === clips.length;
        selected.clear();
        if (!deselect) clips.forEach(c => selected.set(c.key, c));
        paintSelection();
      }, 'link-video-text');
      summary.append(el('strong', uiLiteral('视频') + ` · ${clips.length}`), all);
      const paintSelection = () => {
        const picked = clips.filter(c => selected.has(c.key));
        buttonList.forEach((b, i) => {
          const index = picked.indexOf(clips[i]!);
          b.setAttribute('aria-pressed', String(index >= 0));
          b.querySelector('.link-video-check')!.textContent = index >= 0 ? String(index + 1) : '';
        });
        all.textContent = uiLiteral(selected.size === clips.length ? '取消全选' : '全选');
        status.textContent = uiLiteral('已选') + ` ${selected.size} / ${clips.length}`;
        actions.querySelectorAll('button').forEach(b => b.disabled = selected.size === 0);
      };
      const select = (c: LinkClip) => {
        if (selected.has(c.key)) selected.delete(c.key); else selected.set(c.key, c);
        paintSelection();
      };
      const seq = screen;
      for (const [i, c] of clips.entries()) {
        const b = button('', () => select(c), 'link-video-choice');
        b.dataset.clipKey = c.key;
        const info = el('span');
        const duration = videoDurationLabel(c.duration * 1000);
        const meta = el('small', duration);
        info.className = 'link-video-choice-info';
        info.append(el('strong', c.name), meta);
        const art = el('span');
        art.className = 'link-video-choice-cover';
        art.append(createElement(Film));
        const check = el('span');
        check.className = 'link-video-check';
        check.setAttribute('aria-hidden', 'true');
        b.append(art, check, info);
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
                art.replaceChildren(img);
              }
            })
            .catch(() => {});
      }
      select(clips[0]!);
      actions.append(
        button(uiLiteral('仅下载'), () => {
          if (selected.size) void manage(() => runSelected(clips.filter(c => selected.has(c.key)), false));
        }),
        button(
          uiLiteral('下载并发送'),
          () => {
            if (selected.size) void manage(() => runSelected(clips.filter(c => selected.has(c.key)), true));
          },
          'primary-button',
        ),
      );
      const privacy = el('p', uiLiteral('仅下载保存在本机，不会发送给对方。'));
      privacy.className = 'link-video-footer-note';
      actions.append(privacy);
    };
    input.oninput = () => {
      stopLookup();
      clearUrls();
      if (input.value.trim()) lookupTimer = window.setTimeout(() => void parse(), 350);
      selected.clear();
      choices.replaceChildren();
      summary.replaceChildren();
      actions.replaceChildren();
      status.textContent = '';
      empty.hidden = Boolean(input.value.trim());
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        void parse();
      }
    };
    field.append(createElement(Link), input, clear);
    const note = el('p', hint);
    note.className = 'link-video-note';
    status.className = 'link-video-selection';
    body.append(field, note, summary, choices, status, empty);
    status.textContent = '';
  }
  show();
  if (opts.start) void manage(() => view(opts.start!));
  else if(opts.resume)void manage(async()=>{
    const pending=await listPendingLinkDownloads(session,signal);
    const saved=(await listPendingLinkSends(session,signal)).filter(item=>!pending.some(source=>source.id===item.id));
    queuedIds=[...pending.map(item=>item.id),...saved.map(item=>item.id)];
    opts.queue?.([...pending.filter(item=>item.share).map(item=>({id:item.id,name:item.clip.name,duration:item.clip.duration})),...saved.map(item=>({id:item.id,name:item.name,duration:item.duration}))]);
    for(const item of saved){await sendSaved(item);if(!active()||phase==='failed')return;}
    for(const item of pending){await download(item.clip,item.share,item.id);if(!active()||phase==='failed')return;}
  });
  else form();
  return { show, refresh, dispose, abortOperations:()=>work.abort(new DOMException('Room exited','AbortError')) };
}
