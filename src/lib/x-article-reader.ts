import { createElement, X } from 'lucide';
import { fromBase64Url } from './base64';
import { mountDialog } from './dialog';
import { uiLiteral } from './language';
import { newTabLink, webUrl } from './web-links';
import type { XArticle, XArticleRun } from './x-article-data.mjs';
import '../x-article-reader.css';

type ReaderOptions = {
  root: HTMLElement;
  origin: HTMLElement;
  title: string;
  sourceUrl: string;
  load: (signal: AbortSignal) => Promise<XArticle>;
  signal: AbortSignal;
  active: () => boolean;
};

const inlineStyles: ReadonlyArray<readonly [keyof Omit<XArticleRun, 'text' | 'href'>, keyof HTMLElementTagNameMap]> = [
  ['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strike', 's'], ['code', 'code'],
];

const headingTags: Record<2 | 3 | 4, 'h2' | 'h3' | 'h4'> = {
  2: 'h2', 3: 'h3', 4: 'h4',
};

function appendRuns(parent: HTMLElement, runs: readonly XArticleRun[]): void {
  let link: HTMLAnchorElement | undefined;
  for (const run of runs) {
    let content: Node = document.createTextNode(run.text);
    for (const [style, tag] of inlineStyles) {
      if (!run[style]) continue;
      const mark = document.createElement(tag);
      mark.append(content);
      content = mark;
    }
    const href = webUrl(run.href);
    if (!href) {
      link = undefined;
      parent.append(content);
    } else {
      if (link?.href !== href) {
        link = newTabLink(href);
        parent.append(link);
      }
      link.append(content);
    }
  }
}

function renderArticle(article: XArticle, imageUrls: Map<HTMLImageElement, string>): HTMLElement {
  const content = document.createElement('article');
  content.className = 'x-article-reader-content';
  content.dir = 'auto';
  const heading = document.createElement('h1');
  heading.textContent = article.title;
  const author = document.createElement('p');
  author.className = 'x-article-reader-byline';
  author.textContent = article.author;
  const body = document.createElement('div');
  body.className = 'x-article-reader-body';
  content.append(heading, author, body);

  type ListLevel = { list: HTMLOListElement | HTMLUListElement; depth: number; ordered: boolean; item: HTMLLIElement };
  const levels: ListLevel[] = [];
  for (const block of article.blocks) {
    if (block.kind === 'list-item') {
      while ((levels.at(-1)?.depth ?? -1) > block.depth) levels.pop();
      const previous = levels.at(-1);
      const item = document.createElement('li');
      if (previous?.depth === block.depth && previous.ordered === block.ordered) {
        previous.list.append(item);
        previous.item = item;
      } else {
        if (previous?.depth === block.depth) levels.pop();
        const list = document.createElement(block.ordered ? 'ol' : 'ul');
        const parent = levels.at(-1)?.item ?? body;
        parent.append(list);
        list.append(item);
        levels.push({ list, depth: block.depth, ordered: block.ordered, item });
      }
      item.dir = 'auto';
      appendRuns(item, block.runs);
      continue;
    }
    levels.length = 0;
    if (block.kind === 'image') {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.alt = block.alt;
      image.width = block.image.width;
      image.height = block.image.height;
      image.loading = 'lazy';
      image.decoding = 'async';
      const url = URL.createObjectURL(new Blob([fromBase64Url(block.image.data)], { type: block.image.mimeType }));
      imageUrls.set(image, url);
      image.src = url;
      figure.append(image);
      if (block.caption) {
        const caption = document.createElement('figcaption');
        caption.dir = 'auto';
        caption.textContent = block.caption;
        figure.append(caption);
      }
      body.append(figure);
    } else if (block.kind === 'divider') {
      body.append(document.createElement('hr'));
    } else if (block.kind === 'link') {
      const href = webUrl(block.href);
      if (!href) continue;
      const link = newTabLink(href);
      link.className = 'x-article-embed-link';
      link.dir = 'auto';
      link.textContent = block.label;
      body.append(link);
    } else {
      const tag = block.kind === 'heading' ? headingTags[block.level]
        : block.kind === 'quote' ? 'blockquote' : block.kind === 'code' ? 'pre' : 'p';
      const paragraph = document.createElement(tag);
      paragraph.dir = 'auto';
      appendRuns(paragraph, block.runs);
      body.append(paragraph);
    }
  }
  return content;
}

