import { mountDialog, closeDialog } from './dialog';
import { validateMemeFile, type MemeFavorite } from './meme-media';
import { detectImageAnimation } from './image-animation';
import { starterPacks, starterGifs, starterMedia, warmStarterMedia, MAX_PACK_BYTES, type MediaKind, type MediaItem, type MediaSearchResult, type RemotePack, type RemotePackDetail, type StickerPack } from './sticker-library';
import { createElement, Smile, Star, Search, Keyboard, ChevronDown, Image, X, ArrowLeft, Plus, Trash2, Send } from 'lucide';

export const memeIcons = {
  smile: createElement(Smile).outerHTML, star: createElement(Star).outerHTML,
  search: createElement(Search).outerHTML, keyboard: createElement(Keyboard).outerHTML,
  down: createElement(ChevronDown).outerHTML, image: createElement(Image).outerHTML,
};
export type MemePickerOptions = {
  host: HTMLElement; root: HTMLElement; signal: AbortSignal; isActive: () => boolean;
  list: () => Promise<MemeFavorite[]>; file: (item: MemeFavorite, signal: AbortSignal) => Promise<File>;
  save: (file: File, signal: AbortSignal) => Promise<boolean>; remove: (id: string, signal: AbortSignal) => Promise<void>;
  packs: () => Promise<StickerPack[]>;
  install: (id: string, title: string, files: File[], signal: AbortSignal) => Promise<void>;
  removePack: (id: string, signal: AbortSignal) => Promise<void>;
  pack: (id: string, signal: AbortSignal) => Promise<RemotePackDetail>;
  send: (file: File, signal: AbortSignal) => Promise<void>;
  search: (query: string, page: number, signal: AbortSignal, kind: MediaKind) => Promise<MediaSearchResult>;
  media: (id: string, signal: AbortSignal) => Promise<Blob>;
  close: (keyboard: boolean) => void;
  onSearchPointer: (input: HTMLInputElement, event: PointerEvent) => void;
  onKeyboardPointer: (event: PointerEvent) => void;
};
type Tile = { item: MediaItem; url?: string; file?: File; controller?: AbortController; visible: boolean };

export class MemePicker {
  private controller = new AbortController();
  private signal: AbortSignal;
  private request: AbortController | null = null;
  private panel = document.createElement('section');
  private overlay: HTMLElement | null = null;
  private preview: HTMLElement | null = null;
  private grid: HTMLElement;
  private status: HTMLElement;
  private input: HTMLInputElement;
  private more: HTMLButtonElement;
  private shortcutBar: HTMLElement;
  private shortcutTrack: HTMLElement;
  private observer: IntersectionObserver;
  private tiles = new Map<HTMLElement, Tile>();
  private favorites: MemeFavorite[] = [];
  private packs: StickerPack[] = [];
  private kind: MediaKind = 'gifs';
  private favoriteView = false;
  private query = '';
  private nextPage: number | null = null;
  private disposed = false;
  private generation = 0;
  private busy = false;
  private loading = 0;
  private searching = false;
  private packDetail = false;
  private operation: AbortController | null = null;
  private shortcutOffset = 0;
  private shortcutOvershoot = 0;
  private shortcutAnimation: number | null = null;
  private shortcutPointer: {
    id: number;
    startX: number;
    startOffset: number;
    lastX: number;
    lastAt: number;
    velocity: number;
    dragged: boolean;
  } | null = null;
  private shortcutSuppressClick = false;

