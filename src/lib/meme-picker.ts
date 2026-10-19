import { layoutViewport } from './form-input';
import { motion, retargetMotion } from './motion';
import { emojiGroups } from './emoji-catalog';
import { avatarEmoji, bindSpaceAvatarPlayback } from './space-avatar';
import { mountDialog, closeDialog } from './dialog';
import { cancelComposerPanel, moveComposerPanel, panelVelocity } from './composer-panel-motion';
import { validateMemeFile, type MemeFavorite } from './meme-media';
import { detectImageAnimation } from './image-animation';
import { MAX_PACK_BYTES, type MediaKind, type MediaItem, type MediaSearchResult, type RemotePack, type RemotePackDetail, type StickerPack } from './sticker-library';
import { createElement, Smile, Star, Search, Keyboard, ChevronDown, Image, X, Trash2, Send } from 'lucide';

export const memeIcons = {
  smile: createElement(Smile).outerHTML, star: createElement(Star).outerHTML,
  search: createElement(Search).outerHTML, keyboard: createElement(Keyboard).outerHTML,
  down: createElement(ChevronDown).outerHTML, image: createElement(Image).outerHTML,
  add: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M14 3v4a2 2 0 0 0 2 2h4"/><path d="M8.5 13.5h7"/><path d="M12 10v7"/></svg>',
};
type PickerKind = MediaKind | 'emoji';
type PickerItem = MediaItem & { localAsset?: string };
const unicodeEmoji = emojiGroups.flatMap(group => group.items.map(item => ({ item, group: group.name })));
const MAX_MEME_CACHE_BYTES = 16 * 1024 * 1024;
const MEME_CATALOG_CACHE_MS = 5 * 60 * 1000;
const MAX_MEME_SEARCH_CACHE_ENTRIES = 32;

export type MemePickerCache = {
  media: Map<string, File>;
  mediaBytes: number;
  searches: Map<string, { result: MediaSearchResult; expiresAt: number }>;
  packs: Map<string, { result: RemotePackDetail; expiresAt: number }>;
  usage: Map<string, number>;
  // Unlocked-session navigation only; no search text or media URLs.
  view?: { kind: PickerKind; favorite: boolean; positions: Map<string, number>; shortcutLeft: number; emojiGroup?: number };

};

export const createMemePickerCache = (): MemePickerCache => {
  const usage = new Map<string, number>();
  try {
    const raw = JSON.parse(localStorage.getItem('quiet-room-expression-usage-v1') || '{}') as Record<string, unknown>;
    for (const [id, count] of Object.entries(raw)) if (/^[0-9a-f-]{36}$/.test(id) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0) usage.set(id, Math.min(count, 1000));
  } catch { /* Private browsing or malformed local state falls back to memory. */ }
  return {
  media: new Map(),
  mediaBytes: 0,
  searches: new Map(),
  packs: new Map(),
    usage,
  };
};

