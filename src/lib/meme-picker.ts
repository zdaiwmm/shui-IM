import { mountDialog, closeDialog } from './dialog';
import { validateMemeFile, type MemeFavorite } from './meme-media';
import { createElement, Smile, Star, Search, Keyboard, ChevronDown, Image, X } from 'lucide';

export const memeIcons = {
  smile: createElement(Smile).outerHTML,
  star: createElement(Star).outerHTML,
  search: createElement(Search).outerHTML,
  keyboard: createElement(Keyboard).outerHTML,
  down: createElement(ChevronDown).outerHTML,
  image: createElement(Image).outerHTML,
};
const categories = ['热门', '搞笑', '可爱', '开心', '无语', '生气', '晚安', '打工'];

type SearchItem = { id: string; title: string };
type Item = { id: string; title: string; favorite?: MemeFavorite };
export type MemePickerOptions = {
  host: HTMLElement; root: HTMLElement; signal: AbortSignal; isActive: () => boolean;
  list: () => Promise<MemeFavorite[]>;
  file: (item: MemeFavorite, signal: AbortSignal) => Promise<File>;
  save: (file: File, signal: AbortSignal) => Promise<boolean>;
  remove: (id: string, signal: AbortSignal) => Promise<void>;
  send: (file: File, signal: AbortSignal) => Promise<void>;
  search: (query: string, page: number, signal: AbortSignal) => Promise<{ items: SearchItem[]; nextPage: number | null; source?: string }>;
  media: (id: string, signal: AbortSignal) => Promise<Blob>;
  close: (keyboard: boolean) => void;
  onSearchPointer: (input: HTMLInputElement, event: PointerEvent) => void;
  onKeyboardPointer: (event: PointerEvent) => void;
};

export class MemePicker {
  private controller = new AbortController();
  private request: AbortController | null = null;
  private signal: AbortSignal;
  private panel = document.createElement('section');
  private grid!: HTMLElement;
  private status!: HTMLElement;
  private more!: HTMLButtonElement;
  private input!: HTMLInputElement;
  private observer!: IntersectionObserver;
  private tiles = new Map<HTMLElement, { item: Item; url?: string; file?: File; controller?: AbortController; visible: boolean }>();
  private favorites: MemeFavorite[] = [];
  private tab: 'favorites' | 'search' = 'search';
  private query = '';
  private nextPage: number | null = null;
  private category = '热门';
  private disposed = false;
  private generation = 0;
  private busy = false;
  private preview: HTMLElement | null = null;
  private loading = 0;
  private searching = false;
  private autoLoad = true;

