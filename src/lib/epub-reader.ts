import Packaging from 'epubjs/src/packaging.js';
import Navigation, { type NavigationItem } from 'epubjs/src/navigation.js';
import DOMPurify from 'dompurify';
import ArchiveWorker from './epub-archive.worker?worker';

const XML_LIMIT = 2 * 1024 * 1024;
const BOOK_ORIGIN = 'https://epub.invalid';
const tags = ['p', 'div', 'span', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'blockquote', 'pre', 'code', 'ol', 'ul', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'ruby', 'rt', 'rp', 'figure', 'figcaption', 'img', 'a'];

function localReference(href: string, base = ''): { path: string; fragment: string } | undefined {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('/') || /[\\\u0000-\u001f]/.test(href)) return;
  try {
    const url = new URL(href, `${BOOK_ORIGIN}/${base}`);
    if (url.origin !== BOOK_ORIGIN || url.search) return;
    const path = decodeURIComponent(url.pathname.slice(1));
    if (/[\\\u0000-\u001f]/.test(path) || path.split('/').some(part => part === '..' || part === '.')) return;
    return { path, fragment: decodeURIComponent(url.hash.slice(1)) };
  } catch { return; }
}

function xml(bytes: Uint8Array): Document {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source)) throw new Error('XML_ENTITY');
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('INVALID_XML');
  const nodes = doc.querySelectorAll('*');
  if (nodes.length > 30_000) throw new Error('XML_LIMIT');
  for (const node of nodes) {
    let depth = 0;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) if (++depth > 64) throw new Error('XML_DEPTH');
    if (['__proto__', 'constructor', 'prototype'].includes(node.getAttribute('id') ?? '')) throw new Error('INVALID_ID');
  }
  return doc;
}

export class EpubReader {
  private worker = new ArchiveWorker();
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private serial = 0;
  private disposed = false;
  private version = 0;
  private files = new Set<string>();
  private images = new Map<string, string>();
  private urls = new Set<string>();
  private chapters: Array<{ path: string; label: string }> = [];
  get pages(): number { return this.chapters.length; }
  get titles(): string[] { return this.chapters.map(chapter => chapter.label); }

  constructor(private navigate: (page: number, fragment?: string) => void) {
    this.worker.onmessage = event => {
      const request = this.pending.get(event.data.id);
      this.pending.delete(event.data.id);
      if (event.data.error) request?.reject(new Error('EPUB_ARCHIVE'));
      else request?.resolve(event.data.value);
    };
    this.worker.onerror = () => this.destroy();
  }