  constructor(private options: MemePickerOptions) {
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
    this.panel.className = 'meme-panel'; this.panel.id = 'meme-panel';
    this.panel.setAttribute('role', 'region'); this.panel.setAttribute('aria-label', '表情');
    this.panel.innerHTML = `
      <div class="meme-pack-shortcuts" aria-label="贴纸合集"><div class="meme-pack-shortcuts-track"></div></div>
      <button type="button" class="meme-open-search">${memeIcons.search}<span>搜索 GIFs</span></button>
      <header class="meme-search-header" hidden><button type="button" class="meme-back" aria-label="返回表情面板" title="返回">${createElement(ArrowLeft).outerHTML}</button>
        <form class="meme-search"><label class="sr-only" for="meme-query">搜索 GIFs</label><input id="meme-query" type="search" maxlength="80" placeholder="搜索 GIFs" autocomplete="off" enterkeyhint="search" /><button type="submit" aria-label="搜索" title="搜索">${memeIcons.search}</button></form>
        <button type="button" class="meme-close" aria-label="关闭表情" title="关闭">${createElement(X).outerHTML}</button></header>
      <div class="meme-scroll"><div class="meme-grid"></div><p class="meme-status" role="status"></p><button type="button" class="meme-more" hidden>加载更多</button><p class="meme-source"></p></div>
      <nav class="meme-tabs" aria-label="表情分类"><div role="tablist" aria-label="表情类型"><button type="button" role="tab" aria-selected="true" data-kind="gifs">GIFs</button><button type="button" role="tab" aria-selected="false" tabindex="-1" data-kind="stickers">贴纸</button></div><button type="button" class="meme-collapse" aria-label="收起表情" title="收起">${memeIcons.down}</button></nav>`;
    this.grid = this.panel.querySelector('.meme-grid')!; this.status = this.panel.querySelector('.meme-status')!;
    this.shortcutBar = this.panel.querySelector('.meme-pack-shortcuts')!;
    this.shortcutTrack = this.panel.querySelector('.meme-pack-shortcuts-track')!;
    this.input = this.panel.querySelector('input')!; this.more = this.panel.querySelector('.meme-more')!;
    this.installShortcutGesture();
    this.input.addEventListener('pointerdown', event => options.onSearchPointer(this.input, event));
    this.panel.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); void this.submit(); });
    this.panel.querySelector('.meme-open-search')!.addEventListener('click', () => this.openSearch());
    this.panel.querySelector('.meme-back')!.addEventListener('click', () => this.back());
    for (const selector of ['.meme-close', '.meme-collapse']) this.panel.querySelector(selector)!.addEventListener('click', () => options.close(false));
    this.panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.overlay) { event.preventDefault(); options.close(false); } });
    this.panel.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(button => button.addEventListener('click', () => void this.switchKind(button.dataset.kind as MediaKind)));
    this.panel.querySelector('[role="tablist"]')!.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
      event.preventDefault(); const kind = key === 'Home' ? 'gifs' : key === 'End' ? 'stickers' : this.kind === 'gifs' ? 'stickers' : 'gifs';
      void this.switchKind(kind); this.panel.querySelector<HTMLButtonElement>(`[data-kind="${kind}"]`)!.focus();
    });
    this.more.addEventListener('click', () => void this.search());
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) { const tile = this.tiles.get(entry.target as HTMLElement); if (tile) { tile.visible = entry.isIntersecting; if (!tile.visible) this.unload(entry.target as HTMLElement); } }
      this.hydrate();
    }, { root: this.panel.querySelector('.meme-scroll'), rootMargin: '80px' });
    options.host.classList.add('has-meme-panel'); options.host.append(this.panel);
    const sync = () => {
      const view = window.visualViewport;
      this.panel.style.setProperty('--meme-height', `${view?.height ?? innerHeight}px`);
      this.overlay?.style.setProperty('--meme-top', `${view?.offsetTop ?? 0}px`);
      this.overlay?.style.setProperty('--meme-height', `${view?.height ?? innerHeight}px`);
    };
    window.visualViewport?.addEventListener('resize', sync, { signal: this.signal });
    window.visualViewport?.addEventListener('scroll', sync, { signal: this.signal });
    window.addEventListener('resize', sync, { signal: this.signal }); sync();
    document.addEventListener('pointerdown', event => {
      if (!this.overlay && !this.preview && !options.host.contains(event.target as Node)) options.close(false);
    }, { signal: this.signal });
    this.signal.addEventListener('abort', () => this.dispose(), { once: true });
    void this.switchKind('gifs');
    warmStarterMedia(options.signal);
  }
  private active() { return !this.disposed && !this.signal.aborted && this.options.isActive() && this.panel.isConnected; }
  private hasPack(id: string) { return starterPacks.some(pack => pack.id === id) || this.packs.some(pack => pack.id === id); }
  private say(value: string) { if (this.active()) this.status.textContent = value; }
  private clear() {
    this.generation++; this.request?.abort(); this.operation?.abort(); this.searching = false; this.observer.disconnect();
    for (const tile of this.tiles.keys()) this.unload(tile);
    this.tiles.clear(); this.grid.replaceChildren(); this.status.replaceChildren(); this.more.hidden = true;
    this.grid.className = 'meme-grid'; this.panel.querySelector('.meme-scroll')!.scrollTop = 0;
    this.panel.querySelector('.meme-source')!.textContent = '';
  }
  private async switchKind(kind: MediaKind) {
    this.kind = kind; this.favoriteView = false; this.panel.dataset.kind = kind;
    this.panel.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach(button => { const selected = button.dataset.kind === kind; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    const label = kind === 'gifs' ? '搜索 GIFs' : '搜索贴纸合集';
    this.input.placeholder = label; this.panel.querySelector('label')!.textContent = label;
    this.panel.querySelector('.meme-open-search span')!.textContent = label; await this.local();
  }
  private shortcuts() {
    const bar = this.shortcutTrack; bar.replaceChildren();
    this.shortcutOffset = 0; this.shortcutOvershoot = 0; this.renderShortcutOffset();
    const control = (label: string, icon: string, action: () => void) => {
      const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = icon;
      button.addEventListener('click', action); bar.append(button); return button;
    };
    control('查找贴纸合集', createElement(Plus).outerHTML, () => { void this.switchKind('stickers').then(() => this.openSearch()); });
    control('收藏', memeIcons.star, () => { this.favoriteView = !this.favoriteView; void this.local(); }).setAttribute('aria-pressed', String(this.favoriteView));
    if (this.kind !== 'stickers') return;
    for (const pack of [...starterPacks, ...this.packs]) {
      const button = control(pack.title, '', () => { if (this.favoriteView) { this.favoriteView = false; void this.local().then(() => this.jump(pack.id)); } else this.jump(pack.id); });
      const first = pack.items[0]; if (!first) continue;
      const item: MediaItem = 'asset' in first ? first as MediaItem : { id: first.id, title: pack.title, favorite: first as MemeFavorite, pack: pack.id };
      const image = document.createElement('img'); image.alt = ''; image.draggable = false; button.append(image); this.tiles.set(button, { item, visible: true });
    }
    this.hydrate();
  }
  private installShortcutGesture() {
    const bar = this.shortcutBar;
    bar.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.shortcutMaxOffset() <= 0) return;
      this.stopShortcutAnimation();
      this.shortcutSuppressClick = false;
      this.shortcutPointer = {
        id: event.pointerId,
        startX: event.clientX,
        startOffset: this.shortcutOffset,
        lastX: event.clientX,
        lastAt: performance.now(),
        velocity: 0,
        dragged: false,
      };
      bar.setPointerCapture(event.pointerId);
      bar.classList.add('is-dragging');
    });
    bar.addEventListener('pointermove', event => {
      const gesture = this.shortcutPointer;
      if (!gesture || gesture.id !== event.pointerId) return;
      const now = performance.now();
      const delta = event.clientX - gesture.startX;
      const raw = gesture.startOffset - delta;
      const clamped = this.clampShortcutOffset(raw);
      const overshoot = raw - clamped;
      const elapsed = Math.max(1, now - gesture.lastAt);
      gesture.velocity = (event.clientX - gesture.lastX) / elapsed * -1;
      gesture.lastX = event.clientX;
      gesture.lastAt = now;
      if (Math.abs(delta) > 6) gesture.dragged = true;
      if (gesture.dragged) event.preventDefault();
      this.shortcutOffset = clamped;
      this.shortcutOvershoot = this.rubberBand(overshoot);
      this.renderShortcutOffset();
    });
    const finish = (event: PointerEvent) => {
      const gesture = this.shortcutPointer;
      if (!gesture || gesture.id !== event.pointerId) return;
      this.shortcutPointer = null;
      bar.classList.remove('is-dragging');
      try { bar.releasePointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
      if (gesture.dragged) {
        this.shortcutSuppressClick = true;
        this.startShortcutRelease(gesture.velocity);
      } else {
        this.startShortcutRelease(0);
      }
    };
    bar.addEventListener('pointerup', finish);
    bar.addEventListener('pointercancel', finish);
    bar.addEventListener('click', event => {
      if (this.shortcutSuppressClick) {
        this.shortcutSuppressClick = false;
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    bar.addEventListener('wheel', event => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      this.stopShortcutAnimation();
      this.shortcutOffset = this.clampShortcutOffset(this.shortcutOffset + event.deltaX);
      this.renderShortcutOffset();
    }, { passive: false });
    this.signal.addEventListener('abort', () => this.stopShortcutAnimation(), { once: true });
  }
  private shortcutMaxOffset() {
    return Math.max(0, this.shortcutTrack.scrollWidth - this.shortcutBar.clientWidth);
  }
  private clampShortcutOffset(value: number) {
    return Math.max(0, Math.min(this.shortcutMaxOffset(), value));
  }
  private rubberBand(value: number) {
    return value === 0 ? 0 : Math.sign(value) * (Math.abs(value) * 0.34 + Math.min(18, Math.abs(value) * 0.04));
  }
  private renderShortcutOffset() {
    this.shortcutTrack.style.transform = `translate3d(${(-this.shortcutOffset + this.shortcutOvershoot).toFixed(2)}px, 0, 0)`;
  }
  private stopShortcutAnimation() {
    if (this.shortcutAnimation !== null) cancelAnimationFrame(this.shortcutAnimation);
    this.shortcutAnimation = null;
  }
  private startShortcutRelease(velocity: number) {
    this.stopShortcutAnimation();
    let currentVelocity = Math.max(-2.2, Math.min(2.2, velocity));
    let lastAt = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(32, Math.max(1, now - lastAt));
      lastAt = now;
      if (Math.abs(this.shortcutOvershoot) > 0.25) {
        this.shortcutOvershoot *= Math.pow(0.0008, elapsed / 1000);
      } else {
        this.shortcutOvershoot = 0;
        if (Math.abs(currentVelocity) > 0.015) {
          const next = this.shortcutOffset + currentVelocity * elapsed;
          const clamped = this.clampShortcutOffset(next);
          if (clamped !== next) currentVelocity *= -0.22;
          this.shortcutOffset = clamped;
          currentVelocity *= Math.pow(0.055, elapsed / 1000);
        } else currentVelocity = 0;
      }
      this.renderShortcutOffset();
      if (Math.abs(this.shortcutOvershoot) > 0.25 || Math.abs(currentVelocity) > 0.015) {
        this.shortcutAnimation = requestAnimationFrame(tick);
      } else {
        this.shortcutOvershoot = 0;
        this.renderShortcutOffset();
        this.shortcutAnimation = null;
      }
    };
    this.shortcutAnimation = requestAnimationFrame(tick);
  }
  private jump(id: string) {
    const section = [...this.grid.querySelectorAll<HTMLElement>('[data-pack]')].find(node => node.dataset.pack === id); if (!section) return;
    const scroll = this.panel.querySelector('.meme-scroll')!;
    scroll.scrollTo({ top: section.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  private async local() {
    this.clear(); this.panel.dataset.view = 'local'; const generation = this.generation;
    // Paint bundled content before reading the encrypted local library.
    if (!this.favoriteView) this.renderLocalItems();
    try {
      const [favorites, packs] = await Promise.all([this.options.list(), this.options.packs()]);
      if (!this.active() || generation !== this.generation) return;
      this.favorites = favorites; this.packs = packs; this.clear(); this.renderLocalItems(); this.shortcuts();
    } catch { if (generation === this.generation) { this.shortcuts(); this.say('本地收藏或合集读取失败，请重新打开'); } }
  }
  private renderLocalItems() {
    if (this.favoriteView) {
      const items = this.favorites;
      this.append(items.map(item => ({ id: item.id, title: item.name, favorite: item }))); if (!items.length) this.say('暂无收藏');
    } else if (this.kind === 'gifs') this.append(starterGifs);
    else {
      this.grid.classList.add('meme-pack-list');
      for (const pack of [...starterPacks, ...this.packs]) {
        const section = document.createElement('section'); section.dataset.pack = pack.id;
        const header = document.createElement('header'); const title = document.createElement('h3'); title.textContent = pack.title; header.append(title);
        if (this.packs.includes(pack as StickerPack)) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.title = '移除合集'; remove.setAttribute('aria-label', `移除 ${pack.title}`); remove.innerHTML = createElement(Trash2).outerHTML;
          remove.addEventListener('click', () => { if (this.busy) return; this.busy = true; void this.options.removePack(pack.id, this.signal).then(() => this.local()).catch(() => this.say('移除失败，请重试')).finally(() => { this.busy = false; }); }); header.append(remove);
        }
        const grid = document.createElement('div'); grid.className = 'meme-pack-grid'; section.append(header, grid); this.grid.append(section);
        this.append(pack.items.map(item => 'asset' in item ? item as MediaItem : { id: item.id, title: (item as MemeFavorite).name, favorite: item as MemeFavorite, pack: pack.id }), grid);
      }
    }
  }
  private openSearch() {
    if (!this.active() || this.overlay) return;
    const overlay = document.createElement('div'); overlay.className = 'meme-search-dialog'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', this.kind === 'gifs' ? '搜索 GIFs' : '搜索贴纸合集');
    this.overlay = overlay; this.options.root.append(overlay); overlay.append(this.panel);
    const view = visualViewport; overlay.style.setProperty('--meme-height', `${view?.height ?? innerHeight}px`); overlay.style.setProperty('--meme-top', `${view?.offsetTop ?? 0}px`);
    this.panel.dataset.view = 'search'; (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = false;
    mountDialog(overlay, { signal: this.signal, isActive: () => this.active(), initialFocus: this.panel.querySelector<HTMLElement>('.meme-back'), returnFocus: this.options.host.querySelector<HTMLElement>('#open-memes'),
      beforeClose: () => { if (!this.packDetail) return true; void this.submit(); return false; },
      onClose: () => { if (this.overlay === overlay && this.active()) this.back(); } });
    this.input.value = ''; void this.submit();
  }
  private back() {
    if (!this.overlay) return;
    if (this.packDetail) { void this.submit(); return; }
    const overlay = this.overlay; this.overlay = null; this.input.blur(); this.input.value = '';
    this.options.host.append(this.panel); (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = true;
    closeDialog(overlay, { animate: false, restoreFocus: false }); void this.local(); this.panel.querySelector<HTMLButtonElement>('.meme-open-search')!.focus({ preventScroll: true });
  }
  private async submit() {
    this.packDetail = false; this.input.blur(); this.query = this.input.value.trim(); this.clear(); this.panel.dataset.view = 'search'; this.nextPage = 1; await this.search();
  }
  private async search() {
    if (!this.active() || this.searching || !this.nextPage) return;
    this.request = new AbortController(); const signal = AbortSignal.any([this.signal, this.request.signal]); const generation = this.generation;
    this.searching = true; this.more.hidden = true; this.say('正在搜索…');
    try {
      const result = await this.options.search(this.query, this.nextPage, signal, this.kind);
      if (!this.active() || generation !== this.generation) return;
      if (this.kind === 'gifs') this.append(result.items); else this.appendPacks(result.packs ?? []);
      this.nextPage = result.nextPage; this.more.textContent = '加载更多'; this.more.hidden = !this.nextPage;
      this.panel.querySelector('.meme-source')!.textContent = result.source ?? ''; this.say(!this.grid.children.length ? '没有找到相关内容' : '');
    } catch (error) { if (!signal.aborted && generation === this.generation) { this.say(error instanceof Error ? error.message : '搜索失败，请重试'); this.more.textContent = '重试'; this.more.hidden = false; } }
    finally { if (generation === this.generation) this.searching = false; }
  }
  private appendPacks(packs: RemotePack[]) {
    this.grid.classList.add('meme-pack-results');
    for (const pack of packs) {
      const row = document.createElement('article'); row.className = 'meme-pack-result';
      const cover = document.createElement('button'); cover.type = 'button'; cover.className = 'meme-pack-cover'; cover.setAttribute('aria-label', `查看 ${pack.title}`); cover.innerHTML = '<img alt="" draggable="false">';
      this.tiles.set(cover, { item: { id: pack.cover, title: pack.title }, visible: false }); this.observer.observe(cover);
      const title = document.createElement('h3'); title.textContent = pack.title;
      const add = document.createElement('button'); add.type = 'button'; add.className = 'meme-pack-add'; const installed = this.hasPack(pack.id); add.textContent = installed ? '已添加' : '添加'; add.disabled = installed;
      const progress = document.createElement('span'); progress.className = 'meme-pack-progress'; progress.setAttribute('role', 'status');
      add.addEventListener('click', () => void this.install(pack, add, progress)); cover.addEventListener('click', () => void this.showPack(pack)); row.append(cover, title, add, progress); this.grid.append(row);
    }
  }
  private async showPack(pack: RemotePack) {
    if (this.busy || !this.active()) return; const generation = this.generation; this.say('正在加载合集…');
    try {
      const detail = await this.options.pack(pack.id, this.signal); if (!this.active() || generation !== this.generation) return;
      this.clear(); this.packDetail = true; this.grid.classList.add('meme-pack-list'); const header = document.createElement('header'); header.className = 'meme-pack-detail-header';
      const title = document.createElement('h3'); title.textContent = detail.title;
      const add = document.createElement('button'); add.type = 'button'; add.className = 'meme-pack-add'; add.textContent = this.hasPack(pack.id) ? '已添加' : '添加合集'; add.disabled = this.hasPack(pack.id);
      const progress = document.createElement('span'); progress.setAttribute('role', 'status'); add.addEventListener('click', () => void this.install(pack, add, progress, detail));
      const grid = document.createElement('div'); grid.className = 'meme-pack-grid'; header.append(title, add, progress); this.grid.append(header, grid); this.append(detail.items, grid);
    } catch { if (this.active() && generation === this.generation) this.say('合集加载失败，请重试'); }
  }
  private async install(pack: RemotePack, button: HTMLButtonElement, progress: HTMLElement, detail?: RemotePackDetail) {
    if (this.busy || !this.active()) return; this.busy = true; button.disabled = true; progress.textContent = '正在下载…';
    const controller = new AbortController(); this.operation = controller; const signal = AbortSignal.any([this.signal, controller.signal]);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消'; cancel.addEventListener('click', () => controller.abort()); progress.after(cancel);
    try {
      detail ??= await this.options.pack(pack.id, signal); const files: File[] = []; let bytes = 0;
      for (const item of detail.items) {
        const file = await this.getFile(item, signal); bytes += file.size; if (bytes > MAX_PACK_BYTES) throw new Error('合集超过 64 MiB');
        files.push(file); if (progress.isConnected) progress.textContent = `${files.length} / ${detail.items.length}`;
      }
      await this.options.install(pack.id, detail.title, files, signal); if (!this.active()) return;
      this.packs = await this.options.packs(); button.textContent = '已添加'; progress.textContent = `${files.length} 张 · 已下载`;
    } catch (error) { if (this.active()) { progress.textContent = signal.aborted ? '已取消' : error instanceof Error ? error.message : '下载失败，请重试'; button.disabled = false; } }
    finally { this.busy = false; if (this.operation === controller) this.operation = null; cancel.remove(); }
  }
  private append(items: MediaItem[], parent = this.grid) {
    for (const item of items) {
      const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'meme-tile'; tile.title = item.title; tile.setAttribute('aria-label', `发送 ${item.title}`);
      const image = document.createElement('img'); image.alt = item.title; image.draggable = false; tile.append(image); parent.append(tile); this.tiles.set(tile, { item, visible: false }); this.observer.observe(tile);
      let timer: number | undefined; let held = false; let x = 0; let y = 0; const cancel = () => { clearTimeout(timer); timer = undefined; };
      tile.addEventListener('pointerdown', event => { if (event.button !== 0) return; held = false; x = event.clientX; y = event.clientY; timer = window.setTimeout(() => { held = true; void this.showPreview(item, tile); }, 450); });
      tile.addEventListener('pointermove', event => { if (Math.hypot(event.clientX - x, event.clientY - y) > 10) cancel(); });
      for (const name of ['pointerup', 'pointercancel', 'pointerleave'] as const) tile.addEventListener(name, cancel); this.signal.addEventListener('abort', cancel, { once: true });
      tile.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); held = true; void this.showPreview(item, tile); });
      tile.addEventListener('click', event => { event.preventDefault(); if (held) { held = false; return; } void this.perform(item, 'send'); });
    }
  }
  private unload(element: HTMLElement) {
    const state = this.tiles.get(element); state?.controller?.abort(); if (state?.url) URL.revokeObjectURL(state.url);
    if (state) { state.url = undefined; state.file = undefined; state.controller = undefined; } element.querySelector('img')?.removeAttribute('src');
  }
  private hydrate() {
    if (!this.active()) return;
    for (const [tile, state] of this.tiles) {
      if (this.loading >= 3) break; if (!state.visible || state.url || state.controller) continue;
      const controller = new AbortController(); state.controller = controller; this.loading++; const signal = AbortSignal.any([controller.signal, this.signal]);
      void this.getFile(state.item, signal).then(file => { if (!this.active() || signal.aborted || !state.visible) return; state.url = URL.createObjectURL(file); state.file = file; tile.querySelector('img')!.src = state.url; tile.classList.remove('is-error'); })
        .catch(error => {
          if (signal.aborted) return;
          if (error instanceof Error && error.message === 'NON_ANIMATED_RESULT') { this.observer.unobserve(tile); this.tiles.delete(tile); tile.remove(); }
          else tile.classList.add('is-error');
        }).finally(() => { this.loading--; this.hydrate(); });
    }
  }
  private async getFile(item: MediaItem, signal: AbortSignal): Promise<File> {
    signal.throwIfAborted(); const cached = [...this.tiles.values()].find(state => state.item.id === item.id && state.file)?.file; if (cached) return cached;
    let blob: Blob;
    if (item.asset) blob = await starterMedia(item.asset, signal);
    else blob = item.favorite ? await this.options.file(item.favorite, signal) : await this.options.media(item.id, signal);
    const file = await validateMemeFile(blob, item.title, signal);
    if (item.animatedOnly && !await detectImageAnimation(file, signal)) throw new Error('NON_ANIMATED_RESULT');
    return file;
  }
  private async perform(item: MediaItem, action: 'send' | 'save' | 'remove') {
    if (this.busy || !this.active()) return; this.busy = true; this.panel.setAttribute('aria-busy', 'true'); this.say(action === 'send' ? '正在发送…' : '正在保存…');
    try {
      if (action === 'remove') await this.options.remove(item.id, this.signal);
      else { const file = await this.getFile(item, this.signal); if (!this.active()) return; if (action === 'send') await this.options.send(file, this.signal); else this.say(await this.options.save(file, this.signal) ? '已收藏到本机' : '已在收藏中'); }
      if (!this.active()) return; if (action === 'send') this.options.close(false); else if (action === 'remove') await this.local();
    } catch (error) { if (this.active()) this.say(error instanceof Error ? error.message : '操作失败，请重试'); }
    finally { this.busy = false; this.panel.removeAttribute('aria-busy'); }
  }
  private async showPreview(item: MediaItem, tile: HTMLElement) {
    if (this.preview || !this.active() || !tile.isConnected || !this.tiles.has(tile)) return;
    const sheet = document.createElement('div'); sheet.className = 'meme-preview'; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', '表情预览');
    sheet.style.setProperty('--meme-preview-size', `${tile.querySelector('img')?.getBoundingClientRect().width ?? tile.clientWidth}px`);
    sheet.innerHTML = `<div class="meme-preview-body"><div class="meme-preview-image"><span role="status">正在加载…</span></div><div class="meme-preview-actions"><button type="button" data-action="save">${memeIcons.star}<span>${item.favorite && !item.pack ? '取消收藏' : '添加到收藏'}</span></button><button type="button" data-action="send">${createElement(Send).outerHTML}<span>发送</span></button></div><button type="button" class="meme-preview-close">关闭</button></div>`;
    this.options.root.append(sheet); this.preview = sheet; let url: string | undefined; const controller = new AbortController();
    const dialog = mountDialog(sheet, { signal: this.signal, isActive: () => this.active(), returnFocus: tile, onClose: () => { controller.abort(); if (url) URL.revokeObjectURL(url); sheet.querySelector('img')?.removeAttribute('src'); this.preview = null; } });
    sheet.addEventListener('click', event => { if (event.target === sheet) dialog.close(); }); sheet.querySelector('.meme-preview-close')!.addEventListener('click', () => dialog.close());
    for (const action of ['save', 'send'] as const) sheet.querySelector(`[data-action="${action}"]`)!.addEventListener('click', () => { dialog.close({ animate: false }); void this.perform(item, action === 'save' && item.favorite && !item.pack ? 'remove' : action); });
    try { const file = await this.getFile(item, AbortSignal.any([this.signal, controller.signal])); if (!this.active() || controller.signal.aborted) return; url = URL.createObjectURL(file); const image = document.createElement('img'); image.src = url; image.alt = item.title; sheet.querySelector('.meme-preview-image')!.replaceChildren(image); }
    catch { if (!controller.signal.aborted) sheet.querySelector('.meme-preview-image')!.textContent = '图片加载失败，可关闭后重试'; }
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.controller.abort();
    if (this.preview) closeDialog(this.preview, { animate: false, restoreFocus: false }); if (this.overlay) closeDialog(this.overlay, { animate: false, restoreFocus: false });
    this.observer.disconnect(); this.request?.abort(); this.stopShortcutAnimation(); for (const tile of this.tiles.keys()) this.unload(tile);
    this.tiles.clear(); this.favorites = []; this.packs = []; this.input.value = ''; this.panel.remove(); this.options.host.classList.remove('has-meme-panel');
  }
}
