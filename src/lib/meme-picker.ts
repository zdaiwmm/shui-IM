import { mountDialog, closeDialog } from './dialog';
import { CHAT_KEYBOARD_LAYOUT_MS, chatKeyboardLayoutProgress } from './chat-keyboard-layout';
import { validateMemeFile, type MemeFavorite } from './meme-media';
import { detectImageAnimation } from './image-animation';
import { MAX_PACK_BYTES, type MediaKind, type MediaItem, type MediaSearchResult, type RemotePack, type RemotePackDetail, type StickerPack } from './sticker-library';
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
  reorderPacks: (ids: string[], signal: AbortSignal) => Promise<void>;
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
  private observer: IntersectionObserver;
  private tiles = new Map<HTMLElement, Tile>();
  private mediaCache = new Map<string, File>();
  private mediaCacheBytes = 0;
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
  private expanded = false;
  private autoPage: IntersectionObserver;
  private sentinel = document.createElement('div');
  private sheetAnimation?: Animation;
  private halfHeight = 0;
  private suppressShortcutClickUntil = 0;
  private closing = false;
  private recentGrid: HTMLElement | null = null;
  private browseGrid: HTMLElement | null = null;
  private recentCount = 0;

  constructor(private options: MemePickerOptions) {
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
    this.panel.className = 'meme-panel'; this.panel.id = 'meme-panel';
    this.panel.setAttribute('role', 'region'); this.panel.setAttribute('aria-label', '表情');
    this.panel.innerHTML = `
      <div class="meme-pack-shortcuts" aria-label="贴纸合集"></div>
      <button type="button" class="meme-open-search">${memeIcons.search}<span>搜索 GIFs</span></button>
      <header class="meme-search-header" hidden><button type="button" class="meme-back" aria-label="返回表情面板" title="返回">${createElement(ArrowLeft).outerHTML}</button>
        <form class="meme-search"><label class="sr-only" for="meme-query">搜索 GIFs</label><input id="meme-query" type="search" maxlength="80" placeholder="搜索 GIFs" autocomplete="off" enterkeyhint="search" /><button type="submit" aria-label="搜索" title="搜索">${memeIcons.search}</button></form>
        <button type="button" class="meme-close" aria-label="关闭表情" title="关闭">${createElement(X).outerHTML}</button></header>
      <div class="meme-scroll"><div class="meme-grid"></div><p class="meme-status" role="status"></p><button type="button" class="meme-more" hidden>加载更多</button><p class="meme-source"></p></div>
      <nav class="meme-tabs" aria-label="表情分类"><div role="tablist" aria-label="表情类型"><button type="button" role="tab" aria-selected="true" data-kind="gifs">GIFs</button><button type="button" role="tab" aria-selected="false" tabindex="-1" data-kind="stickers">贴纸</button></div><button type="button" class="meme-collapse" aria-label="收起表情" title="收起">${memeIcons.down}</button></nav>`;
    this.grid = this.panel.querySelector('.meme-grid')!; this.status = this.panel.querySelector('.meme-status')!;
    this.input = this.panel.querySelector('input')!; this.more = this.panel.querySelector('.meme-more')!;
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
    this.sentinel.className = 'meme-page-sentinel';
    this.more.before(this.sentinel);
    this.autoPage = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && this.more.hidden) void this.search();
    }, { root: this.panel.querySelector('.meme-scroll'), rootMargin: '120px' });
    this.autoPage.observe(this.sentinel);
    const shortcuts = this.panel.querySelector<HTMLElement>('.meme-pack-shortcuts')!;
    type SheetDrag = { id: number; x: number; y: number; height: number; full: boolean; moving: boolean; scrolling: boolean; scrollLeft: number; fromPack: boolean; lastX: number; lastAt: number; velocity: number; overshoot: number };
    type ShortcutHold = { id: number; x: number; y: number; button: HTMLButtonElement; timer: number };
    type ShortcutReorder = {
      id: number; button: HTMLButtonElement; floating: HTMLButtonElement; placeholder: HTMLElement | null;
      startIndex: number; targetIndex: number; startX: number; startY: number; dx: number; dy: number;
      originalIds: string[]; originalPacks: StickerPack[];
    };
    let drag: SheetDrag | undefined;
    let hold: ShortcutHold | undefined;
    let reorder: ShortcutReorder | undefined;
    let settling: HTMLButtonElement | undefined;
    let shortcutAnimation: number | null = null;
    const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const packButtons = () => [...shortcuts.querySelectorAll<HTMLButtonElement>('button[data-shortcut^="pack:"]')];
    const packId = (button: HTMLButtonElement) => button.dataset.shortcut!.slice(5);
    const shortcutMax = () => Math.max(0, shortcuts.scrollWidth - shortcuts.clientWidth);
    const clearShortcutPull = () => {
      for (const button of shortcuts.querySelectorAll<HTMLElement>('button')) button.style.translate = '';
    };
    const renderShortcutPull = (offset: number) => {
      for (const button of shortcuts.querySelectorAll<HTMLElement>('button')) button.style.translate = `${offset.toFixed(2)}px 0`;
    };
    const rubberBand = (offset: number) => offset === 0 ? 0
      : Math.sign(offset) * (Math.abs(offset) * 0.34 + Math.min(18, Math.abs(offset) * 0.04));
    const stopShortcutAnimation = () => {
      if (shortcutAnimation !== null) cancelAnimationFrame(shortcutAnimation);
      shortcutAnimation = null;
    };
    const releaseShortcut = (velocity: number, overshoot: number) => {
      stopShortcutAnimation();
      let currentVelocity = Math.max(-2.2, Math.min(2.2, velocity));
      let pull = overshoot;
      let lastAt = performance.now();
      const tick = (now: number) => {
        const elapsed = Math.min(32, Math.max(1, now - lastAt));
        lastAt = now;
        if (Math.abs(pull) > 0.25) {
          pull *= Math.pow(0.0008, elapsed / 1000);
          renderShortcutPull(pull);
        } else {
          pull = 0;
          clearShortcutPull();
          if (Math.abs(currentVelocity) > 0.015) {
            const next = shortcuts.scrollLeft + currentVelocity * elapsed;
            const max = shortcutMax();
            const clamped = Math.max(0, Math.min(max, next));
            if (clamped !== next) currentVelocity *= -0.22;
            shortcuts.scrollLeft = clamped;
            currentVelocity *= Math.pow(0.055, elapsed / 1000);
          } else currentVelocity = 0;
        }
        if (Math.abs(pull) > 0.25 || Math.abs(currentVelocity) > 0.015) shortcutAnimation = requestAnimationFrame(tick);
        else { clearShortcutPull(); shortcutAnimation = null; }
      };
      shortcutAnimation = requestAnimationFrame(tick);
    };
    const capturePositions = () => new Map([...shortcuts.querySelectorAll<HTMLElement>('button[data-shortcut]')].map(node => [node, node.getBoundingClientRect()]));
    const animatePositions = (before: Map<HTMLElement, DOMRect>) => {
      if (reducedMotion()) return;
      for (const [node, start] of before) {
        if (!node.isConnected) continue;
        const end = node.getBoundingClientRect();
        const x = start.left - end.left; const y = start.top - end.top;
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
        node.animate([{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          { duration: 240, easing: 'cubic-bezier(.16, 1, .3, 1)' });
      }
    };
    const cancelHold = () => {
      if (!hold) return;
      window.clearTimeout(hold.timer);
      hold = undefined;
    };
    const reorderDom = (ids: string[]) => {
      const before = capturePositions();
      const buttons = new Map(packButtons().map(button => [packId(button), button]));
      for (const id of ids) {
        const button = buttons.get(id);
        if (button) shortcuts.append(button);
      }
      animatePositions(before);
    };
    const saveOrder = (ids: string[], previousPacks: StickerPack[], label: string) => {
      const byId = new Map(this.packs.map(pack => [pack.id, pack]));
      this.packs = ids.map(id => byId.get(id)!).filter(Boolean);
      this.busy = true;
      void this.options.reorderPacks(ids, this.signal).then(() => {
        if (this.active()) this.say(`已移动 ${label}`);
      }).catch(() => {
        if (!this.active() || this.signal.aborted) return;
        this.packs = previousPacks;
        reorderDom(previousPacks.map(pack => pack.id));
        this.say('合集顺序未能保存，已恢复');
      }).finally(() => { this.busy = false; });
    };
    const placePlaceholder = (targetIndex: number, force = false) => {
      if (!reorder) return;
      if (targetIndex === reorder.targetIndex && (targetIndex !== reorder.startIndex || reorder.placeholder || !force)) return;
      const before = capturePositions();
      if (targetIndex === reorder.startIndex && !force) {
        reorder.placeholder?.remove();
        reorder.placeholder = null;
      } else {
        reorder.placeholder ??= Object.assign(document.createElement('span'), { className: 'meme-shortcut-placeholder' });
        reorder.placeholder.setAttribute('aria-hidden', 'true');
        const remaining = packButtons();
        const reference = remaining[targetIndex];
        if (reference) shortcuts.insertBefore(reorder.placeholder, reference);
        else shortcuts.append(reorder.placeholder);
      }
      reorder.targetIndex = targetIndex;
      animatePositions(before);
    };
    const beginReorder = (pending: ShortcutHold) => {
      if (this.busy || !pending.button.isConnected || !this.active()) return;
      const buttons = packButtons();
      const startIndex = buttons.indexOf(pending.button);
      if (startIndex < 0) return;
      const bounds = pending.button.getBoundingClientRect();
      const before = capturePositions();
      const floating = pending.button.cloneNode(true) as HTMLButtonElement;
      floating.className = 'meme-shortcut-float';
      floating.tabIndex = -1;
      floating.setAttribute('aria-hidden', 'true');
      floating.style.left = `${bounds.left}px`;
      floating.style.top = `${bounds.top}px`;
      floating.style.width = `${bounds.width}px`;
      floating.style.height = `${bounds.height}px`;
      floating.style.transform = 'translate3d(0, 0, 0) scale(1.08)';
      pending.button.remove();
      this.options.root.append(floating);
      reorder = {
        id: pending.id, button: pending.button, floating, placeholder: null,
        startIndex, targetIndex: startIndex, startX: pending.x, startY: pending.y, dx: 0, dy: 0,
        originalIds: buttons.map(packId), originalPacks: [...this.packs],
      };
      hold = undefined;
      drag = undefined;
      shortcuts.dataset.reordering = 'true';
      this.suppressShortcutClickUntil = performance.now() + 700;
      navigator.vibrate?.(18);
      try { shortcuts.setPointerCapture(pending.id); } catch { /* Synthetic pointers do not own capture. */ }
      animatePositions(before);
    };
    const finishReorder = (event: PointerEvent) => {
      if (!reorder || reorder.id !== event.pointerId) return false;
      const cancelled = event.type === 'pointercancel';
      const targetIndex = cancelled ? reorder.startIndex : reorder.targetIndex;
      placePlaceholder(targetIndex, true);
      const state = reorder;
      reorder = undefined;
      settling = state.floating;
      this.busy = true;
      const placeholder = state.placeholder!;
      const remainingIds = packButtons().map(packId);
      remainingIds.splice(targetIndex, 0, packId(state.button));
      const changed = !cancelled && remainingIds.some((id, index) => id !== state.originalIds[index]);
      const current = state.floating.getBoundingClientRect();
      const destination = placeholder.getBoundingClientRect();
      state.floating.style.left = `${current.left}px`;
      state.floating.style.top = `${current.top}px`;
      state.floating.style.transform = 'none';
      const complete = () => {
        if (placeholder.isConnected) placeholder.replaceWith(state.button);
        state.floating.remove();
        if (settling === state.floating) settling = undefined;
        shortcuts.removeAttribute('data-reordering');
        try { shortcuts.releasePointerCapture(state.id); } catch { /* Synthetic pointers do not own capture. */ }
        if (!this.active()) { this.busy = false; return; }
        if (changed) saveOrder(remainingIds, state.originalPacks, state.button.title);
        else { this.packs = state.originalPacks; this.busy = false; }
      };
      if (reducedMotion()) complete();
      else {
        const animation = state.floating.animate([
          { transform: 'translate3d(0, 0, 0) scale(1.08)' },
          { transform: `translate3d(${destination.left - current.left}px, ${destination.top - current.top}px, 0) scale(1)` },
        ], { duration: 220, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' });
        void animation.finished.then(complete, complete);
      }
      return true;
    };
    shortcuts.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.sheetAnimation || this.preview || this.busy || reorder) return;
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-shortcut^="pack:"]') : null;
      stopShortcutAnimation(); clearShortcutPull();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, height: this.panel.getBoundingClientRect().height,
        full: Boolean(this.overlay), moving: false, scrolling: false, scrollLeft: shortcuts.scrollLeft, fromPack: Boolean(button),
        lastX: event.clientX, lastAt: performance.now(), velocity: 0, overshoot: 0 };
      if (button) {
        const pending: ShortcutHold = { id: event.pointerId, x: event.clientX, y: event.clientY, button, timer: 0 };
        pending.timer = window.setTimeout(() => beginReorder(pending), 500);
        hold = pending;
      }
    }, { signal: this.signal });
    window.addEventListener('pointermove', event => {
      if (reorder?.id === event.pointerId) {
        event.preventDefault();
        reorder.dx = event.clientX - reorder.startX;
        reorder.dy = event.clientY - reorder.startY;
        reorder.floating.style.transform = `translate3d(${reorder.dx}px, ${reorder.dy}px, 0) scale(1.08)`;
        const bar = shortcuts.getBoundingClientRect();
        if (event.clientX < bar.left + 32) shortcuts.scrollLeft -= 12;
        else if (event.clientX > bar.right - 32) shortcuts.scrollLeft += 12;
        const remaining = packButtons();
        const targetIndex = remaining.findIndex(button => event.clientX < button.getBoundingClientRect().left + button.getBoundingClientRect().width / 2);
        placePlaceholder(targetIndex < 0 ? remaining.length : targetIndex);
        return;
      }
      if (!drag || drag.id !== event.pointerId) return;
      const now = performance.now();
      const dy = event.clientY - drag.y; const dx = event.clientX - drag.x;
      if (hold && Math.hypot(dx, dy) > 10) cancelHold();
      if (!drag.moving && drag.fromPack && (drag.scrolling || Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy))) {
        drag.scrolling = true;
        event.preventDefault();
        const raw = drag.scrollLeft - dx;
        const clamped = Math.max(0, Math.min(shortcutMax(), raw));
        const elapsed = Math.max(1, now - drag.lastAt);
        drag.velocity = (event.clientX - drag.lastX) / elapsed * -1;
        drag.lastX = event.clientX; drag.lastAt = now;
        drag.overshoot = rubberBand(raw - clamped);
        shortcuts.scrollLeft = clamped;
        renderShortcutPull(drag.overshoot);
        return;
      }
      if (!drag.moving) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { drag = undefined; return; }
        if (Math.abs(dy) < 8 || Math.abs(dy) <= Math.abs(dx) * 1.5) return;
        cancelHold();
        drag.moving = true;
        this.expand();
        try { shortcuts.setPointerCapture(event.pointerId); } catch { /* Synthetic pointers do not own capture. */ }
        this.panel.style.animation = 'none';
        this.panel.style.top = 'auto';
      }
      event.preventDefault();
      const height = this.overlay!.getBoundingClientRect().height;
      this.panel.style.height = `${Math.max(this.halfHeight, Math.min(height, drag.height - dy))}px`;
    }, { signal: this.signal, passive: false });
    const finishDrag = (event: PointerEvent) => {
      if (finishReorder(event)) { cancelHold(); drag = undefined; return; }
      cancelHold();
      if (!drag || drag.id !== event.pointerId) return;
      const start = drag; drag = undefined;
      if (start.scrolling) {
        this.suppressShortcutClickUntil = performance.now() + 500;
        releaseShortcut(start.velocity, start.overshoot);
        return;
      }
      if (!start.moving) return;
      this.suppressShortcutClickUntil = performance.now() + 500;
      const height = this.panel.getBoundingClientRect().height;
      const fullHeight = this.overlay!.getBoundingClientRect().height;
      const full = event.type === 'pointercancel' ? start.full
        : start.full ? event.clientY - start.y < 50 : start.y - event.clientY > 50;
      const finish = () => {
        this.sheetAnimation = undefined;
        if (!this.active()) return;
        this.panel.style.removeProperty('height'); this.panel.style.removeProperty('top');
        if (!full) this.back(true);
      };
      if (reducedMotion()) finish();
      else this.animateSheet(height, full ? fullHeight : this.halfHeight, 'height', finish);
    };
    window.addEventListener('pointerup', finishDrag, { signal: this.signal });
    window.addEventListener('pointercancel', finishDrag, { signal: this.signal });
    shortcuts.addEventListener('keydown', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-shortcut^="pack:"]') : null;
      if (!button || !event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || this.busy || reorder) return;
      const ids = this.packs.map(pack => pack.id);
      const from = ids.indexOf(packId(button));
      const to = Math.max(0, Math.min(ids.length - 1, from + (event.key === 'ArrowLeft' ? -1 : 1)));
      if (from < 0 || from === to) return;
      event.preventDefault();
      const previousPacks = [...this.packs];
      ids.splice(to, 0, ids.splice(from, 1)[0]!);
      reorderDom(ids);
      button.focus({ preventScroll: true });
      saveOrder(ids, previousPacks, button.title);
    }, { signal: this.signal });
    shortcuts.addEventListener('contextmenu', event => {
      if (event.target instanceof Element && event.target.closest('[data-shortcut^="pack:"]')) event.preventDefault();
    }, { signal: this.signal });
    this.signal.addEventListener('abort', () => {
      stopShortcutAnimation();
      clearShortcutPull();
      cancelHold();
      reorder?.floating.remove();
      settling?.remove();
      reorder = undefined;
      settling = undefined;
    }, { once: true });
    shortcuts.addEventListener('click', event => {
      if (performance.now() < this.suppressShortcutClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, { signal: this.signal, capture: true });
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) { const tile = this.tiles.get(entry.target as HTMLElement); if (tile) { tile.visible = entry.isIntersecting; if (!tile.visible) this.unload(entry.target as HTMLElement); } }
      this.hydrate();
    }, { root: this.panel.querySelector('.meme-scroll'), rootMargin: '80px' });
    options.host.classList.add('has-meme-panel'); options.host.append(this.panel);
    this.animateSheet(this.panel.getBoundingClientRect().height, 0, 'translate');
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
  }
  private active() { return !this.disposed && !this.signal.aborted && this.options.isActive() && this.panel.isConnected; }
  private animateSheet(from: number, to: number, property: 'height' | 'translate', finish = () => {}) {
    this.sheetAnimation?.cancel(); this.sheetAnimation = undefined;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    const frames = Array.from({ length: 25 }, (_, index) => {
      const offset = index / 24;
      const value = from + (to - from) * chatKeyboardLayoutProgress(offset * CHAT_KEYBOARD_LAYOUT_MS);
      return property === 'height' ? { offset, height: `${value}px` } : { offset, transform: `translateY(${value}px)` };
    });
    const animation = this.panel.animate(frames, { duration: CHAT_KEYBOARD_LAYOUT_MS, fill: 'both' });
    this.sheetAnimation = animation;
    animation.onfinish = () => {
      if (this.sheetAnimation !== animation) return;
      this.sheetAnimation = undefined; animation.cancel();
      if (this.active()) finish();
    };
  }
  close(finish: () => void) {
    if (this.closing) return;
    this.closing = true; this.panel.inert = true; this.input.blur();
    const bounds = this.panel.getBoundingClientRect();
    const translate = new DOMMatrixReadOnly(getComputedStyle(this.panel).transform).m42;
    this.panel.style.height = `${bounds.height}px`;
    this.animateSheet(translate, translate + (visualViewport?.height ?? innerHeight) + (visualViewport?.offsetTop ?? 0) - bounds.top, 'translate', finish);
  }
  private hasPack(id: string) { return this.packs.some(pack => pack.id === id); }
  private say(value: string) { if (this.active()) this.status.textContent = value; }
  private clear() {
    this.generation++; this.request?.abort(); this.operation?.abort(); this.searching = false; this.observer.disconnect();
    for (const tile of this.tiles.keys()) if (!tile.closest('.meme-pack-shortcuts')) { this.unload(tile); this.tiles.delete(tile); }
    this.grid.replaceChildren(); this.status.replaceChildren(); this.more.hidden = true; this.nextPage = null;
    this.grid.className = 'meme-grid'; this.panel.querySelector('.meme-scroll')!.scrollTop = 0;
    this.recentGrid = null; this.browseGrid = null; this.recentCount = 0;
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
    const bar = this.panel.querySelector('.meme-pack-shortcuts')!;
    const control = (key: string, label: string, icon: string, action: () => void) => {
      const existing = [...bar.querySelectorAll<HTMLButtonElement>('button')].find(node => node.dataset.shortcut === key);
      if (existing) { existing.title = label; existing.setAttribute('aria-label', label); return existing; }
      const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = icon;
      button.dataset.shortcut = key;
      button.addEventListener('click', action); bar.append(button); return button;
    };
    control('search', '查找贴纸合集', createElement(Plus).outerHTML, () => { void this.switchKind('stickers').then(() => this.openSearch()); });
    control('favorites', '收藏', memeIcons.star, () => { this.favoriteView = !this.favoriteView; void this.local(); }).setAttribute('aria-pressed', String(this.favoriteView));
    for (const node of bar.querySelectorAll<HTMLElement>('[data-shortcut^="pack:"]')) {
      if (!this.hasPack(node.dataset.shortcut!.slice(5))) { this.unload(node); this.tiles.delete(node); node.remove(); }
    }
    for (const pack of this.packs) {
      const button = control(`pack:${pack.id}`, pack.title, '', () => { if (this.favoriteView || this.kind !== 'stickers') { void this.switchKind('stickers').then(() => this.jump(pack.id)); } else this.jump(pack.id); });
      button.setAttribute('aria-label', `${pack.title}，长按拖动排序`);
      button.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
      bar.append(button);
      const first = pack.items[0]; if (!first) continue;
      if (this.tiles.get(button)?.item.id === first.id) continue;
      this.unload(button); button.replaceChildren();
      const item: MediaItem = { id: first.id, title: pack.title, favorite: first, pack: pack.id };
      const image = document.createElement('img'); image.alt = ''; image.draggable = false; button.append(image); this.tiles.set(button, { item, visible: true });
    }
    this.hydrate();
  }
  private jump(id: string) {
    const section = [...this.grid.querySelectorAll<HTMLElement>('[data-pack]')].find(node => node.dataset.pack === id); if (!section) return;
    const scroll = this.panel.querySelector('.meme-scroll')!;
    scroll.scrollTo({ top: section.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  private async local() {
    this.clear(); this.panel.dataset.view = 'local'; const generation = this.generation;
    try {
      const [favorites, packs] = await Promise.all([this.options.list(), this.options.packs()]);
      if (!this.active() || generation !== this.generation) return;
      this.favorites = favorites; this.packs = packs; this.clear(); this.renderLocalItems(); this.shortcuts();
      if (!this.favoriteView && this.kind === 'gifs') { this.query = ''; this.nextPage = 1; await this.search(); }
    } catch { if (generation === this.generation) { this.shortcuts(); this.say('本地收藏或合集读取失败，请重新打开'); } }
  }
  private renderLocalItems() {
    if (this.favoriteView) {
      const items = this.favorites;
      this.append(items.map(item => ({ id: item.id, title: item.name, favorite: item }))); if (!items.length) this.say('暂无收藏');
    } else if (this.kind === 'stickers') {
      this.grid.classList.add('meme-pack-list');
      for (const pack of this.packs) {
        const section = document.createElement('section'); section.dataset.pack = pack.id;
        const header = document.createElement('header'); const title = document.createElement('h3'); title.textContent = pack.title; header.append(title);
        if (this.packs.includes(pack as StickerPack)) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.title = '移除合集'; remove.setAttribute('aria-label', `移除 ${pack.title}`); remove.innerHTML = createElement(Trash2).outerHTML;
          remove.addEventListener('click', () => { if (this.busy) return; this.busy = true; void this.options.removePack(pack.id, this.signal).then(() => this.local()).catch(() => this.say('移除失败，请重试')).finally(() => { this.busy = false; }); }); header.append(remove);
        }
        const grid = document.createElement('div'); grid.className = 'meme-pack-grid'; section.append(header, grid); this.grid.append(section);
        this.append(pack.items.map(item => ({ id: item.id, title: item.name, favorite: item, pack: pack.id })), grid);
      }
    }
  }
  private expand() {
    if (this.overlay) return;
    this.halfHeight = this.panel.getBoundingClientRect().height;
    this.expanded = true; this.openSearch(false, false);
    this.panel.parentElement?.classList.add('meme-expanded-dialog');
    (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = true;
  }
  private openSearch(load = true, animate = true) {
    if (this.expanded && this.overlay && load) {
      this.overlay.classList.remove('meme-expanded-dialog');
      (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = false;
      this.input.value = ''; void this.submit(); return;
    }
    if (!this.active() || this.overlay) return;
    const height = this.panel.getBoundingClientRect().height;
    this.halfHeight = height;
    const overlay = document.createElement('div'); overlay.className = 'meme-search-dialog'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', this.kind === 'gifs' ? '搜索 GIFs' : '搜索贴纸合集');
    this.overlay = overlay; this.options.root.append(overlay); overlay.append(this.panel);
    const view = visualViewport; overlay.style.setProperty('--meme-height', `${view?.height ?? innerHeight}px`); overlay.style.setProperty('--meme-top', `${view?.offsetTop ?? 0}px`);
    this.panel.dataset.view = 'search'; (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = false;
    mountDialog(overlay, { signal: this.signal, isActive: () => this.active(), initialFocus: this.panel.querySelector<HTMLElement>('.meme-back'), returnFocus: this.options.host.querySelector<HTMLElement>('#open-memes'),
      beforeClose: () => { this.back(); return false; } });
    if (animate) {
      this.panel.style.top = 'auto';
      this.animateSheet(height, overlay.getBoundingClientRect().height, 'height', () => this.panel.style.removeProperty('top'));
    }
    this.input.value = ''; if (load) void this.submit();
  }
  private back(preserve = false, animate = true) {
    if (!this.overlay || this.closing) return;
    if (this.packDetail) { void this.submit(); return; }
    if (this.expanded && !this.overlay.classList.contains('meme-expanded-dialog')) {
      this.overlay.classList.add('meme-expanded-dialog');
      (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = true;
      void this.local(); return;
    }
    if (animate && !preserve && !this.closing) {
      this.panel.style.top = 'auto';
      const overlay = this.overlay; const generation = this.generation;
      this.animateSheet(this.panel.getBoundingClientRect().height, this.halfHeight, 'height', () => {
        if (this.overlay !== overlay) return;
        // A newer search/detail operation owns the panel now. An old return
        // must not close it or abort its pending collection installation.
        if (this.generation !== generation) { this.panel.style.removeProperty('top'); return; }
        this.back(false, false);
      });
      return;
    }
    this.sheetAnimation?.cancel(); this.sheetAnimation = undefined;
    this.panel.style.removeProperty('top'); this.panel.style.removeProperty('height');
    this.expanded = false;
    const overlay = this.overlay; this.overlay = null; this.input.blur(); this.input.value = '';
    this.options.host.append(this.panel); (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = true;
    closeDialog(overlay, { animate: false, restoreFocus: false });
    if (!preserve) void this.local();
    this.panel.querySelector<HTMLButtonElement>('.meme-open-search')!.focus({ preventScroll: true });
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
      if (this.kind === 'gifs') {
        if (!this.query && this.panel.dataset.view === 'local') this.appendCatalog(result.items);
        else this.append(result.items);
      } else this.appendPacks(result.packs ?? []);
      this.nextPage = result.nextPage; this.more.hidden = true;
      this.panel.querySelector('.meme-source')!.textContent = result.source === '表情资源库' ? '' : result.source ?? ''; this.say(!this.grid.querySelector('.meme-tile, .meme-pack-result') ? '没有找到相关内容' : '');
    } catch (error) { if (!signal.aborted && generation === this.generation) { this.say(error instanceof Error ? error.message : '搜索失败，请重试'); this.more.textContent = '重试'; this.more.hidden = false; } }
    finally {
      if (generation === this.generation) {
        this.searching = false;
        if (this.nextPage && this.more.hidden) {
          this.autoPage.unobserve(this.sentinel); this.autoPage.observe(this.sentinel);
        }
      }
    }
  }
  private appendCatalog(items: MediaItem[]) {
    if (!this.recentGrid || !this.browseGrid) {
      this.grid.classList.add('meme-catalog-sections');
      const recent = document.createElement('section'); recent.className = 'meme-recent-section'; recent.setAttribute('aria-labelledby', 'meme-recent-title');
      recent.innerHTML = '<h3 id="meme-recent-title">最近发布</h3><div class="meme-recent-grid"></div>';
      const browse = document.createElement('section'); browse.className = 'meme-browse-section'; browse.setAttribute('aria-labelledby', 'meme-browse-title'); browse.hidden = true;
      browse.innerHTML = '<h3 id="meme-browse-title">更多 GIFs</h3><div class="meme-browse-grid"></div>';
      this.grid.append(recent, browse);
      this.recentGrid = recent.querySelector('.meme-recent-grid');
      this.browseGrid = browse.querySelector('.meme-browse-grid');
    }
    const recent = items.slice(0, Math.max(0, 10 - this.recentCount));
    const remaining = items.slice(recent.length);
    this.append(recent, this.recentGrid!);
    this.recentCount += recent.length;
    if (remaining.length) {
      this.browseGrid!.closest<HTMLElement>('.meme-browse-section')!.hidden = false;
      this.append(remaining, this.browseGrid!);
    }
  }
  private appendPacks(packs: RemotePack[]) {
    this.grid.classList.add('meme-pack-results');
    for (const pack of packs) {
      const row = document.createElement('article'); row.className = 'meme-pack-result';
      const cover = document.createElement('button'); cover.type = 'button'; cover.className = 'meme-pack-cover'; cover.setAttribute('aria-label', `查看 ${pack.title}`); cover.innerHTML = '<img alt="" draggable="false">';
      this.tiles.set(cover, { item: { id: pack.cover, title: pack.title }, visible: false }); this.observer.observe(cover);
      const title = document.createElement('h3'); title.textContent = pack.title;
      const add = document.createElement('button'); add.type = 'button'; add.className = 'meme-pack-add'; add.textContent = this.hasPack(pack.id) ? '解除添加' : '添加';
      add.dataset.danger = String(this.hasPack(pack.id));
      const progress = document.createElement('span'); progress.className = 'meme-pack-progress'; progress.setAttribute('role', 'status');
      add.addEventListener('click', () => void this.togglePack(pack, add, progress)); cover.addEventListener('click', () => void this.showPack(pack)); row.append(cover, title, add, progress); this.grid.append(row);
    }
  }
  private async showPack(pack: RemotePack) {
    if (this.busy || !this.active()) return;
    if (!this.overlay) this.openSearch(false);
    const generation = this.generation; this.say('正在加载合集…');
    try {
      const detail = await this.options.pack(pack.id, this.signal); if (!this.active() || generation !== this.generation) return;
      this.clear(); this.packDetail = true; this.grid.classList.add('meme-pack-list'); const header = document.createElement('header'); header.className = 'meme-pack-detail-header';
      const title = document.createElement('h3'); title.textContent = detail.title;
      const add = document.createElement('button'); add.type = 'button'; add.className = 'meme-pack-add'; add.textContent = this.hasPack(pack.id) ? '解除添加' : '添加';
      add.dataset.danger = String(this.hasPack(pack.id));
      const progress = document.createElement('span'); progress.setAttribute('role', 'status'); add.addEventListener('click', () => void this.togglePack(pack, add, progress, detail));
      const grid = document.createElement('div'); grid.className = 'meme-pack-grid'; header.append(title, add, progress); this.grid.append(header, grid); this.append(detail.items, grid);
      this.panel.querySelector<HTMLButtonElement>('.meme-back')!.focus({ preventScroll: true });
    } catch { if (this.active() && generation === this.generation) this.say('合集加载失败，请重试'); }
  }
  private async togglePack(pack: RemotePack, button: HTMLButtonElement, progress: HTMLElement, detail?: RemotePackDetail) {
    if (!this.hasPack(pack.id)) { await this.install(pack, button, progress, detail); return; }
    if (this.busy || !this.active()) return;
    this.busy = true; button.disabled = true;
    try {
      await this.options.removePack(pack.id, this.signal);
      if (!this.active()) return;
      this.packs = await this.options.packs(); button.textContent = '添加'; button.dataset.danger = 'false'; progress.textContent = ''; this.shortcuts();
    } catch { if (this.active()) progress.textContent = '解除失败，请重试'; }
    finally { this.busy = false; button.disabled = false; }
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
      this.packs = await this.options.packs(); button.textContent = '解除添加'; button.dataset.danger = 'true'; button.disabled = false; progress.textContent = `${files.length} 张 · 已下载`; this.shortcuts();
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
    const retained = this.mediaCache.get(item.id); if (retained) { this.mediaCache.delete(item.id); this.mediaCache.set(item.id, retained); return retained; }
    const blob = item.favorite ? await this.options.file(item.favorite, signal) : await this.options.media(item.id, signal);
    const file = await validateMemeFile(blob, item.title, signal);
    if (item.animatedOnly && !await detectImageAnimation(file, signal)) throw new Error('NON_ANIMATED_RESULT');
    signal.throwIfAborted();
    if (!item.favorite && file.size <= 16 * 1024 * 1024) {
      while (this.mediaCacheBytes + file.size > 16 * 1024 * 1024 && this.mediaCache.size) {
        const key = this.mediaCache.keys().next().value!; this.mediaCacheBytes -= this.mediaCache.get(key)!.size; this.mediaCache.delete(key);
      }
      this.mediaCacheBytes -= this.mediaCache.get(item.id)?.size ?? 0;
      this.mediaCache.set(item.id, file); this.mediaCacheBytes += file.size;
    }
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
    this.sheetAnimation?.cancel();
    if (this.preview) closeDialog(this.preview, { animate: false, restoreFocus: false }); if (this.overlay) closeDialog(this.overlay, { animate: false, restoreFocus: false });
    this.observer.disconnect(); this.autoPage.disconnect(); this.request?.abort(); for (const tile of this.tiles.keys()) this.unload(tile);
    this.tiles.clear(); this.mediaCache.clear(); this.mediaCacheBytes = 0; this.favorites = []; this.packs = []; this.input.value = ''; this.panel.remove(); this.options.host.classList.remove('has-meme-panel');
  }
}