  private request<T>(data: object): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('READER_CLOSED'));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.serial;
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.worker.postMessage({ ...data, id });
    });
  }

  private read(path: string, limit = XML_LIMIT): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.files.has(path)) return Promise.reject(new Error('MISSING_RESOURCE'));
    return this.request({ path, limit });
  }

  async load(bytes: Uint8Array): Promise<void> {
    const names = await this.request<string[]>({ bytes });
    if (this.disposed) return;
    this.files = new Set(names);
    if (this.files.has('META-INF/encryption.xml')) throw new Error('ENCRYPTED_EPUB');
    if (new TextDecoder().decode(await this.read('mimetype', 64)).trim() !== 'application/epub+zip') throw new Error('INVALID_EPUB');
    const container = xml(await this.read('META-INF/container.xml'));
    const rootfile = [...container.getElementsByTagNameNS('*', 'rootfile')].find(node => node.getAttribute('media-type') === 'application/oebps-package+xml');
    const opf = localReference(rootfile?.getAttribute('full-path') ?? '')?.path;
    if (!opf) throw new Error('MISSING_PACKAGE');
    const packaging = new Packaging(xml(await this.read(opf)));
    try {
      for (const item of Object.values(packaging.manifest)) {
        const path = localReference(item.href, opf)?.path;
        if (path && this.files.has(path) && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.type)) this.images.set(path, item.type);
      }
      for (const item of packaging.spine) {
        const resource = packaging.manifest[item.idref];
        const path = resource && localReference(resource.href, opf)?.path;
        if (!path || !this.files.has(path) || !['application/xhtml+xml', 'text/html'].includes(resource.type)) throw new Error('INVALID_SPINE');
        this.chapters.push({ path, label: `第 ${this.chapters.length + 1} 章` });
      }
      if (!this.pages) throw new Error('EMPTY_EPUB');
      const navPath = localReference(packaging.navPath || packaging.ncxPath, opf)?.path;
      if (navPath && this.files.has(navPath)) {
        const navigation = new Navigation(xml(await this.read(navPath)));
        const visit = (items: NavigationItem[]) => {
          for (const item of items) {
            const target = localReference(item.href, navPath);
            const chapter = this.chapters.find(chapter => chapter.path === target?.path);
            if (chapter && !target?.fragment && item.label.trim()) chapter.label = item.label.trim().slice(0, 160);
            visit(item.subitems);
          }
        };
        visit(navigation.toc);
      }
    } finally { packaging.destroy(); }
  }

  private async chapter(page: number): Promise<DocumentFragment> {
    const chapter = this.chapters[page - 1];
    if (!chapter) throw new Error('MISSING_CHAPTER');
    const doc = xml(await this.read(chapter.path));
    const body = doc.getElementsByTagNameNS('*', 'body')[0];
    if (!body) throw new Error('MISSING_BODY');
    return DOMPurify.sanitize(body, { ALLOWED_TAGS: ['body', ...tags],
      ALLOWED_ATTR: ['id', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'lang', 'dir'],
      ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true });
  }

  async text(page: number): Promise<string> { return (await this.chapter(page)).textContent ?? ''; }

  async render(page: number, container: HTMLElement, zoom: number, query: string, fragment?: string): Promise<void> {
    const version = ++this.version;
    this.releaseImages();
    const body = await this.chapter(page);
    const current = () => !this.disposed && version === this.version;
    if (!current()) return;
    const base = this.chapters[page - 1]!.path;
    for (const node of body.querySelectorAll('[id]')) {
      (node as HTMLElement).dataset.readerAnchor = node.id;
      node.removeAttribute('id');
    }
    let imageBytes = 0;
    for (const image of body.querySelectorAll('img')) {
      const path = localReference(image.getAttribute('src') ?? '', base)?.path;
      image.removeAttribute('src');
      if (!path || !this.images.has(path)) { image.remove(); continue; }
      const bytes = await this.read(path, 8 * 1024 * 1024);
      if (!current()) return;
      imageBytes += bytes.length;
      if (imageBytes > 24 * 1024 * 1024) throw new Error('IMAGE_LIMIT');
      const url = URL.createObjectURL(new Blob([bytes], { type: this.images.get(path)! }));
      this.urls.add(url);
      image.src = url;
      image.loading = 'lazy'; image.decoding = 'async';
    }
    for (const anchor of body.querySelectorAll('a')) {
      const target = localReference(anchor.getAttribute('href') ?? '', base);
      anchor.removeAttribute('href');
      const index = this.chapters.findIndex(chapter => chapter.path === target?.path);
      if (index < 0) continue;
      anchor.setAttribute('role', 'link'); anchor.tabIndex = 0;
      const follow = () => { if (current()) this.navigate(index + 1, target?.fragment); };
      anchor.addEventListener('click', follow);
      anchor.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); follow(); } });
    }
    if (!current()) return;
    const article = document.createElement('article');
    article.className = 'reader-epub'; article.style.fontSize = `${16 * zoom}px`;
    article.append(body);
    const lower = query.toLocaleLowerCase();
    if (lower) {
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      for (const node of nodes) {
        const index = node.data.toLocaleLowerCase().indexOf(lower);
        if (index < 0) continue;
        const mark = document.createElement('mark'); mark.textContent = node.data.slice(index, index + query.length);
        node.replaceWith(document.createTextNode(node.data.slice(0, index)), mark, document.createTextNode(node.data.slice(index + query.length)));
      }
    }
    container.replaceChildren(article);
    if (fragment) [...article.querySelectorAll<HTMLElement>('[data-reader-anchor]')].find(node => node.dataset.readerAnchor === fragment)?.scrollIntoView({ block: 'start' });
    else article.querySelector('mark')?.scrollIntoView({ block: 'center' });
  }

  private releaseImages(): void { for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear(); }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.version++;
    this.worker.terminate(); this.worker.onmessage = null; this.worker.onerror = null;
    for (const pending of this.pending.values()) pending.reject(new Error('READER_CLOSED'));
    this.pending.clear(); this.releaseImages(); this.files.clear(); this.images.clear(); this.chapters = [];
  }
}