export function openXArticleReader(options: ReaderOptions): (restoreFocus?: boolean) => void {
  const overlay = document.createElement('section');
  overlay.className = 'x-article-reader';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'X Article');

  const panel = document.createElement('div');
  panel.className = 'x-article-reader-panel';
  const header = document.createElement('header');
  header.className = 'x-article-reader-header';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'x-article-reader-close';
  close.setAttribute('aria-label', uiLiteral('关闭阅读器'));
  const icon = createElement(X);
  icon.setAttribute('aria-hidden', 'true');
  close.append(icon);
  const label = document.createElement('span');
  label.textContent = 'X Article';
  header.append(close, label);
  const scroll = document.createElement('div');
  scroll.className = 'x-article-reader-scroll';
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', uiLiteral('文章正文'));
  scroll.tabIndex = 0;
  panel.append(header, scroll);
  overlay.append(panel);

  const lifecycle = new AbortController();
  const signal = AbortSignal.any([options.signal, lifecycle.signal]);
  const imageUrls = new Map<HTMLImageElement, string>();
  const live = () => !signal.aborted && options.active() && overlay.isConnected;

  const releaseImages = () => {
    for (const [image, url] of imageUrls) {
      image.removeAttribute('src');
      URL.revokeObjectURL(url);
    }
    imageUrls.clear();
  };

  function showFeedback(state: 'loading' | 'error' | 'empty'): void {
    const feedback = document.createElement('div');
    feedback.className = 'x-article-reader-feedback';
    if (options.title) {
      const title = document.createElement('h1');
      title.textContent = options.title;
      title.dir = 'auto';
      feedback.append(title);
    }
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = state === 'loading' ? uiLiteral('正在载入文章…')
      : state === 'error' ? uiLiteral('暂时无法读取全文') : uiLiteral('这篇文章没有可显示的正文');
    feedback.append(status);
    if (state !== 'loading') {
      const actions = document.createElement('div');
      actions.className = 'x-article-reader-actions';
      if (state === 'error') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = uiLiteral('重试');
        retry.addEventListener('click', () => { void load(); }, { signal });
        actions.append(retry);
      }
      const sourceUrl = webUrl(options.sourceUrl);
      if (sourceUrl) {
        const original = newTabLink(sourceUrl);
        original.textContent = uiLiteral('查看原文');
        actions.append(original);
      }
      feedback.append(actions);
    }
    const moveFocus = scroll.contains(document.activeElement) && document.activeElement !== scroll;
    scroll.replaceChildren(feedback);
    if (moveFocus) scroll.focus({ preventScroll: true });
  }

  async function load(): Promise<void> {
    if (!live() || scroll.getAttribute('aria-busy') === 'true') return;
    showFeedback('loading');
    scroll.setAttribute('aria-busy', 'true');
    try {
      const article = await options.load(signal);
      if (!live()) return;
      if (!article.blocks.length) {
        showFeedback('empty');
      } else {
        scroll.replaceChildren(renderArticle(article, imageUrls));
      }
    } catch {
      if (!live()) return;
      releaseImages();
      showFeedback('error');
    } finally {
      if (live()) scroll.removeAttribute('aria-busy');
    }
  }

  options.root.append(overlay);
  const dialog = mountDialog(overlay, {
    isActive: options.active,
    signal: options.signal,
    returnFocus: options.origin,
    initialFocus: close,
    onClose: () => {
      lifecycle.abort();
      releaseImages();
      scroll.replaceChildren();
    },
  });
  close.addEventListener('click', () => dialog.close(), { signal });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) dialog.close();
  }, { signal });
  void load();
  return (restoreFocus = true) => {
    if (restoreFocus) dialog.close();
    else dialog.dispose();
  };
}
