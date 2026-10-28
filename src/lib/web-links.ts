export type WebLink = { text: string; url: string; start: number; end: number };

export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(/^www\./i.test(value) ? `https://${value}` : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
    return url.href;
  } catch { return null; }
}

export function findWebLinks(text: string): WebLink[] {
  const result: WebLink[] = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'，。；：！？、）】》」』\u0000-\u001f]+/gi;
  for (const match of text.matchAll(pattern)) {
    if (match.index && /[\w@.-]/.test(text[match.index - 1]!)) continue;
    let candidate = match[0].replace(/[.,;:!?，。；：！？、）】》」』]+$/u, '');
    while (candidate.endsWith(')') && candidate.split(')').length > candidate.split('(').length) candidate = candidate.slice(0, -1);
    while (candidate.endsWith(']') && candidate.split(']').length > candidate.split('[').length) candidate = candidate.slice(0, -1);
    const url = webUrl(candidate);
    if (url) result.push({ text: candidate, url, start: match.index, end: match.index + candidate.length });
  }
  return result;
}

export function previewableUrl(value: string): string | null {
  const normalized = webUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  // Never send application capabilities or known secret-bearing URLs to a fetcher.
  if (url.hash || /(?:localhost|\.local|\.internal|\.localhost|\.test|\.invalid)$/i.test(url.hostname)
    || /^(?:\d+\.){3}\d+$/.test(url.hostname)
    || [...url.searchParams.keys()].some(key => /token|secret|password|recovery|invite|mnemonic|(?:^|_)key|credential|proof/i.test(key))
    || /(?:invite|recovery|device-link|repair-link|browser-access|short-invite)/i.test(url.pathname)
    || /(?:^|\.)(?:ai\.shui\.click|mijiu\.cloud)$/i.test(url.hostname) && (url.search || url.pathname !== '/')) return null;
  return url.href;
}

export function firstPreviewUrl(text: string): string | null {
  for (const link of findWebLinks(text)) {
    const url = previewableUrl(link.url);
    if (url) return url;
  }
  return null;
}

export function newTabLink(url: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.referrerPolicy = 'no-referrer';
  return a;
}

export function renderLinkedText(element: HTMLElement, text: string): void {
  const nodes: Node[] = [];
  let offset = 0;
  for (const link of findWebLinks(text)) {
    nodes.push(document.createTextNode(text.slice(offset, link.start)));
    const a = newTabLink(link.url); a.textContent = link.text; a.className = 'message-web-link'; nodes.push(a);
    offset = link.end;
  }
  nodes.push(document.createTextNode(text.slice(offset)));
  element.replaceChildren(...nodes);
}
