import { createElement, X, Search, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize } from 'lucide';
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
  private directory: HTMLSelectElement;
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
    this.directory = document.createElement('select');
    this.directory.className = 'reader-directory'; this.directory.hidden = true;
    this.directory.setAttribute('aria-label', '章节目录');
    this.directory.addEventListener('change', () => this.go(Number(this.directory.value)), { signal: this.signal });
    el.querySelector('.reader-title')!.append(this.directory);
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
      this.searchForm.hidden = !this.searchForm.hidden;
      search.setAttribute('aria-expanded', String(!this.searchForm.hidden));
      if (!this.searchForm.hidden) this.query.focus({ preventScroll: true });
      else close.focus({ preventScroll: true });
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
    this.previous = button('上一页', ChevronLeft, () => this.go(this.page - 1));
    this.next = button('下一页', ChevronRight, () => this.go(this.page + 1));
    el.querySelector('.reader-paging')!.prepend(this.previous);
    el.querySelector('.reader-paging')!.append(this.next);
    this.zoomOut = button('缩小', ZoomOut, () => this.scale(-0.25));
    this.zoomIn = button('放大', ZoomIn, () => this.scale(0.25));
    this.zoomLabel = el.querySelector('.reader-zoom output')!;
    el.querySelector('.reader-zoom')!.prepend(this.zoomOut);
    el.querySelector('.reader-zoom')!.append(this.zoomIn, button('适合宽度', Maximize, () => { this.zoom = 1; void this.render(); }));
    this.searchForm.append(button('下一个搜索结果', ChevronRight, () => void this.find()));
    this.searchForm.addEventListener('submit', event => { event.preventDefault(); void this.find(); }, { signal: this.signal });
    this.query.addEventListener('input', () => { this.searchVersion++; this.searchOffset = -1; }, { signal: this.signal });
    this.pageInput.addEventListener('change', () => this.go(Number(this.pageInput.value)), { signal: this.signal });
    el.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.onClose(); }
      if (event.key === 'Tab') {
        const nodes = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]')].filter(node => node.getClientRects().length);
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === nodes.length - 1)) {
          event.preventDefault(); nodes[event.shiftKey ? nodes.length - 1 : 0]?.focus();
        }
      }
      if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); this.go(this.page + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    }, { signal: this.signal });
    for (const sibling of root.children) if (sibling instanceof HTMLElement) {
      this.hiddenSiblings.push([sibling, sibling.inert]); sibling.inert = true;
    }
    root.append(el);
    close.focus({ preventScroll: true });
    let stageWidth = this.stage.clientWidth;
    this.observer = new ResizeObserver(() => {
      if (stageWidth === this.stage.clientWidth) return;
      stageWidth = this.stage.clientWidth;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => { if (this.ready && this.pdf) void this.render(); }, 120);
    });
    this.observer.observe(this.stage);
    attachDocumentPaging(this.stage, () => this.ready && Boolean(this.pdf || this.epub)
      && this.stage.scrollWidth <= this.stage.clientWidth + 1, direction => this.go(this.page + direction), this.signal);
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
        this.epub.titles.forEach((title, index) => this.directory.add(new Option(title, String(index + 1))));
        this.directory.hidden = false;
        this.pageInput.setAttribute('aria-label', '章节');
        for (const [button, title] of [[this.previous, '上一章'], [this.next, '下一章']] as const) {
          button.title = title; button.setAttribute('aria-label', title);
        }
      } else this.text = decodeText(bytes);
      if (this.signal.aborted || version !== this.loadVersion) return;
      clearTimeout(this.deadline);
      this.ready = true;
      this.toolbar.hidden = false;
      (this.element.querySelector('.reader-paging') as HTMLElement).hidden = !isPdf && !isEpub;
      this.element.dataset.kind = isPdf ? 'pdf' : isEpub ? 'epub' : 'text';
      await this.render();
    } catch { if (!this.signal.aborted) this.fail('无法阅读此文件，文件可能损坏、加密或格式不受支持'); }
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
    this.text = '';
    this.content.replaceChildren();
    this.toolbar.hidden = true;
    this.searchForm.hidden = true;
    this.status.hidden = false;
    this.status.textContent = message;
    this.element.dataset.state = 'error';
  }

  private go(page: number, fragment?: string): void {
    const book = this.pdf ?? this.epub;
    if (!this.ready || !book) return;
    this.page = Number.isFinite(page) ? Math.max(1, Math.min(book.pages, Math.trunc(page))) : this.page;
    this.fragment = fragment;
    this.stage.scrollTo(0, 0);
    void this.render();
  }

  private scale(delta: number): void {
    this.zoom = Math.max(0.75, Math.min(this.pdf ? 3 : 1.5, this.zoom + delta));
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.ready || this.signal.aborted) return;
    const version = ++this.renderVersion;
    this.pageInput.value = String(this.page);
    const pages = (this.pdf ?? this.epub)?.pages ?? 1;
    this.pageInput.max = String(pages);
    this.pageCount.textContent = `/ ${pages}`;
    this.directory.value = String(this.page);
    this.previous.disabled = this.page <= 1;
    this.next.disabled = this.page >= pages;
    this.zoomOut.disabled = this.zoom <= 0.75;
    this.zoomIn.disabled = this.zoom >= (this.pdf ? 3 : 1.5);
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    this.status.hidden = false;
    this.status.textContent = '正在排版';
    this.element.dataset.state = 'loading';
    clearTimeout(this.deadline);
    this.deadline = window.setTimeout(() => this.fail('文档排版超时，请关闭后重试'), 20_000);
    try {
      if (this.pdf) await this.pdf.render(this.page, this.content, Math.max(100, this.stage.clientWidth - 32), this.zoom, this.query.value.trim());
      else if (this.epub) await this.epub.render(this.page, this.content, this.zoom, this.query.value.trim(), this.fragment);
      else {
        const pre = document.createElement('pre');
        pre.className = 'reader-text'; pre.textContent = this.text;
        pre.style.fontSize = `${16 * this.zoom}px`;
        this.content.replaceChildren(pre);
      }
      if (this.signal.aborted || version !== this.renderVersion) return;
      clearTimeout(this.deadline);
      this.status.hidden = true;
      this.stage.classList.toggle('reader-swipe', Boolean(this.pdf || this.epub) && this.stage.scrollWidth <= this.stage.clientWidth + 1);
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
    this.observer.disconnect();
    this.pdf?.destroy(); this.pdf = undefined;
    this.epub?.destroy(); this.epub = undefined;
    this.text = ''; this.query.value = ''; this.lastQuery = '';
    this.content.replaceChildren();
    this.element.replaceChildren();
    this.element.remove();
    for (const [node, inert] of this.hiddenSiblings) node.inert = inert;
    this.hiddenSiblings = [];
  }
}
