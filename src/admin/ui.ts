import { createElement, ArrowLeft, ArrowRight, ChevronsLeft, ChevronsRight, Inbox, RefreshCw, CircleAlert } from 'lucide';

export type Tone = 'success' | 'warning' | 'muted' | 'danger';
export function iconButton(label: string, icon: typeof RefreshCw, action: () => void) {
  const button = document.createElement('button');
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.className = 'icon-button';
  const graphic = createElement(icon); graphic.setAttribute('aria-hidden', 'true');
  button.append(graphic); button.addEventListener('click', action);
  return button;
}

export function badge(label: string, tone: Tone = 'muted') {
  const element = document.createElement('span'); element.className = `status-badge ${tone}`; element.textContent = label;
  return element;
}

export function pageToolbar(title: string, description = '', action?: { label: string; icon: typeof RefreshCw; run: () => void }) {
  const toolbar = document.createElement('div'); toolbar.className = 'page-toolbar';
  const copy = document.createElement('div'); const heading = document.createElement('h2'); heading.textContent = title; copy.append(heading);
  if (description) { const detail = document.createElement('p'); detail.textContent = description; copy.append(detail); }
  toolbar.append(copy);
  if (action) toolbar.append(iconButton(action.label, action.icon, action.run));
  return toolbar;
}

export function table(headers: string[]) {
  const wrapper = document.createElement('div'); wrapper.className = 'table-scroll';
  const element = document.createElement('table'); const head = element.createTHead().insertRow();
  for (const title of headers) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = title; head.append(th); }
  const body = element.createTBody(); wrapper.append(element);
  return { wrapper, body };
}

export function row(body: HTMLTableSectionElement, values: (string | number | HTMLElement)[]) {
  const tr = body.insertRow();
  const headers = body.closest('table')!.querySelectorAll('th');
  values.forEach((value, index) => {
    const cell = tr.insertCell(); cell.dataset.label = headers[index]?.textContent ?? '';
    if (value instanceof HTMLElement) cell.append(value); else cell.textContent = String(value);
  });
  return tr;
}

export function emptyState(message: string) {
  const element = document.createElement('div'); element.className = 'empty-state';
  const icon = createElement(Inbox); icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('p'); text.textContent = message; element.append(icon, text);
  return element;
}

export function loadingState(label: string) {
  const element = document.createElement('div'); element.className = 'loading-state'; element.setAttribute('role', 'status');
  const text = document.createElement('span'); text.textContent = label; element.append(text);
  for (let i = 0; i < 4; i++) { const line = document.createElement('div'); line.className = 'skeleton-line'; line.setAttribute('aria-hidden', 'true'); element.append(line); }
  return element;
}

export function errorState(error: unknown, retry: () => void) {
  const element = document.createElement('div'); element.className = 'error-state'; element.setAttribute('role', 'alert');
  const icon = createElement(CircleAlert); icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('p'); text.textContent = error instanceof Error ? error.message : '读取失败';
  element.append(icon, text, iconButton('重试', RefreshCw, retry)); return element;
}

export function pagination(options: { page: number; total?: number; pageSize: number; hasNext?: boolean; label: string; change: (page: number) => void }) {
  const { page, total, pageSize, change } = options;
  const pages = total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize));
  const nav = document.createElement('nav'); nav.className = 'actions pagination'; nav.setAttribute('aria-label', options.label);
  const first = iconButton('首页', ChevronsLeft, () => change(1)); first.disabled = page === 1;
  const previous = iconButton('上一页', ArrowLeft, () => change(page - 1)); previous.disabled = page === 1;
  const next = iconButton('下一页', ArrowRight, () => change(page + 1)); next.disabled = pages === undefined ? !options.hasNext : page >= pages;
  const count = document.createElement('span'); count.className = 'page-count';
  count.textContent = pages === undefined ? `第 ${page} 页` : `第 ${page} / ${pages} 页 · 共 ${total} 项`;
  nav.append(first, previous, count, next);
  if (pages !== undefined) {
    const last = iconButton('尾页', ChevronsRight, () => change(pages)); last.disabled = page === pages; nav.append(last);
    const jump = document.createElement('form'); jump.className = 'page-jump';
    const label = document.createElement('label'); label.textContent = '跳至';
    const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.max = String(pages); input.step = '1'; input.required = true; input.value = String(page); input.setAttribute('aria-label', '指定页码'); label.append(input);
    const go = iconButton('跳转', ArrowRight, () => {}); go.type = 'submit'; jump.append(label, go);
    jump.addEventListener('submit', event => { event.preventDefault(); const target = input.valueAsNumber; if (Number.isSafeInteger(target) && target >= 1 && target <= pages && target !== page) change(target); });
    nav.append(jump);
  }
  return nav;
}