  constructor(private options: MemePickerOptions) {
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
    this.panel.className = 'meme-panel';
    this.panel.id = 'meme-panel';
    this.panel.setAttribute('aria-label', '梗图');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.innerHTML = `
      <header class="meme-header"><h2>梗图</h2><button type="button" class="icon-button" data-mode="close" aria-label="关闭梗图" title="关闭">${createElement(X).outerHTML}</button></header>
      <div class="meme-search"><label class="sr-only" for="meme-query">搜索梗图</label>
        <input id="meme-query" type="search" maxlength="80" placeholder="搜索网络梗图" autocomplete="off" enterkeyhint="search" />
        <button type="button" aria-label="搜索" title="搜索">${memeIcons.search}</button></div>
      <div class="meme-categories" role="group" aria-label="梗图类型">${categories.map(category => `<button type="button" data-category="${category}" aria-pressed="${category === '热门'}">${category}</button>`).join('')}</div>
      <div class="meme-scroll"><div class="meme-grid" role="group" aria-label="梗图列表"></div>
        <p class="meme-status" role="status"></p><button type="button" class="meme-more" hidden>加载更多</button></div>
      <nav class="meme-tabs" aria-label="梗图分类">
        <span class="meme-source"></span>
        <div role="tablist" aria-label="梗图来源"><button type="button" role="tab" aria-selected="true" data-mode="search" title="网络梗图" aria-label="网络梗图">${memeIcons.image}<span>网络梗图</span></button>
        <button type="button" role="tab" aria-selected="false" data-mode="favorites" title="我的收藏" aria-label="我的收藏" tabindex="-1">${memeIcons.star}<span>收藏</span></button></div>
      </nav>`;
    this.grid = this.panel.querySelector('.meme-grid')!;
    this.status = this.panel.querySelector('.meme-status')!;
    this.more = this.panel.querySelector('.meme-more')!;
    this.input = this.panel.querySelector('input')!;
    this.input.addEventListener('pointerdown', event => options.onSearchPointer(this.input, event));
    this.input.addEventListener('input', () => { if (this.tab === 'favorites') this.renderFavorites(); });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); void this.submit(); }
    });
    this.panel.querySelector('.meme-search button')!.addEventListener('click', () => void this.submit());
    this.panel.querySelectorAll<HTMLButtonElement>('[data-category]').forEach(button => button.addEventListener('click', () => {
      this.category = button.dataset.category!;
      this.input.value = '';
      this.panel.querySelectorAll('[data-category]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      void this.submit();
    }));
    this.more.addEventListener('click', () => void this.search(false));
    this.panel.querySelector('.meme-scroll')!.addEventListener('scroll', event => {
      const el = event.currentTarget as HTMLElement;
      if (this.tab === 'search' && this.autoLoad && !this.searching && this.nextPage && !this.more.hidden && el.scrollHeight - el.scrollTop - el.clientHeight < 100) void this.search(false);
    }, { passive: true });
    this.panel.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
      if (button.dataset.mode === 'keyboard') button.addEventListener('pointerdown', event => options.onKeyboardPointer(event));
      button.addEventListener('click', () => {
        const mode = button.dataset.mode;
        if (mode === 'keyboard' || mode === 'close') options.close(mode === 'keyboard');
        else void this.switchTab(mode as 'favorites' | 'search');
      });
    });
    this.panel.querySelector('[role="tablist"]')!.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
        event.preventDefault();
        const tab = key === 'Home' ? 'search' : key === 'End' ? 'favorites' : this.tab === 'favorites' ? 'search' : 'favorites';
        void this.switchTab(tab);
        this.panel.querySelector<HTMLButtonElement>(`[data-mode="${tab}"]`)!.focus();
      }
    });
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = this.tiles.get(entry.target as HTMLElement);
        if (!state) continue;
        state.visible = entry.isIntersecting;
        if (!state.visible) this.unload(entry.target as HTMLElement);
      }
      this.hydrate();
    }, { root: this.panel.querySelector('.meme-scroll'), rootMargin: '0px' });
    options.root.append(this.panel);
    mountDialog(this.panel, { signal: this.signal, isActive: () => this.active(),
      returnFocus: options.root.querySelector<HTMLElement>('#open-memes'),
      initialFocus: this.panel.querySelector<HTMLElement>('[data-mode="close"]'),
      onClose: () => { if (!this.disposed) options.close(false); },
    });
    const syncViewport = () => {
      const viewport = window.visualViewport;
      this.panel.style.setProperty('--meme-height', `${viewport?.height ?? window.innerHeight}px`);
      this.panel.style.setProperty('--meme-top', `${viewport?.offsetTop ?? 0}px`);
    };
    window.visualViewport?.addEventListener('resize', syncViewport, { signal: this.signal });
    window.visualViewport?.addEventListener('scroll', syncViewport, { signal: this.signal });
    window.addEventListener('resize', syncViewport, { signal: this.signal });
    syncViewport();
    this.signal.addEventListener('abort', () => this.dispose(), { once: true });
    void this.switchTab('search');
  }

  private active() { return !this.signal.aborted && this.options.isActive() && this.panel.isConnected; }
  private say(message: string) { if (this.active()) this.status.textContent = message; }
  private clear() {
    this.generation++; this.request?.abort(); this.searching = false;
    this.observer.disconnect();
    for (const element of this.tiles.keys()) this.unload(element);
    this.tiles.clear(); this.grid.replaceChildren(); this.status.replaceChildren(); this.more.hidden = true;
    this.panel.querySelector('.meme-scroll')!.scrollTop = 0;
  }
  private async switchTab(tab: 'favorites' | 'search') {
    this.clear(); this.tab = tab; this.input.value = ''; this.query = ''; this.nextPage = null;
    this.input.placeholder = tab === 'favorites' ? '搜索收藏' : '搜索网络梗图';
    this.panel.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach(button => {
      const selected = button.dataset.mode === tab;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
    (this.panel.querySelector('.meme-categories') as HTMLElement).hidden = tab !== 'search';
    this.panel.dataset.tab = tab;
    this.panel.querySelector('.meme-source')!.textContent = '';
    if (tab === 'search') { await this.submit(); return; }
    const generation = this.generation;
    this.say('正在读取收藏…');
    try {
      const favorites = await this.options.list();
      if (!this.active() || generation !== this.generation) return;
      this.favorites = favorites; this.renderFavorites();
    } catch { this.say('收藏读取失败，请切换后重试'); }
  }
  private renderFavorites() {
    this.clear();
    const query = this.input.value.trim().toLocaleLowerCase();
    const items = this.favorites.filter(item => item.name.toLocaleLowerCase().includes(query));
    this.append(items.map(item => ({ id: item.id, title: item.name || '收藏梗图', favorite: item })));
    this.say(items.length ? '' : query ? '没有匹配的收藏' : '暂无收藏');
  }
  private async submit() {
    this.input.blur();
    if (this.tab === 'favorites') { this.renderFavorites(); return; }
    const query = this.input.value.trim();
    this.query = query || this.category; this.clear(); this.nextPage = 1;
    this.autoLoad = true;
    await this.search(true);
  }
  private async search(first: boolean) {
    if (!this.active() || this.searching || !this.nextPage) return;
    this.request = new AbortController();
    const signal = AbortSignal.any([this.signal, this.request.signal]);
    const generation = this.generation;
    this.searching = true; this.more.hidden = true; this.say('正在搜索…');
    try {
      const result = await this.options.search(this.query, this.nextPage, signal);
      if (!this.active() || generation !== this.generation) return;
      this.append(result.items); this.nextPage = result.nextPage;
      this.panel.querySelector('.meme-source')!.textContent = result.source === 'Imgflip' ? 'Imgflip · 热门图库' : '';
      this.autoLoad = true; this.more.textContent = '加载更多';
      this.more.hidden = !this.nextPage;
      this.say(first && !result.items.length ? '没有找到相关梗图' : !this.nextPage ? '没有更多了' : '');
    } catch (error) {
      if (!signal.aborted && generation === this.generation) {
        this.say(error instanceof Error ? error.message : '搜索失败，请重试');
        this.autoLoad = false;
        this.more.textContent = '重试'; this.more.hidden = false;
      }
    } finally { if (generation === this.generation) this.searching = false; }
  }
  private append(items: Item[]) {
    for (const item of items) {
      const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'meme-tile';
      tile.title = `${item.title}；长按预览`; tile.setAttribute('aria-label', `发送 ${item.title}`);
      const img = document.createElement('img'); img.alt = item.title; img.draggable = false;
      tile.append(img); this.grid.append(tile);
      this.tiles.set(tile, { item, visible: false }); this.observer.observe(tile);
      let timer: number | undefined; let held = false; let x = 0; let y = 0;
      const cancel = () => { clearTimeout(timer); timer = undefined; };
      tile.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        held = false; x = event.clientX; y = event.clientY;
        timer = window.setTimeout(() => { held = true; void this.showPreview(item, tile); }, 450);
      });
      tile.addEventListener('pointermove', event => { if (Math.hypot(event.clientX - x, event.clientY - y) > 10) cancel(); });
      for (const name of ['pointerup', 'pointercancel', 'pointerleave'] as const) tile.addEventListener(name, cancel);
      this.signal.addEventListener('abort', cancel, { once: true });
      tile.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); held = true; void this.showPreview(item, tile); });
      tile.addEventListener('click', event => { event.preventDefault(); if (held) { held = false; return; } void this.perform(item, 'send'); });
    }
  }
  private unload(tile: HTMLElement) {
    const state = this.tiles.get(tile);
    state?.controller?.abort();
    if (state?.url) URL.revokeObjectURL(state.url);
    if (state) { state.url = undefined; state.file = undefined; state.controller = undefined; }
    tile.querySelector('img')?.removeAttribute('src');
  }
  private hydrate() {
    if (!this.active()) return;
    for (const [tile, state] of this.tiles) {
      if (this.loading >= 3) break;
      if (!state.visible || state.url || state.controller) continue;
      const controller = new AbortController(); state.controller = controller; this.loading++;
      const signal = AbortSignal.any([controller.signal, this.signal]);
      void this.getFile(state.item, signal).then(file => {
        if (!this.active() || signal.aborted || !state.visible) return;
        state.url = URL.createObjectURL(file);
        state.file = file;
        tile.querySelector('img')!.src = state.url;
        tile.classList.remove('is-error');
      }).catch(() => { if (!signal.aborted) tile.classList.add('is-error'); }).finally(() => { this.loading--; this.hydrate(); });
    }
  }
  private async getFile(item: Item, signal: AbortSignal) {
    signal.throwIfAborted();
    const cached = [...this.tiles.values()].find(state => state.item.id === item.id && state.file)?.file;
    if (cached) return cached;
    const blob = item.favorite ? await this.options.file(item.favorite, signal) : await this.options.media(item.id, signal);
    return validateMemeFile(blob, item.title, signal);
  }
  private async perform(item: Item, action: 'send' | 'save' | 'remove') {
    if (this.busy || !this.active()) return;
    this.busy = true; this.panel.setAttribute('aria-busy', 'true'); this.say(action === 'send' ? '正在发送…' : '正在保存…');
    try {
      if (action === 'remove') await this.options.remove(item.id, this.signal);
      else {
        const file = await this.getFile(item, this.signal);
        if (!this.active()) return;
        if (action === 'send') await this.options.send(file, this.signal);
        else {
          const added = await this.options.save(file, this.signal);
          this.say(added ? '已收藏到本机' : '已在收藏中');
        }
      }
      if (!this.active()) return;
      if (action === 'send') this.say('已发送');
      if (action === 'remove') await this.switchTab('favorites');
    } catch (error) { if (this.active()) this.say(error instanceof Error ? error.message : '操作失败，请重试'); }
    finally { this.busy = false; this.panel.removeAttribute('aria-busy'); }
  }
  private async showPreview(item: Item, tile: HTMLElement) {
    if (this.preview || !this.active() || !tile.isConnected || !this.tiles.has(tile)) return;
    const sheet = document.createElement('div'); sheet.className = 'meme-preview';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', '梗图预览');
    sheet.innerHTML = `<div class="meme-preview-body"><div class="meme-preview-image"><span role="status">正在加载…</span></div>
      <div class="meme-preview-actions"><button type="button" data-action="save">${memeIcons.star}<span>${item.favorite ? '取消收藏' : '添加到收藏'}</span></button>
      <button type="button" data-action="send"><span>发送</span></button></div><button type="button" class="meme-preview-close">关闭</button></div>`;
    this.options.root.append(sheet); this.preview = sheet;
    let url: string | undefined;
    const controller = new AbortController();
    const dialog = mountDialog(sheet, { signal: this.signal, isActive: () => this.active(), returnFocus: tile,
      onClose: () => { controller.abort(); if (url) URL.revokeObjectURL(url); sheet.querySelector('img')?.removeAttribute('src'); this.preview = null; } });
    sheet.addEventListener('click', event => { if (event.target === sheet) dialog.close(); });
    sheet.querySelector('.meme-preview-close')!.addEventListener('click', () => dialog.close());
    for (const action of ['save', 'send'] as const) sheet.querySelector(`[data-action="${action}"]`)!.addEventListener('click', () => {
      dialog.close(); void this.perform(item, action === 'save' && item.favorite ? 'remove' : action);
    });
    try {
      const file = await this.getFile(item, AbortSignal.any([this.signal, controller.signal]));
      if (!this.active() || controller.signal.aborted) return;
      url = URL.createObjectURL(file);
      const image = document.createElement('img'); image.src = url; image.alt = item.title;
      sheet.querySelector('.meme-preview-image')!.replaceChildren(image);
    } catch { if (!controller.signal.aborted) sheet.querySelector('.meme-preview-image')!.textContent = '图片加载失败，可关闭后重试'; }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.controller.signal.aborted) this.controller.abort();
    if (this.preview) closeDialog(this.preview, { animate: false, restoreFocus: false });
    this.observer?.disconnect(); this.request?.abort();
    for (const tile of this.tiles.keys()) this.unload(tile);
    this.tiles.clear(); this.favorites = [];
    closeDialog(this.panel, { animate: false, restoreFocus: false });
    this.panel.remove();
  }
}
