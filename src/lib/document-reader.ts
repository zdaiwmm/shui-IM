import { createElement, X, Search, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize, ArrowDownUp, ArrowLeftRight, Send, List } from 'lucide';
import type { PdfReader } from './pdf-reader';
import type { EpubReader } from './epub-reader';
import { attachDocumentPaging } from './document-paging';
import '../document-reader.css';
export { systemReadableMimeType as documentReaderMimeType } from './download';

export const PDF_READER_LIMIT = 64 * 1024 * 1024;
export const TEXT_READER_LIMIT = 4 * 1024 * 1024;
export const EPUB_READER_LIMIT = 32 * 1024 * 1024;
export function documentReaderLimit(type: string): number {
  return type === 'application/pdf' ? PDF_READER_LIMIT : type === 'application/epub+zip' ? EPUB_READER_LIMIT : TEXT_READER_LIMIT;
}

function decodeText(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
    : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(data); }
  catch { text = new TextDecoder('gb18030', { fatal: true }).decode(data); }
  if (text.includes('\0') || text.length > 2_000_000) throw new Error('TEXT_LIMIT_OR_ENCODING');
  return text;
}

export class DocumentReader {
  readonly element = document.createElement('section');
  private abort = new AbortController();
  readonly signal = this.abort.signal;
  private pdf?: PdfReader;
  private epub?: EpubReader;
  private directory: HTMLElement;
  private directoryButton: HTMLButtonElement;
  private chapterPages: number[] = [];
  private paginationKey = '';
  private fragment?: string;
  private content: HTMLElement;
  private stage: HTMLElement;
  private status: HTMLElement;
  private pageInput: HTMLInputElement;
  private pageCount: HTMLElement;
  private query: HTMLInputElement;
  private toolbar: HTMLElement;
  private searchForm: HTMLFormElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private zoomOut: HTMLButtonElement;
  private zoomIn: HTMLButtonElement;
  private zoomLabel: HTMLElement;
  private observer: ResizeObserver;
  private hiddenSiblings: Array<[HTMLElement, boolean]> = [];
  private text = '';
  private page = 1;
  private zoom = 1;
  private renderVersion = 0;
  private searchVersion = 0;
  private searchOffset = -1;
  private lastQuery = '';
  private deadline?: number;
  private resizeTimer?: number;
  private ready = false;
  private loadVersion = 0;
  private mode: 'pages' | 'scroll' = 'pages';
  private screen = 0;
  private screens = 1;
  private stride = 0;
  private turn = 0;
  private pageAnimation?: Animation;
  private searchAnimation?: Animation;
  private scrollTimer?: number;
  private pdfSlots: HTMLElement[] = [];
  private pdfRendered = new Set<number>();
  private scrollRendering = false;