export type MemePickerOptions = {
  host: HTMLElement; root: HTMLElement; signal: AbortSignal; isActive: () => boolean;
  list: () => Promise<MemeFavorite[]>; file: (item: MemeFavorite, signal: AbortSignal) => Promise<File>;
  save: (file: File, signal: AbortSignal) => Promise<boolean>; remove: (id: string, signal: AbortSignal) => Promise<void>;
  packs: () => Promise<StickerPack[]>;
  install: (id: string, title: string, files: File[], signal: AbortSignal, autoHide?: boolean) => Promise<void>;
  removePack: (id: string, signal: AbortSignal) => Promise<void>;
  reorderPacks: (ids: string[], signal: AbortSignal) => Promise<void>;
  pack: (id: string, signal: AbortSignal) => Promise<RemotePackDetail>;
  send: (file: File, autoHide: boolean, signal: AbortSignal, kind?: MediaKind) => Promise<void>;
  insertEmoji?: (emoji: string) => void;
  search: (query: string, page: number, signal: AbortSignal, kind: MediaKind) => Promise<MediaSearchResult>;
  media: (id: string, signal: AbortSignal) => Promise<Blob>;
  cache?: MemePickerCache;
  close: (keyboard: boolean) => void;
  layoutChanged?: () => void;
  previousRowTop?: number;
  occupiedHeight?: () => number | undefined;
  presentationOwned?: () => boolean;
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
  private more: HTMLButtonElement;
  private observer: IntersectionObserver;
  private tiles = new Map<HTMLElement, Tile>();
  private cache: MemePickerCache;
  private persistentCachePromise?: Promise<Cache | null>;
  private favorites: MemeFavorite[] = [];
  private packs: StickerPack[] = [];
  private kind: PickerKind = 'emoji';
  private emojiPlayback: AbortController | null = null;
  private emojiGroup = 0;
  private emojiOffset = 0;
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
  private autoPage: IntersectionObserver;
  private sentinel = document.createElement('div');
  private sheetAnimation?: Animation;
  private rowAnimation?: Animation;
  private halfHeight = 0;
  private suppressShortcutClickUntil = 0;
  private closing = false;
  private recentGrid: HTMLElement | null = null;
  private browseGrid: HTMLElement | null = null;
  private catalogItems = new Map<string, MediaItem>();
  private catalogTiles = new Map<string, HTMLElement>();
  private localReady = false;
  private restoringPosition = false;

  constructor(private options: MemePickerOptions) {
    this.cache = options.cache ?? createMemePickerCache();
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
    this.panel.className = 'meme-panel'; this.panel.id = 'meme-panel';
    this.panel.setAttribute('role', 'region'); this.panel.setAttribute('aria-label', '表情');
    this.panel.innerHTML = `
      <div class="meme-toolbar"><div class="meme-pack-shortcuts" aria-label="表情入口"></div></div>
      <header class="meme-search-header" hidden><h2>添加贴纸</h2></header>
      <div class="meme-scroll"><div class="meme-grid"></div><p class="meme-status" role="status"></p><button type="button" class="meme-more" hidden>加载更多</button><p class="meme-source"></p></div><footer class="page-back-footer meme-page-back" hidden><button type="button" class="meme-back page-back-button" aria-label="返回表情面板">返回</button></footer>`;
    this.grid = this.panel.querySelector('.meme-grid')!; this.status = this.panel.querySelector('.meme-status')!;
    this.more = this.panel.querySelector('.meme-more')!;
    this.panel.querySelector('.meme-back')!.addEventListener('click', () => this.back());
    this.panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.overlay) { event.preventDefault(); options.close(false); } });
    this.more.addEventListener('click', () => void this.search());
    this.sentinel.className = 'meme-page-sentinel';
    this.more.before(this.sentinel);
    this.autoPage = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && (this.more.hidden || this.kind === 'emoji')) void this.search();
    }, { root: this.panel.querySelector('.meme-scroll'), rootMargin: '120px' });
    this.autoPage.observe(this.sentinel);
    const shortcuts = this.panel.querySelector<HTMLElement>('.meme-pack-shortcuts')!;
    type SheetDrag = { id: number; x: number; y: number; height: number; full: boolean; moving: boolean; scrolling: boolean; scrollLeft: number; maxScrollLeft: number; fromPack: boolean; lastX: number; lastAt: number; velocity: number; overshoot: number; position: number; frame: number | null };
    type ShortcutHold = { id: number; x: number; y: number; button: HTMLButtonElement; timer: number };
    type ShortcutReorder = {
      id: number; button: HTMLButtonElement; floating: HTMLButtonElement; placeholder: HTMLElement | null; left: number; right: number;
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
      shortcuts.style.removeProperty('translate');
      shortcuts.style.removeProperty('will-change');
    };
    const renderShortcutPull = (offset: number) => {
      shortcuts.style.translate = `${offset.toFixed(2)}px 0`;
      shortcuts.style.willChange = 'translate';
    };
    const rubberBand = (offset: number) => offset === 0 ? 0
      : Math.sign(offset) * (Math.abs(offset) * 0.34 + Math.min(18, Math.abs(offset) * 0.04));
    const stopShortcutAnimation = () => {
      if (shortcutAnimation !== null) cancelAnimationFrame(shortcutAnimation);
      shortcutAnimation = null;
    };
    const flushShortcutScroll = (state: SheetDrag) => {
      if (state.frame !== null) {
        cancelAnimationFrame(state.frame);
        state.frame = null;
      }
      const clamped = Math.max(0, Math.min(state.maxScrollLeft, state.position));
      state.overshoot = rubberBand(state.position - clamped);
      shortcuts.scrollLeft = clamped;
      renderShortcutPull(state.overshoot);
    };
    const scheduleShortcutScroll = (state: SheetDrag) => {
      if (state.frame !== null) return;
      state.frame = requestAnimationFrame(() => {
        state.frame = null;
        if (drag !== state || !state.scrolling) return;
        flushShortcutScroll(state);
      });
    };
    const releaseShortcut = (velocity: number, overshoot: number, maxScrollLeft: number) => {
      stopShortcutAnimation();
      let currentVelocity = Math.abs(overshoot) > 0.25 || maxScrollLeft <= 0
        ? 0
        : Math.max(-2.2, Math.min(2.2, velocity));
      let pull = overshoot;
      let lastAt = performance.now();
      if ((shortcuts.scrollLeft <= 0.5 && currentVelocity < 0)
        || (shortcuts.scrollLeft >= maxScrollLeft - 0.5 && currentVelocity > 0)) currentVelocity = 0;
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
            if (next <= 0) {
              shortcuts.scrollLeft = 0;
              currentVelocity = 0;
            } else if (next >= maxScrollLeft) {
              shortcuts.scrollLeft = maxScrollLeft;
              currentVelocity = 0;
            } else shortcuts.scrollLeft = next;
            currentVelocity *= Math.pow(0.055, elapsed / 1000);
          } else currentVelocity = 0;
        }
        if (Math.abs(pull) > 0.25 || Math.abs(currentVelocity) > 0.015) shortcutAnimation = requestAnimationFrame(tick);
        else { clearShortcutPull(); shortcutAnimation = null; }
      };
      shortcutAnimation = requestAnimationFrame(tick);
    };
    const positionMotions = new WeakMap<HTMLElement, Animation>();
    const capturePositions = () => new Map([...shortcuts.querySelectorAll<HTMLElement>('button[data-shortcut]')].map(node => [node, node.getBoundingClientRect()]));
    const animatePositions = (before: Map<HTMLElement, DOMRect>) => {
      if (reducedMotion()) return;
      for (const node of before.keys()) positionMotions.get(node)?.cancel();
      const ends = new Map([...before.keys()].map(node => [node, node.getBoundingClientRect()]));
      for (const [node, start] of before) {
        if (!node.isConnected) continue;
        const end = ends.get(node)!;
        const x = start.left - end.left; const y = start.top - end.top;
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
        const animation = retargetMotion(node, null, { transform: `translate3d(${x}px, ${y}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' }, motion.local, motion.settle);
        if (animation) positionMotions.set(node, animation);
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
        originalIds: buttons.map(packId), originalPacks: [...this.packs], left: shortcuts.getBoundingClientRect().left, right: shortcuts.getBoundingClientRect().right,
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
        if (changed) saveOrder(remainingIds, state.originalPacks, state.button.getAttribute('aria-label')?.split('，')[0] ?? '');
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
        full: Boolean(this.overlay), moving: false, scrolling: false, scrollLeft: shortcuts.scrollLeft, maxScrollLeft: shortcutMax(), fromPack: Boolean(button),
        lastX: event.clientX, lastAt: performance.now(), velocity: 0, overshoot: 0, position: shortcuts.scrollLeft, frame: null };
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
        if (event.clientX < reorder.left + 32) shortcuts.scrollLeft -= 12;
        else if (event.clientX > reorder.right - 32) shortcuts.scrollLeft += 12;
        const remaining = packButtons();
        const targetIndex = remaining.findIndex(button => event.clientX < button.getBoundingClientRect().left + button.getBoundingClientRect().width / 2);
        placePlaceholder(targetIndex < 0 ? remaining.length : targetIndex);
        return;
      }
      if (!drag || drag.id !== event.pointerId) return;
      const now = performance.now();
      const dy = event.clientY - drag.y; const dx = event.clientX - drag.x;
      if (hold && Math.hypot(dx, dy) > 10) cancelHold();
      if (!drag.moving && (drag.scrolling || Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy))) {
        drag.scrolling = true;
        event.preventDefault();
        // Keep the scroll position incremental. Using the initial pointer
        // delta makes a bar stick at the edge until the finger crosses its
        // starting point, so reversing direction appears to push it back.
        const deltaX = event.clientX - drag.lastX;
        // A reverse gesture must leave an overscrolled edge immediately. If
        // the finger changes direction while the position is beyond an edge,
        // applying the delta to the overshoot first makes the bar appear to
        // snap back in the old direction.
        if ((drag.position > drag.maxScrollLeft && deltaX > 0)
          || (drag.position < 0 && deltaX < 0)) drag.position = deltaX > 0 ? drag.maxScrollLeft : 0;
        drag.position -= deltaX;
        const elapsed = Math.max(1, now - drag.lastAt);
        drag.velocity = deltaX / elapsed * -1;
        drag.lastX = event.clientX; drag.lastAt = now;
        scheduleShortcutScroll(drag);
        return;
      }
      if (Math.abs(dy) >= 8 && Math.abs(dy) > Math.abs(dx) * 1.5) {
        cancelHold(); drag = undefined;
      }
    }, { signal: this.signal, passive: false });
    const finishDrag = (event: PointerEvent) => {
      if (finishReorder(event)) { cancelHold(); drag = undefined; return; }
      cancelHold();
      if (!drag || drag.id !== event.pointerId) return;
      const start = drag; drag = undefined;
      if (start.scrolling) {
        this.suppressShortcutClickUntil = performance.now() + 500;
        flushShortcutScroll(start);
        releaseShortcut(start.velocity, start.overshoot, start.maxScrollLeft);
        return;
      }
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
      saveOrder(ids, previousPacks, button.getAttribute('aria-label')?.split('，')[0] ?? '');
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
    const syncHeight = () => {
      const height = options.occupiedHeight?.();
      if (height && Number.isFinite(height)) options.host.style.setProperty('--meme-sheet-height', `${height}px`);
    };
    syncHeight();
    const row = options.host.querySelector<HTMLElement>('.composer-row');
    const rowTop = options.previousRowTop ?? row?.getBoundingClientRect().top;
    const rowSpeed = row ? panelVelocity(row) : 0;
    if (row) cancelComposerPanel(row);
    options.host.classList.add('has-meme-panel'); options.host.append(this.panel);
    options.layoutChanged?.();
    const panelTop = this.panel.getBoundingClientRect().top;
    if (!options.presentationOwned?.()) {
      this.animateSheet(row && rowTop !== undefined ? rowTop + row.getBoundingClientRect().height + 8 - panelTop : this.panel.getBoundingClientRect().height, 0, 'translate');
      if (row && rowTop !== undefined) this.rowAnimation = moveComposerPanel(row, rowTop - row.getBoundingClientRect().top, 0, this.signal, () => {}, true, rowSpeed);
    }
    const sync = () => {
      syncHeight();
      const view = layoutViewport();
      this.panel.style.setProperty('--meme-height', `${view?.height ?? innerHeight}px`);
      this.overlay?.style.setProperty('--meme-top', `${view?.offsetTop ?? 0}px`);
      this.overlay?.style.setProperty('--meme-height', `${view?.height ?? innerHeight}px`);
    };
    layoutViewport()?.addEventListener('resize', sync, { signal: this.signal });
    layoutViewport()?.addEventListener('scroll', sync, { signal: this.signal });
    window.addEventListener('resize', sync, { signal: this.signal }); sync();
    document.addEventListener('pointerdown', event => {
      if (!this.overlay && !this.preview && !options.host.contains(event.target as Node)) options.close(false);
    }, { signal: this.signal });
    this.signal.addEventListener('abort', () => this.dispose(), { once: true });
    this.panel.querySelector('.meme-scroll')!.addEventListener('scroll', () => this.rememberView(), { passive: true, signal: this.signal });
    this.panel.querySelector('.meme-pack-shortcuts')!.addEventListener('scroll', () => this.rememberView(), { passive: true, signal: this.signal });
    const view = this.cache.view;
    this.emojiGroup = view?.emojiGroup ?? 0;
    void this.switchKind(view?.kind === 'stickers' ? 'stickers' : 'emoji', view?.favorite ?? false);
  }
  private active() { return !this.disposed && !this.signal.aborted && this.options.isActive() && this.panel.isConnected; }
  get isClosing() { return this.closing; }
  private animateSheet(from: number, to: number, property: 'height' | 'translate', finish = () => {}, previousTop?: number) {
    const top = previousTop ?? this.panel.getBoundingClientRect().top;
    const velocity = panelVelocity(this.panel);
    this.sheetAnimation?.cancel(); this.sheetAnimation = undefined;
    if (property === 'height') {
      this.panel.style.height = `${to}px`;
      from = top - this.panel.getBoundingClientRect().top; to = 0;
    }
    const animation = moveComposerPanel(this.panel, from, to, this.signal, () => {
      this.sheetAnimation = undefined;
      if (this.active()) finish();
    }, true, velocity);
    this.sheetAnimation = animation;
  }
  reopen() {
    if (!this.closing || !this.active()) return;
    const opacity = getComputedStyle(this.panel).opacity;
    const top = this.panel.getBoundingClientRect().top, speed = panelVelocity(this.panel);
    const row = this.options.host.querySelector<HTMLElement>('.composer-row');
    const rowTop = row?.getBoundingClientRect().top, rowSpeed = row ? panelVelocity(row) : 0;
    this.sheetAnimation?.cancel(); this.rowAnimation?.cancel();
    this.closing = false; this.panel.inert = false; this.panel.removeAttribute('aria-hidden');
    for (const property of ['position', 'inset', 'left', 'top', 'width', 'height', 'z-index', 'translate']) this.panel.style.removeProperty(property);
    this.options.host.append(this.panel);
    delete this.options.host.dataset.expressionHandoff;
    this.options.host.classList.add('has-meme-panel'); this.options.layoutChanged?.();
    if (!this.options.presentationOwned?.()) {
      this.sheetAnimation = moveComposerPanel(this.panel, top - this.panel.getBoundingClientRect().top, 0, this.signal,
        () => { this.sheetAnimation = undefined; }, true, speed);
      if (row && rowTop !== undefined) this.rowAnimation = moveComposerPanel(row, rowTop - row.getBoundingClientRect().top, 0, this.signal, () => {}, true, rowSpeed);
    } else if (Number(opacity) < 1) {
      this.sheetAnimation = this.panel.animate([{ opacity }, { opacity: 1 }], { duration: 240, fill: 'backwards' });
    }
  }
  close(finish: () => void, fade = false) {
    if (this.closing) return;
    this.rememberView();
    this.closing = true; this.panel.inert = true; this.panel.setAttribute('aria-hidden', 'true');
    const bounds = this.panel.getBoundingClientRect();
    const translate = new DOMMatrixReadOnly(getComputedStyle(this.panel).transform).m42;
    const speed = panelVelocity(this.panel);
    const row = this.options.host.querySelector<HTMLElement>('.composer-row');
    const rowTop = row?.getBoundingClientRect().top;
    this.panel.style.height = `${bounds.height}px`;
    // Retiring pixels must not inherit the composer's keyboard transform.
    // Preserve their screen position in the chat plane until they leave.
    const shell = this.options.host.closest<HTMLElement>('.chat-shell');
    if (shell && this.panel.parentElement === this.options.host) {
      this.sheetAnimation?.cancel();
      const origin = shell.getBoundingClientRect();
      shell.append(this.panel);
      this.panel.style.position = 'absolute'; this.panel.style.inset = 'auto';
      this.panel.style.zIndex = '5';
      this.panel.style.left = `${bounds.left - origin.left}px`;
      this.panel.style.top = `${bounds.top - origin.top}px`;
      this.panel.style.width = `${bounds.width}px`;
      this.panel.style.removeProperty('translate');
    }
    // Commit final occupancy once. The row and panel then travel together
    // with transforms, instead of moving the row only after panel disposal.
    this.options.host.classList.remove('has-meme-panel');
    this.options.layoutChanged?.();
    if (!fade && row && rowTop !== undefined) {
      const delta = rowTop - row.getBoundingClientRect().top;
      this.rowAnimation = moveComposerPanel(row, delta, 0, this.signal);
    }
    const bottom = Math.max(document.documentElement.clientHeight, layoutViewport()?.height ?? innerHeight);
    if (fade) {
      const opacity = getComputedStyle(this.panel).opacity;
      this.sheetAnimation?.cancel();
      const animation = this.panel.animate([{ opacity }, { opacity: 0 }], { duration: 360, fill: 'both' });
      this.sheetAnimation = animation;
      this.signal.addEventListener('abort', () => animation.cancel(), { once: true });
      void animation.finished.then(() => { this.sheetAnimation = undefined; if (this.active()) finish(); }, () => {});
      if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) animation.finish();
    } else if (shell && this.panel.parentElement === shell) {
      this.sheetAnimation = moveComposerPanel(this.panel, 0, Math.max(0, bottom - bounds.top), this.signal, () => {
        this.sheetAnimation = undefined; if (this.active()) finish();
      }, true, speed);
    } else this.animateSheet(translate, translate + bottom - bounds.top, 'translate', finish);
  }
  private hasPack(id: string) { return this.packs.some(pack => pack.id === id); }
  private say(value: string) { if (this.active()) this.status.textContent = value; }
  private searchCacheKey(query: string, page: number, kind: MediaKind): string {
    return `${kind}\u0000${query}\u0000${page}`;
  }
  private cachedSearch(key: string): MediaSearchResult | undefined {
    const entry = this.cache.searches.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.searches.delete(key);
      return undefined;
    }
    this.cache.searches.delete(key);
    this.cache.searches.set(key, entry);
    return entry.result;
  }
  private rememberSearch(key: string, result: MediaSearchResult): void {
    this.cache.searches.delete(key);
    this.cache.searches.set(key, { result, expiresAt: Date.now() + MEME_CATALOG_CACHE_MS });
    while (this.cache.searches.size > MAX_MEME_SEARCH_CACHE_ENTRIES) {
      const oldest = this.cache.searches.keys().next().value;
      if (oldest === undefined) break;
      this.cache.searches.delete(oldest);
    }
  }
  private async loadPack(id: string, signal: AbortSignal): Promise<RemotePackDetail> {
    const cached = this.cache.packs.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.packs.delete(id);
      this.cache.packs.set(id, cached);
      return cached.result;
    }
    if (cached) this.cache.packs.delete(id);
    const result = await this.options.pack(id, signal);
    signal.throwIfAborted();
    this.cache.packs.set(id, { result, expiresAt: Date.now() + MEME_CATALOG_CACHE_MS });
    return result;
  }
  private rememberMedia(id: string, file: File): void {
    if (file.size > MAX_MEME_CACHE_BYTES) return;
    const previous = this.cache.media.get(id);
    if (previous) {
      this.cache.media.delete(id);
      this.cache.mediaBytes -= previous.size;
    }
    while (this.cache.mediaBytes + file.size > MAX_MEME_CACHE_BYTES && this.cache.media.size) {
      const oldest = this.cache.media.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.cache.media.get(oldest);
      this.cache.media.delete(oldest);
      if (evicted) this.cache.mediaBytes -= evicted.size;
    }
    this.cache.media.set(id, file);
    this.cache.mediaBytes += file.size;
  }
  private recordUsage(id: string): void {
    const count = Math.min(1000, (this.cache.usage.get(id) ?? 0) + 1);
    this.cache.usage.set(id, count);
    try {
      const rows = [...this.cache.usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100);
      localStorage.setItem('quiet-room-expression-usage-v1', JSON.stringify(Object.fromEntries(rows)));
    } catch { /* Usage ranking remains available for the current runtime. */ }
  }
  private forgetMedia(id: string): void {
    const file = this.cache.media.get(id);
    if (!file) return;
    this.cache.media.delete(id);
    this.cache.mediaBytes = Math.max(0, this.cache.mediaBytes - file.size);
  }
  private async persistentCache(): Promise<Cache | null> {
    if (typeof caches === 'undefined') return null;
    this.persistentCachePromise ??= caches.open('quiet-room-expression-media-v1').catch(() => null);
    return this.persistentCachePromise;
  }
  private async readPersistentMedia(item: MediaItem, signal: AbortSignal): Promise<File | null> {
    if (item.favorite) return null;
    const cache = await this.persistentCache(); if (!cache) return null;
    signal.throwIfAborted();
    const response = await cache.match(`/__quiet-room-expression/${encodeURIComponent(item.id)}`);
    if (!response) return null;
    const blob = await response.blob();
    try { return await validateMemeFile(blob, item.title, signal); } catch { await cache.delete(response.url); return null; }
  }
  private async writePersistentMedia(item: MediaItem, file: File): Promise<void> {
    if (item.favorite) return;
    const cache = await this.persistentCache(); if (!cache) return;
    try {
      await cache.put(`/__quiet-room-expression/${encodeURIComponent(item.id)}`, new Response(file, { headers: { 'Content-Type': file.type } }));
    } catch { /* Cache storage is an optional acceleration; memory remains authoritative. */ }
  }
  private clear() {
    this.localReady = false;
    this.emojiPlayback?.abort(); this.emojiPlayback = null;
    this.generation++; this.request?.abort(); this.operation?.abort(); this.searching = false; this.observer.disconnect();
    for (const tile of this.tiles.keys()) if (!tile.closest('.meme-pack-shortcuts')) { this.unload(tile); this.tiles.delete(tile); }
    this.grid.replaceChildren(); this.status.replaceChildren(); this.more.hidden = true; this.nextPage = null;
    this.grid.className = 'meme-grid'; this.panel.querySelector('.meme-scroll')!.scrollTop = 0;
    this.recentGrid = null; this.browseGrid = null; this.catalogItems.clear(); this.catalogTiles.clear();
    this.panel.querySelector('.meme-source')!.textContent = '';
  }
  private rememberView() {
    if (!this.localReady || this.restoringPosition || this.panel.dataset.view !== 'local') return;
    const view = this.cache.view ?? { kind: this.kind, favorite: this.favoriteView, positions: new Map<string, number>(), shortcutLeft: 0 };
    view.kind = this.kind; view.favorite = this.favoriteView; view.emojiGroup = this.emojiGroup;
    view.positions.set(`${this.kind}:${this.favoriteView}${this.kind === 'emoji' ? `:${this.emojiGroup}` : ''}`, this.panel.querySelector('.meme-scroll')!.scrollTop);
    view.shortcutLeft = this.panel.querySelector('.meme-pack-shortcuts')!.scrollLeft;
    this.cache.view = view;
  }
  private async restoreView() {
    if (!this.active() || this.panel.dataset.view !== 'local') return;
    const generation = this.generation;
    const view = this.cache.view;
    const top = view?.positions.get(`${this.kind}:${this.favoriteView}${this.kind === 'emoji' ? `:${this.emojiGroup}` : ''}`) ?? 0;
    this.restoringPosition = true;
    const scroll = this.panel.querySelector('.meme-scroll')!;
    // Only refill enough cached catalog pages for the old position, bounded
    // to avoid unbounded acquisition when a catalog was removed or reshaped.
    for (let page = 0; page < 8 && scroll.scrollHeight - scroll.clientHeight < top && this.nextPage && !this.favoriteView; page++) {
      const next = this.nextPage;
      await this.search();
      if (!this.active() || generation !== this.generation) return;
      if (next === this.nextPage) break;
    }
    if (!this.active() || generation !== this.generation) return;
    scroll.scrollTop = top;
    this.panel.querySelector('.meme-pack-shortcuts')!.scrollLeft = view?.shortcutLeft ?? 0;
    this.restoringPosition = false;
    this.localReady = true;
    this.rememberView();
  }
  private async switchKind(kind: PickerKind, favorite = false) {
    this.rememberView();
    this.kind = kind === 'gifs' ? 'emoji' : kind; this.favoriteView = favorite; this.panel.dataset.kind = this.kind;
    await this.local();
  }
  private shortcuts() {
    const bar = this.panel.querySelector('.meme-pack-shortcuts')!;
    bar.setAttribute('aria-label', '表情入口');
    const control = (key: string, label: string, icon: string, action: () => void) => {
      const existing = [...bar.querySelectorAll<HTMLButtonElement>('button')].find(node => node.dataset.shortcut === key);
      if (existing) { existing.title = label; existing.setAttribute('aria-label', label); return existing; }
      const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = icon;
      button.dataset.shortcut = key;
      button.addEventListener('click', action); bar.append(button); return button;
    };
    control('add', '添加贴纸', memeIcons.add, () => { void this.switchKind('stickers').then(() => this.openSearch()); });
    control('emoji', 'Emoji', memeIcons.smile, () => { void this.switchKind('emoji'); }).setAttribute('aria-pressed', String(this.kind === 'emoji' && !this.favoriteView));
    control('favorites', '收藏表情', memeIcons.star, () => { void this.switchKind('stickers', true); }).setAttribute('aria-pressed', String(this.favoriteView));
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
      const item: MediaItem = { id: first.id, title: pack.title, favorite: first, pack: pack.id, autoHide: pack.autoHide };
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
    this.restoringPosition = false;
    this.clear(); this.panel.dataset.view = 'local'; const generation = this.generation;
    const immediateEmoji = this.kind === 'emoji' && !this.favoriteView;
    if (immediateEmoji) { this.shortcuts(); this.query = ''; this.emojiOffset = 0; this.renderEmoji(); }
    try {
      const [favorites, packs] = await Promise.all([this.options.list(), this.options.packs()]);
      if (!this.active() || generation !== this.generation) return;
      this.favorites = favorites; this.packs = packs;
      if (immediateEmoji) { this.shortcuts(); await this.restoreView(); return; }
      this.clear(); this.shortcuts();
      this.renderLocalItems();
      const localGeneration = this.generation;
      if (!this.favoriteView && this.kind === 'gifs') {
        this.query = ''; this.nextPage = 1;
        await this.search(); if (!this.active() || this.generation !== localGeneration) return;
        const seen = new Set([1]);
        while (this.nextPage && !seen.has(this.nextPage)) {
          const cached = this.cachedSearch(this.searchCacheKey('', this.nextPage, 'gifs'));
          if (!cached) break;
          seen.add(this.nextPage); this.appendCatalog(cached.items); this.nextPage = cached.nextPage;
        }
        this.more.hidden = !this.nextPage;
      }
      await this.restoreView();
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
        this.append(pack.items.map(item => ({ id: item.id, title: item.name, favorite: item, pack: pack.id, autoHide: pack.autoHide })), grid);
      }
    }
  }
  private openSearch(load = true, animate = true) {
    if (!this.active() || this.overlay) return;
    const height = this.panel.getBoundingClientRect().height;
    const top = this.panel.getBoundingClientRect().top;
    this.halfHeight = height;
    const overlay = document.createElement('div'); overlay.className = 'meme-search-dialog'; overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', '添加贴纸');
    this.overlay = overlay; this.options.root.append(overlay); overlay.append(this.panel);
    const view = layoutViewport(); overlay.style.setProperty('--meme-height', `${view?.height ?? innerHeight}px`); overlay.style.setProperty('--meme-top', `${view?.offsetTop ?? 0}px`);
    this.panel.dataset.view = 'search'; (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = false;
    (this.panel.querySelector('.meme-page-back') as HTMLElement).hidden = false;
    mountDialog(overlay, { signal: this.signal, isActive: () => this.active(), initialFocus: this.panel.querySelector<HTMLElement>('.meme-back'), returnFocus: this.options.host.querySelector<HTMLElement>('#open-memes'),
      beforeClose: () => { this.back(); return false; } });
    if (animate) {
      this.panel.style.top = 'auto';
      this.animateSheet(height, overlay.getBoundingClientRect().height, 'height', () => this.panel.style.removeProperty('top'), top);
    }
    if (load) { this.shortcuts(); void this.submit(); }
  }
  private back(preserve = false, animate = true) {
    if (!this.overlay || this.closing) return;
    if (this.packDetail) { void this.submit(); return; }
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
    const overlay = this.overlay; this.overlay = null;
    this.options.host.append(this.panel); this.panel.dataset.view = 'local';
    (this.panel.querySelector('.meme-search-header') as HTMLElement).hidden = true;
    (this.panel.querySelector('.meme-page-back') as HTMLElement).hidden = true;
    closeDialog(overlay, { animate: false, restoreFocus: false });
    if (!preserve) void this.local();
    this.panel.querySelector<HTMLButtonElement>('[data-shortcut="add"]')?.focus({ preventScroll: true });
  }
  private async submit() {
    this.packDetail = false; this.query = ''; this.clear(); this.panel.dataset.view = 'search'; this.nextPage = 1; this.emojiOffset = 0; await this.search();
  }
  private async search() {
    if (!this.active() || this.searching || !this.nextPage) return;
    if (this.kind === 'emoji') { this.renderEmoji(); return; }
    const page = this.nextPage;
    this.request = new AbortController(); const signal = AbortSignal.any([this.signal, this.request.signal]); const generation = this.generation;
    this.searching = true; this.more.hidden = true; this.say('正在加载贴纸…');
    try {
      const key = this.searchCacheKey(this.query, page, this.kind);
      const cached = this.cachedSearch(key);
      const result = cached ?? await this.options.search(this.query, page, signal, this.kind);
      if (!cached) {
        signal.throwIfAborted();
        this.rememberSearch(key, result);
      }
      if (!this.active() || generation !== this.generation) return;
      if (this.kind === 'gifs') {
        if (!this.query && this.panel.dataset.view === 'local') this.appendCatalog(result.items);
        else this.append(result.items);
      } else this.appendPacks(result.packs ?? []);
      this.nextPage = result.nextPage; this.more.textContent = '加载更多';
      this.more.hidden = !this.nextPage;
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
  private renderEmoji() {
    this.grid.className = 'meme-grid emoji-sections';
    if (this.emojiOffset === 0) {
      const title = document.createElement('h3'); title.textContent = 'Fluent';
      const fluent = document.createElement('div'); fluent.className = 'emoji-grid fluent-emoji-grid';
      for (const item of avatarEmoji) {
        const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'emoji-tile fluent-emoji-tile';
        tile.setAttribute('aria-label', `发送 ${item.label}`);
        const img = document.createElement('img'); img.alt = ''; img.draggable = false; img.dataset.avatarEmoji = item.id;
        // 128px originals must not be stretched beyond physical pixel density.
        img.style.maxWidth = `${128 / Math.max(1, devicePixelRatio)}px`;
        img.loading = 'lazy'; img.decoding = 'async'; img.src = `/space-avatars/${item.id}-still.webp`; tile.append(img); fluent.append(tile);
        tile.addEventListener('pointerdown', event => event.preventDefault());
        tile.addEventListener('click', () => void this.perform({ id:item.id, title:item.label, localAsset:`/space-avatars/${item.id}.webp` }, 'send'));
      }
      this.grid.append(title, fluent);
      this.emojiPlayback = new AbortController();
      bindSpaceAvatarPlayback(fluent, AbortSignal.any([this.signal, this.emojiPlayback.signal]));
    }
    const items = unicodeEmoji;
    for (const {item:[emoji,name],group} of items.slice(this.emojiOffset, this.emojiOffset + 84)) {
      let grid = this.grid.lastElementChild as HTMLElement;
      if (grid.dataset.emojiGroup !== group) {
        const title = document.createElement('h3'); title.textContent = group;
        grid = document.createElement('div'); grid.className = 'emoji-grid'; grid.dataset.emojiGroup = group; this.grid.append(title,grid);
      }
      const button = document.createElement('button'); button.type = 'button'; button.className = 'emoji-tile'; button.textContent = emoji!; button.title = name!; button.setAttribute('aria-label', name!);
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => { if (this.active()) this.options.insertEmoji?.(emoji!); }); grid.append(button);
    }
    this.emojiOffset += 84; this.nextPage = this.emojiOffset < items.length ? 1 : null;
    this.more.textContent = '加载更多'; this.more.hidden = !this.nextPage;
  }
  private appendCatalog(items: MediaItem[]) {
    if (!this.recentGrid || !this.browseGrid) {
      this.grid.classList.add('meme-catalog-sections');
      const recent = document.createElement('section'); recent.className = 'meme-recent-section'; recent.setAttribute('aria-labelledby', 'meme-recent-title');
      recent.innerHTML = '<h3 id="meme-recent-title">推荐 GIFs</h3><div class="meme-recent-grid"></div>';
      const browse = document.createElement('section'); browse.className = 'meme-browse-section'; browse.setAttribute('aria-labelledby', 'meme-browse-title'); browse.hidden = true;
      browse.innerHTML = '<h3 id="meme-browse-title">更多 GIFs</h3><div class="meme-browse-grid"></div>';
      this.grid.append(recent, browse);
      this.recentGrid = recent.querySelector('.meme-recent-grid');
      this.browseGrid = browse.querySelector('.meme-browse-grid');
    }
    for (const item of items) {
      if (this.catalogItems.has(item.id)) continue;
      this.catalogItems.set(item.id, item);
      this.append([item], this.browseGrid!);
      this.catalogTiles.set(item.id, this.browseGrid!.lastElementChild as HTMLElement);
    }
    const loaded = [...this.catalogItems.values()];
    const used = loaded.filter(item => (this.cache.usage.get(item.id) ?? 0) > 0)
      .sort((a, b) => (this.cache.usage.get(b.id) ?? 0) - (this.cache.usage.get(a.id) ?? 0));
    const featured = (used.length ? used : loaded).slice(0, 10);
    const ids = new Set(featured.map(item => item.id));
    this.panel.querySelector('#meme-recent-title')!.textContent = used.length ? '常用 GIFs' : '推荐 GIFs';
    for (const item of featured) this.recentGrid!.append(this.catalogTiles.get(item.id)!);
    for (const item of loaded.filter(item => !ids.has(item.id))) this.browseGrid!.append(this.catalogTiles.get(item.id)!);
    this.browseGrid!.closest<HTMLElement>('.meme-browse-section')!.hidden = loaded.length === featured.length;
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
      const detail = await this.loadPack(pack.id, this.signal); if (!this.active() || generation !== this.generation) return;
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
      detail ??= await this.loadPack(pack.id, signal); const files: File[] = []; let bytes = 0;
      for (const item of detail.items) {
        const file = await this.getFile(item, signal); bytes += file.size; if (bytes > MAX_PACK_BYTES) throw new Error('合集超过 64 MiB');
        files.push(file); if (progress.isConnected) progress.textContent = `${files.length} / ${detail.items.length}`;
      }
      await this.options.install(pack.id, detail.title, files, signal, Boolean(detail.autoHide ?? pack.autoHide)); if (!this.active()) return;
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
      // Decoding large animated GIFs in parallel can saturate mobile CPUs and
      // make the panel feel hot. Two visible decodes keep scrolling responsive.
      if (this.loading >= 2) break; if (!state.visible || state.url || state.controller) continue;
      const controller = new AbortController(); state.controller = controller; this.loading++; const signal = AbortSignal.any([controller.signal, this.signal]);
      void this.getFile(state.item, signal).then(file => { if (!this.active() || signal.aborted || !state.visible) return; state.url = URL.createObjectURL(file); state.file = file; tile.querySelector('img')!.src = state.url; tile.classList.remove('is-error'); })
        .catch(error => {
          if (signal.aborted) return;
          if (error instanceof Error && error.message === 'NON_ANIMATED_RESULT') { this.observer.unobserve(tile); this.tiles.delete(tile); this.catalogItems.delete(state.item.id); this.catalogTiles.delete(state.item.id); tile.remove(); }
          else tile.classList.add('is-error');
        }).finally(() => { this.loading--; this.hydrate(); });
    }
  }
  private async getFile(item: PickerItem, signal: AbortSignal): Promise<File> {
    signal.throwIfAborted();
    if ('localAsset' in item && typeof item.localAsset === 'string' && avatarEmoji.some(row => row.id === item.id) && item.localAsset === `/space-avatars/${item.id}.webp`) {
      const response = await fetch(item.localAsset, {signal}); if (!response.ok) throw new Error('表情加载失败，请重试');
      return validateMemeFile(await response.blob(), item.title, signal);
    }
    const cached = [...this.tiles.values()].find(state => state.item.id === item.id && state.file)?.file; if (cached) return cached;
    const retained = this.cache.media.get(item.id); if (retained) { this.cache.media.delete(item.id); this.cache.media.set(item.id, retained); return retained; }
    const persisted = await this.readPersistentMedia(item, signal);
    if (persisted) { this.rememberMedia(item.id, persisted); return persisted; }
    let blob: Blob | undefined; let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { blob = item.favorite ? await this.options.file(item.favorite, signal) : await this.options.media(item.id, signal); break; }
      catch (error) { lastError = error; if (signal.aborted || attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1))); }
    }
    if (!blob) throw lastError instanceof Error ? lastError : new Error('图片加载失败');
    const file = await validateMemeFile(blob, item.title, signal);
    if (item.animatedOnly && !await detectImageAnimation(file, signal)) throw new Error('NON_ANIMATED_RESULT');
    signal.throwIfAborted();
    this.rememberMedia(item.id, file);
    void this.writePersistentMedia(item, file);
    return file;
  }
  private async perform(item: PickerItem, action: 'send' | 'save' | 'remove') {
    if (this.busy || !this.active()) return; this.busy = true; this.panel.setAttribute('aria-busy', 'true'); this.say(action === 'send' ? '正在发送…' : '正在保存…');
    try {
      if (action === 'remove') await this.options.remove(item.id, this.signal);
      else {
        const file = await this.getFile(item, this.signal); if (!this.active()) return;
        if (action === 'send') {
          // Installed packs retain encrypted local metadata. Re-read the
          // server setting at send time so an admin change applies to packs
          // that were installed before the setting was changed.
          let autoHide = Boolean(item.autoHide);
          if (item.pack) {
            const detail = await this.options.pack(item.pack, this.signal);
            const remoteItem = detail.items.find(candidate => candidate.id === item.id);
            autoHide = Boolean(remoteItem?.autoHide ?? detail.autoHide ?? item.autoHide);
          }
          await this.options.send(file, autoHide, this.signal, item.pack ? 'stickers' : item.animatedOnly ? 'gifs' : undefined); this.recordUsage(item.id);
        } else this.say(await this.options.save(file, this.signal) ? '已收藏到本机' : '已在收藏中');
      }
      // Sending is non-modal: keep the picker open so repeated expressions can
      // be sent without reopening it for every message.
      if (!this.active()) return; if (action === 'remove') { this.forgetMedia(item.id); await this.local(); }
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
    if (this.disposed) return;
    this.rememberView();
    this.disposed = true; this.emojiPlayback?.abort(); this.controller.abort();
    this.sheetAnimation?.cancel();
    this.rowAnimation?.cancel();
    if (this.preview) closeDialog(this.preview, { animate: false, restoreFocus: false }); if (this.overlay) closeDialog(this.overlay, { animate: false, restoreFocus: false });
    this.observer.disconnect(); this.autoPage.disconnect(); this.request?.abort(); for (const tile of this.tiles.keys()) this.unload(tile);
    this.tiles.clear(); this.favorites = []; this.packs = []; this.panel.remove(); this.options.host.classList.remove('has-meme-panel');
    this.options.host.style.removeProperty('--meme-sheet-height');
    delete this.options.host.dataset.expressionHandoff;
  }
}
