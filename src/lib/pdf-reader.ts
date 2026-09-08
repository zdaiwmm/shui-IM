import { getDocument, PDFWorker, TextLayer } from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

// Resolve only build-owned resources. Document-provided URLs never reach fetch.
const assets = import.meta.glob('/node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', {
  query: '?url&no-inline', import: 'default', eager: true,
}) as Record<string, string>;
const folders: Record<string, string> = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' };

export class PdfReader {
  private port = new PdfWorker();
  private worker = PDFWorker.create({ port: this.port });
  private loading?: PDFDocumentLoadingTask;
  private document?: PDFDocumentProxy;
  private renderTask?: RenderTask;
  private textLayer?: TextLayer;
  private disposed = false;
  private fetchAbort = new AbortController();
  private renderVersion = 0;
  private pageNumber = 0;
  private canvas?: HTMLCanvasElement;
  pages = 0;

  async load(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const signal = this.fetchAbort.signal;
    this.loading = getDocument({
      data: bytes, worker: this.worker, enableXfa: false, stopAtErrors: true,
      disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      maxImageSize: 16_000_000, canvasMaxAreaInBytes: 24_000_000,
      BinaryDataFactory: class {
        async fetch({ kind, filename }: { kind: string; filename: string }) {
          const folder = folders[kind];
          const url = folder && assets[`/node_modules/pdfjs-dist/${folder}/${filename}`];
          if (!url || filename.includes('/') || filename.includes('..')) throw new Error('PDF_RESOURCE_UNAVAILABLE');
          const response = await fetch(url, { signal, credentials: 'omit' });
          if (!response.ok) throw new Error('PDF_RESOURCE_UNAVAILABLE');
          return new Uint8Array(await response.arrayBuffer());
        }
      },
    });
    this.loading.onPassword = () => { this.destroy(); };
    this.document = await this.loading.promise;
    if (this.disposed) throw new DOMException('Aborted', 'AbortError');
    this.pages = this.document.numPages;
    if (this.pages > 2000) throw new Error('PDF_PAGE_LIMIT');
  }

  async text(page: number): Promise<string> {
    const document = this.document;
    if (!document || this.disposed) throw new DOMException('Aborted', 'AbortError');
    const content = await (await document.getPage(page)).getTextContent();
    if (this.disposed) throw new DOMException('Aborted', 'AbortError');
    let text = '';
    for (const item of content.items) {
      if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
      if (text.length > 1_000_000) throw new Error('PDF_TEXT_LIMIT');
    }
    return text;
  }

  async render(pageNumber: number, container: HTMLElement, width: number, zoom: number, query: string): Promise<void> {
    const version = ++this.renderVersion;
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    const document = this.document;
    if (!document || this.disposed) return;
    if (this.pageNumber && this.pageNumber !== pageNumber) (await document.getPage(this.pageNumber)).cleanup();
    const page = await document.getPage(pageNumber);
    if (this.disposed || version !== this.renderVersion) return;
    this.pageNumber = pageNumber;
    const natural = page.getViewport({ scale: 1 });
    const scale = Math.min(width / natural.width, 1.6) * zoom;
    const viewport = page.getViewport({ scale });
    if (![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0 && value < 30_000)) throw new Error('PDF_PAGE_SIZE');
    const density = Math.min(devicePixelRatio || 1, 2, 4096 / viewport.width, 4096 / viewport.height,
      Math.sqrt(6_000_000 / (viewport.width * viewport.height)));
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * density));
    canvas.height = Math.max(1, Math.floor(viewport.height * density));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.setAttribute('aria-hidden', 'true');
    const layer = window.document.createElement('div');
    layer.className = 'reader-text-layer';
    const sheet = window.document.createElement('div');
    sheet.className = 'reader-pdf-page';
    sheet.style.width = `${viewport.width}px`;
    sheet.style.height = `${viewport.height}px`;
    sheet.style.setProperty('--total-scale-factor', String(scale));
    sheet.append(canvas, layer);
    container.replaceChildren(sheet);
    this.canvas = canvas;
    this.renderTask = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0], annotationMode: 0 });
    await this.renderTask.promise;
    if (this.disposed || version !== this.renderVersion) return;
    const content = await page.getTextContent();
    if (this.disposed || version !== this.renderVersion) return;
    this.textLayer = new TextLayer({ textContentSource: content, container: layer, viewport });
    await this.textLayer.render();
    if (this.disposed || version !== this.renderVersion) return;
    if (query) for (const span of this.textLayer.textDivs) {
      if (span.textContent?.toLocaleLowerCase().includes(query.toLocaleLowerCase())) span.classList.add('reader-match');
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderVersion++;
    this.fetchAbort.abort();
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    void this.loading?.destroy().catch(() => undefined);
    TextLayer.cleanup();
    this.worker.destroy();
    this.port.terminate();
    this.document = undefined;
    this.textLayer = undefined;
    this.canvas = undefined;
  }
}