  constructor(root: HTMLElement, filename: string, private mimeType: string, private onClose: () => void) {
    const el = this.element;
    el.className = 'document-reader';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '文件阅读器');
    el.innerHTML = `<header class="reader-header"><div class="reader-title"><strong></strong><span></span></div></header>
      <form class="reader-search" hidden><input type="search" aria-label="搜索文档" placeholder="搜索文档" maxlength="120"><output aria-live="polite"></output></form>
      <div class="reader-stage" tabindex="0" aria-label="文档内容"><div class="reader-content"></div></div>
      <p class="reader-status" role="status">正在读取</p>
      <footer class="reader-toolbar" hidden><div class="reader-paging"><input type="number" min="1" value="1" aria-label="页码"><span></span></div><div class="reader-zoom"><output>100%</output></div></footer>`;
    el.querySelector('strong')!.textContent = filename;
    el.querySelector('.reader-title > span')!.textContent = mimeType === 'application/pdf' ? 'PDF' : mimeType === 'application/epub+zip' ? 'EPUB' : '文本';
    this.directory = document.createElement('div');
    this.directory.className = 'reader-directory'; this.directory.hidden = true;
    this.directory.id = 'reader-directory';
    this.directory.setAttribute('role', 'menu');
    this.directory.setAttribute('aria-label', '章节目录');
    const button = (label: string, icon: typeof X, action: () => void) => {
      const node = document.createElement('button');
      node.type = 'button'; node.className = 'reader-control'; node.title = label; node.setAttribute('aria-label', label);
      const svg = createElement(icon);
      svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
      node.append(svg);
      node.addEventListener('click', action, { signal: this.signal });
      return node;
    };
    const close = button('关闭阅读器', X, () => this.onClose());
    const search = button('搜索', Search, () => {
      this.searchAnimation?.cancel();
      this.searchForm.hidden = false;
      el.classList.add('reader-searching');
      search.setAttribute('aria-expanded', 'true');
      this.query.focus({ preventScroll: true });
    });
    search.setAttribute('aria-expanded', 'false');
    el.querySelector('header')!.prepend(close);
    el.querySelector('header')!.append(search);
    this.stage = el.querySelector('.reader-stage')!;
    this.content = el.querySelector('.reader-content')!;
    this.status = el.querySelector('.reader-status')!;
    this.toolbar = el.querySelector('footer')!;
    this.pageInput = el.querySelector('.reader-paging input')!;
    this.pageCount = el.querySelector('.reader-paging span')!;
    this.query = el.querySelector('.reader-search input')!;
    this.searchForm = el.querySelector('form')!;
    el.querySelector('header')!.append(this.searchForm);
    this.searchForm.prepend(button('关闭搜索', X, () => {
      const finish = () => {
        if (this.signal.aborted) return;
        this.searchForm.hidden = true; el.classList.remove('reader-searching');
        search.setAttribute('aria-expanded', 'false'); search.focus({ preventScroll: true });
      };
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
      else {
        this.searchAnimation?.cancel();
        this.searchAnimation = this.searchForm.animate([
          { clipPath: 'inset(0 round 24px)', opacity: 1 },
          { clipPath: 'inset(0 0 0 calc(100% - 44px) round 24px)', opacity: 0 },
        ], { duration: 180, easing: 'ease-out' });
        this.searchAnimation.onfinish = finish;
      }
    }));
    this.previous = button('上一页', ChevronLeft, () => this.step(-1));
    this.next = button('下一页', ChevronRight, () => this.step(1));
    el.querySelector('.reader-paging')!.prepend(this.previous);
    el.querySelector('.reader-paging')!.append(this.next);
    this.zoomOut = button('缩小', ZoomOut, () => this.scale(-0.25));
    this.zoomIn = button('放大', ZoomIn, () => this.scale(0.25));
    this.zoomLabel = el.querySelector('.reader-zoom output')!;
    el.querySelector('.reader-zoom')!.prepend(this.zoomOut);
    el.querySelector('.reader-zoom')!.append(this.zoomIn, button('适合宽度', Maximize, () => { this.zoom = 1; void this.render(); }));
    this.searchForm.append(button('下一个搜索结果', Send, () => void this.find()));
    const mode = button('上下滚动', ArrowDownUp, () => {
      this.mode = this.mode === 'pages' ? 'scroll' : 'pages';
      el.dataset.mode = this.mode;
      const label = this.mode === 'pages' ? '上下滚动' : '左右翻页';
      mode.title = label; mode.setAttribute('aria-label', label);
      mode.replaceChildren(createElement(this.mode === 'pages' ? ArrowDownUp : ArrowLeftRight));
      this.screen = 0; this.stage.scrollTo(0, 0); void this.render();
    });
    this.directoryButton = button('章节目录', List, () => this.toggleDirectory());
    this.directoryButton.hidden = true;
    this.directoryButton.setAttribute('aria-expanded', 'false');
    this.directoryButton.setAttribute('aria-controls', this.directory.id);
    this.directoryButton.setAttribute('aria-haspopup', 'menu');
    mode.classList.add('reader-mode'); this.toolbar.append(mode, this.directoryButton);
    el.append(this.directory);
    el.addEventListener('pointerdown', event => {
      if (!this.directory.hidden && !this.directory.contains(event.target as Node) && !this.directoryButton.contains(event.target as Node)) this.toggleDirectory(false, false);
    }, { signal: this.signal });
    this.directory.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const buttons = [...this.directory.querySelectorAll('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }, { signal: this.signal });
    el.dataset.mode = this.mode;
    this.searchForm.addEventListener('submit', event => { event.preventDefault(); void this.find(); }, { signal: this.signal });
    this.query.addEventListener('input', () => { this.searchVersion++; this.searchOffset = -1; }, { signal: this.signal });
    this.pageInput.addEventListener('change', () => {
      if (this.pdf) this.go(Number(this.pageInput.value));
      else if (this.epub) this.goBookPage(Number(this.pageInput.value));
      else { this.screen = Math.max(0, Math.min(this.screens - 1, Number(this.pageInput.value) - 1 || 0)); this.position(); }
    }, { signal: this.signal });
    el.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!this.directory.hidden) this.toggleDirectory(false); else this.onClose(); }
      if (event.key === 'Tab') {
        const nodes = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]')].filter(node => node.getClientRects().length);
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === nodes.length - 1)) {
          event.preventDefault(); nodes[event.shiftKey ? nodes.length - 1 : 0]?.focus();
        }
      }
      if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); this.step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    }, { signal: this.signal });
    for (const sibling of root.children) if (sibling instanceof HTMLElement) {
      this.hiddenSiblings.push([sibling, sibling.inert]); sibling.inert = true;
    }
    root.append(el);
    close.focus({ preventScroll: true });
    let stageSize = `${this.stage.clientWidth}:${this.stage.clientHeight}`;
    this.observer = new ResizeObserver(() => {
      const size = `${this.stage.clientWidth}:${this.stage.clientHeight}`;
      if (stageSize === size) return;
      stageSize = size;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => { if (this.ready) void this.render(); }, 120);
    });
    this.observer.observe(this.stage);
    attachDocumentPaging(this.stage, () => this.ready && this.mode === 'pages'
      && (!this.pdf || this.zoom <= 1), direction => this.step(direction), this.signal);
    this.stage.addEventListener('scroll', () => {
      if (this.mode === 'scroll' && this.epub && this.element.dataset.state === 'ready') {
        const progress = this.stage.scrollTop / Math.max(1, this.stage.scrollHeight - this.stage.clientHeight);
        this.screen = Math.min(this.screens - 1, Math.floor(progress * this.screens)); this.position();
      }
      if (this.mode !== 'scroll' || !this.pdf) return;
      clearTimeout(this.scrollTimer);
      this.scrollTimer = window.setTimeout(() => void this.renderPdfWindow(), 60);
    }, { signal: this.signal });
    let vertical: { y: number; top: boolean; bottom: boolean } | undefined;
    this.stage.addEventListener('touchstart', event => {
      vertical = event.touches.length === 1 ? { y: event.touches[0]!.clientY, top: this.stage.scrollTop <= 1,
        bottom: this.stage.scrollTop + this.stage.clientHeight >= this.stage.scrollHeight - 1 } : undefined;
    }, { signal: this.signal, passive: true });
    this.stage.addEventListener('touchend', event => {
      if (vertical && this.mode === 'scroll' && this.epub && event.changedTouches.length === 1) {
        const dy = event.changedTouches[0]!.clientY - vertical.y;
        if (dy < -70 && vertical.bottom) this.go(this.page + 1);
        else if (dy > 70 && vertical.top) this.go(this.page - 1, undefined, true);
      }
      vertical = undefined;
    }, { signal: this.signal, passive: true });
    this.stage.addEventListener('wheel', event => {
      if (this.mode !== 'scroll' || !this.epub || this.element.dataset.state !== 'ready') return;
      if (event.deltaY > 20 && this.stage.scrollTop + this.stage.clientHeight >= this.stage.scrollHeight - 1) this.go(this.page + 1);
      else if (event.deltaY < -20 && this.stage.scrollTop <= 1) this.go(this.page - 1, undefined, true);
    }, { signal: this.signal, passive: true });
  }

  progress(ratio: number): void { if (!this.signal.aborted) this.status.textContent = `正在读取 ${Math.round(ratio * 100)}%`; }

  async load(blob: Blob): Promise<void> {
    if (this.signal.aborted) return;
    const version = ++this.loadVersion;
    try {
      const isPdf = this.mimeType === 'application/pdf';
      const isEpub = this.mimeType === 'application/epub+zip';
      if (blob.size > documentReaderLimit(this.mimeType)) {
        this.fail(`文件过大，阅读上限为 ${documentReaderLimit(this.mimeType) / 1024 / 1024} MB`); return;
      }
      this.deadline = window.setTimeout(() => this.fail('文档读取超时，请关闭后重试'), 30_000);
      const bytes = await blob.arrayBuffer();
      if (this.signal.aborted || version !== this.loadVersion) return;
      if (isPdf) {
        const { PdfReader } = await import('./pdf-reader');
        if (this.signal.aborted || version !== this.loadVersion) return;
        this.pdf = new PdfReader();
        await this.pdf.load(new Uint8Array(bytes));
      } else if (isEpub) {
        const { EpubReader } = await import('./epub-reader');
        if (this.signal.aborted || version !== this.loadVersion) return;
        this.epub = new EpubReader((page, fragment) => this.go(page, fragment));
        await this.epub.load(new Uint8Array(bytes));
        if (this.signal.aborted || version !== this.loadVersion) return;
        this.epub.titles.forEach((title, index) => {
          const item = document.createElement('button');
          item.type = 'button'; item.textContent = title;
          item.dataset.chapter = String(index + 1); item.setAttribute('role', 'menuitem');
          item.addEventListener('click', () => { this.toggleDirectory(false); this.go(index + 1); }, { signal: this.signal });
          this.directory.append(item);
        });
        this.directoryButton.hidden = false;
      } else this.text = decodeText(bytes);
      if (this.signal.aborted || version !== this.loadVersion) return;
      clearTimeout(this.deadline);
      this.ready = true;
      this.toolbar.hidden = false;
      this.element.dataset.kind = isPdf ? 'pdf' : isEpub ? 'epub' : 'text';
      await this.render();
    } catch { if (!this.signal.aborted) this.fail('无法阅读此文件，文件可能损坏、加密或格式不受支持'); }
  }

  private toggleDirectory(open = this.directory.hidden, focus = true): void {
    this.directory.hidden = !open;
    this.directoryButton.setAttribute('aria-expanded', String(open));
    if (!focus) return;
    if (open) this.directory.querySelector<HTMLButtonElement>(`[data-chapter="${this.page}"]`)?.focus({ preventScroll: true });
    else this.directoryButton.focus({ preventScroll: true });
    if (open) this.directory.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  private goBookPage(value: number): void {
    const total = this.chapterPages.reduce((sum, count) => sum + count, 0);
    let page = Math.max(1, Math.min(total, Math.trunc(value) || 1));
    let chapter = 0;
    while (chapter < this.chapterPages.length - 1 && page > this.chapterPages[chapter]!) page -= this.chapterPages[chapter++]!;
    if (chapter + 1 === this.page) {
      this.screen = page - 1;
      if (this.mode === 'scroll') this.stage.scrollTop = (this.stage.scrollHeight - this.stage.clientHeight) * this.screen / Math.max(1, this.screens - 1);
      this.position();
    }
    else this.go(chapter + 1, undefined, false, page - 1);
  }

  fail(message = '文件读取失败，请关闭后重试'): void {
    if (this.signal.aborted) return;
    this.ready = false;
    this.loadVersion++;
    this.searchVersion++;
    this.renderVersion++;
    clearTimeout(this.deadline);
    this.pdf?.destroy(); this.pdf = undefined;
    this.epub?.destroy(); this.epub = undefined;
    this.directory.replaceChildren(); this.directory.hidden = true;
    this.directoryButton.hidden = true; this.chapterPages = []; this.paginationKey = '';
    this.text = '';
    this.content.replaceChildren();
    this.toolbar.hidden = true;
    this.searchForm.hidden = true;
    this.status.hidden = false;
    this.status.textContent = message;
    this.element.dataset.state = 'error';
  }

  private go(page: number, fragment?: string, end = false, screen = 0): void {
    const book = this.pdf ?? this.epub;
    if (!this.ready || !book) return;
    const next = Number.isFinite(page) ? Math.max(1, Math.min(book.pages, Math.trunc(page))) : this.page;
    if (next === this.page && page !== next) return;
    this.turn = Math.sign(next - this.page); this.page = next;
    this.screen = end ? Number.MAX_SAFE_INTEGER : screen;
    this.fragment = fragment;
    this.stage.scrollTo(0, 0);
    void this.render();
  }

  private step(direction: number): void {
    if (!this.ready || this.element.dataset.state !== 'ready') return;
    if (this.pdf) { this.go(this.page + direction); return; }
    if (this.mode === 'scroll') { if (this.epub) this.go(this.page + direction, undefined, direction < 0); return; }
    const next = this.screen + direction;
    if (next >= 0 && next < this.screens) {
      this.turn = direction; this.screen = next; this.position();
    } else if (this.epub && (direction > 0 ? this.page < this.epub.pages : this.page > 1)) this.go(this.page + direction, undefined, direction < 0);
  }

  private position(): void {
    this.screen = Math.min(this.screen, this.screens - 1);
    if (!this.pdf && this.mode === 'pages') {
      this.content.style.transform = `translate3d(${-this.screen * this.stride}px,0,0)`;
      this.stage.scrollLeft = 0; this.stage.scrollTop = 0;
    }
    const pages = this.pdf?.pages ?? (this.epub ? this.chapterPages.reduce((sum, count) => sum + count, 0) : this.screens);
    const offset = this.epub ? this.chapterPages.slice(0, this.page - 1).reduce((sum, count) => sum + count, 0) : 0;
    this.pageInput.value = String(this.pdf ? this.page : offset + this.screen + 1);
    this.pageInput.max = String(pages); this.pageCount.textContent = `/ ${pages}`;
    this.directory.dataset.chapter = String(this.page);
    for (const item of this.directory.querySelectorAll<HTMLElement>('[data-chapter]')) item.setAttribute('aria-current', String(item.dataset.chapter === String(this.page)));
    this.previous.disabled = this.pdf ? this.page <= 1 : this.screen === 0 && (!this.epub || this.page === 1);
    this.next.disabled = this.pdf ? this.page >= pages : this.screen >= this.screens - 1 && (!this.epub || this.page === this.epub.pages);
    if (this.turn && !this.pdf && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.pageAnimation?.cancel();
      const target = this.content;
      const end = target.style.transform || 'translate3d(0,0,0)';
      this.pageAnimation = target.animate([
        { transform: `${end} translateX(${this.turn * Math.min(this.stage.clientWidth * .2, 100)}px)`, opacity: .55 },
        { transform: end, opacity: 1 },
      ], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    this.turn = 0;
  }

  private layoutText(): void {
    const article = this.content.firstElementChild as HTMLElement | null;
    if (!article) return;
    this.content.style.transform = '';
    if (this.mode === 'pages') {
      this.screens = this.measurePages(article);
      const target = this.fragment ? [...article.querySelectorAll<HTMLElement>('[data-reader-anchor]')].find(node => node.dataset.readerAnchor === this.fragment) : article.querySelector('mark');
      if (target) this.screen = Math.max(0, Math.floor((target.getBoundingClientRect().left - article.getBoundingClientRect().left) / this.stride));
    } else {
      this.screens = this.epub ? this.chapterPages[this.page - 1] ?? 1 : 1;
      this.screen = Math.min(this.screen, this.screens - 1);
      if (this.screen > 0) this.stage.scrollTop = (this.stage.scrollHeight - this.stage.clientHeight) * this.screen / Math.max(1, this.screens - 1);
    }
    this.position(); this.fragment = undefined;
  }

  private measurePages(article: HTMLElement): number {
    const style = getComputedStyle(this.stage);
    const width = Math.max(60, this.stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const height = Math.max(60, this.stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
    this.stride = width + 32;
    article.style.height = `${height}px`;
    article.style.columnWidth = `${width}px`; article.style.columnGap = '32px'; article.style.columnFill = 'auto';
    article.style.maxWidth = 'none'; article.style.width = `${width}px`;
    article.style.setProperty('--reader-page-height', `${height}px`);
    return Math.max(1, Math.ceil((article.scrollWidth + 32) / this.stride));
  }

  private async paginateBook(version: number): Promise<void> {
    const key = `${this.stage.clientWidth}:${this.stage.clientHeight}:${this.zoom}`;
    if (!this.epub || this.paginationKey === key) return;
    const measure = document.createElement('div');
    measure.className = 'reader-content reader-measure'; measure.inert = true;
    this.element.append(measure);
    const pages: number[] = [];
    try {
      for (let chapter = 1; chapter <= this.epub.pages; chapter++) {
        if (this.signal.aborted || version !== this.renderVersion) return;
        await this.epub.render(chapter, measure, this.zoom, '');
        if (this.signal.aborted || version !== this.renderVersion) return;
        pages.push(this.measurePages(measure.firstElementChild as HTMLElement));
        measure.replaceChildren();
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      if (this.signal.aborted || version !== this.renderVersion) return;
      this.chapterPages = pages; this.paginationKey = key;
    } finally { measure.remove(); }
  }

  private async renderPdfWindow(): Promise<void> {
    if (!this.pdf || this.signal.aborted || this.mode !== 'scroll' || this.scrollRendering || !this.pdfSlots.length) return;
    this.scrollRendering = true;
    const scrollTop = this.stage.scrollTop;
    const version = this.renderVersion;
    const current = () => !this.signal.aborted && version === this.renderVersion && this.mode === 'scroll';
    try {
      const middle = this.stage.getBoundingClientRect().top + this.stage.clientHeight / 2;
      let closest = 0, distance = Infinity;
      this.pdfSlots.forEach((slot, index) => { const rect = slot.getBoundingClientRect(); const d = Math.abs((rect.top + rect.bottom) / 2 - middle); if (d < distance) { closest = index; distance = d; } });
      this.page = closest + 1; this.position();
      const pages = [this.page, this.page - 1, this.page + 1].filter(page => page > 0 && page <= this.pdfSlots.length);
      this.pdf.retain(pages);
      for (const page of this.pdfRendered) if (!pages.includes(page)) this.pdfRendered.delete(page);
      for (const page of pages) {
        if (!current()) return;
        if (this.pdfRendered.has(page)) continue;
        const slot = this.pdfSlots[page - 1]!;
        await this.pdf.render(page, slot, Math.max(100, this.stage.clientWidth - 32), this.zoom, this.query.value.trim(), true);
        if (!current()) return;
        const sheet = slot.firstElementChild as HTMLElement | null;
        if (sheet) slot.style.height = `${sheet.offsetHeight + 16}px`;
        this.pdfRendered.add(page);
      }
    } catch { if (current()) this.fail(); }
    finally {
      this.scrollRendering = false;
      if (!this.signal.aborted && this.mode === 'scroll' && (version !== this.renderVersion || Math.abs(scrollTop - this.stage.scrollTop) > 1)) {
        clearTimeout(this.scrollTimer); this.scrollTimer = window.setTimeout(() => void this.renderPdfWindow(), 0);
      }
    }
  }

  private scale(delta: number): void {
    this.zoom = Math.max(0.75, Math.min(this.pdf ? 3 : 1.5, this.zoom + delta));
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.ready || this.signal.aborted) return;
    clearTimeout(this.resizeTimer);
    const size = `${this.stage.clientWidth}:${this.stage.clientHeight}`;
    const version = ++this.renderVersion;
    this.pageAnimation?.cancel(); this.content.style.transform = '';
    this.pdfSlots = []; this.pdfRendered.clear(); this.pdf?.retain([]);
    this.previous.disabled = true;
    this.next.disabled = true;
    this.pageInput.disabled = true;
    this.zoomOut.disabled = this.zoom <= 0.75;
    this.zoomIn.disabled = this.zoom >= (this.pdf ? 3 : 1.5);
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.status.hidden = false;
    this.status.textContent = '正在排版';
    this.element.dataset.state = 'loading';
    clearTimeout(this.deadline);
    this.deadline = window.setTimeout(() => this.fail('文档排版超时，请关闭后重试'), 20_000);
    try {
      await this.paginateBook(version);
      if (this.signal.aborted || version !== this.renderVersion) return;
      if (this.pdf && this.mode === 'scroll') {
        this.content.replaceChildren();
        this.pdfSlots = Array.from({ length: this.pdf.pages }, (_, index) => {
          const slot = document.createElement('div'); slot.className = 'reader-pdf-slot';
          slot.style.height = `${Math.max(240, (this.stage.clientWidth - 32) * 1.414 * this.zoom)}px`;
          slot.setAttribute('aria-label', `第 ${index + 1} 页`); this.content.append(slot); return slot;
        });
        this.stage.scrollTop = this.pdfSlots[this.page - 1]!.offsetTop - this.content.offsetTop;
        await this.renderPdfWindow();
      } else if (this.pdf) await this.pdf.render(this.page, this.content, Math.max(100, this.stage.clientWidth - 32), this.zoom, this.query.value.trim());
      else if (this.epub) await this.epub.render(this.page, this.content, this.zoom, this.query.value.trim(), this.fragment);
      else {
        const pre = document.createElement('pre');
        pre.className = 'reader-text'; pre.textContent = this.text;
        pre.style.fontSize = `${16 * this.zoom}px`;
        this.content.replaceChildren(pre);
      }
      if (this.signal.aborted || version !== this.renderVersion) return;
      if (!this.pdf) this.layoutText(); else this.position();
      if (size === `${this.stage.clientWidth}:${this.stage.clientHeight}`) clearTimeout(this.resizeTimer);
      clearTimeout(this.deadline);
      this.status.hidden = true;
      this.pageInput.disabled = false;
      this.stage.classList.toggle('reader-swipe', this.mode === 'pages' && (!this.pdf || this.zoom <= 1));
      this.element.dataset.state = 'ready';
    } catch { if (!this.signal.aborted && version === this.renderVersion) this.fail(); }
  }

  private async find(): Promise<void> {
    if (!this.ready || this.signal.aborted) return;
    const query = this.query.value.trim().toLocaleLowerCase();
    const output = this.searchForm.querySelector('output')!;
    const version = ++this.searchVersion;
    if (!query) { output.textContent = ''; return; }
    const same = query === this.lastQuery;
    this.lastQuery = query;
    output.textContent = '搜索中';
    if (this.pdf || this.epub) {
      const pdf = (this.pdf ?? this.epub)!;
      const start = same ? this.page % pdf.pages + 1 : this.page;
      const started = performance.now();
      try {
        for (let offset = 0; offset < pdf.pages; offset++) {
          if (this.signal.aborted || version !== this.searchVersion) return;
          if (performance.now() - started > 15_000) { output.textContent = '搜索超时'; return; }
          const page = (start - 1 + offset) % pdf.pages + 1;
          const text = await pdf.text(page);
          if (this.signal.aborted || version !== this.searchVersion) return;
          if (text.toLocaleLowerCase().includes(query)) { output.textContent = `第 ${page} ${this.epub ? '章' : '页'}`; this.go(page); return; }
          await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        }
        output.textContent = '无结果';
      } catch { if (!this.signal.aborted && version === this.searchVersion) output.textContent = '搜索失败'; }
    } else {
      const lower = this.text.toLocaleLowerCase();
      let index = lower.indexOf(query, same ? this.searchOffset + 1 : 0);
      if (index < 0) index = lower.indexOf(query);
      this.searchOffset = index;
      output.textContent = index < 0 ? '无结果' : '已找到';
      const pre = this.content.querySelector('pre');
      if (!pre) return;
      pre.textContent = this.text;
      if (index >= 0) {
        const mark = document.createElement('mark'); mark.textContent = this.text.slice(index, index + query.length);
        pre.replaceChildren(document.createTextNode(this.text.slice(0, index)), mark, document.createTextNode(this.text.slice(index + query.length)));
        mark.scrollIntoView({ block: 'center' });
        if (this.mode === 'pages') { this.content.style.transform = ''; this.screen = Math.floor((mark.getBoundingClientRect().left - pre.getBoundingClientRect().left) / this.stride); this.position(); }
      }
    }
  }

  destroy(): void {
    if (this.signal.aborted) return;
    this.abort.abort();
    this.searchVersion++;
    this.renderVersion++;
    clearTimeout(this.deadline);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.scrollTimer); this.pageAnimation?.cancel(); this.searchAnimation?.cancel(); this.pdfSlots = [];
    this.observer.disconnect();
    this.pdf?.destroy(); this.pdf = undefined;
    this.epub?.destroy(); this.epub = undefined;
    this.text = ''; this.query.value = ''; this.lastQuery = '';
    this.chapterPages = []; this.paginationKey = '';
    this.content.replaceChildren();
    this.element.replaceChildren();
    this.element.remove();
    for (const [node, inert] of this.hiddenSiblings) node.inert = inert;
    this.hiddenSiblings = [];
  }
}
