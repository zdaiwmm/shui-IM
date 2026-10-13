import { layoutViewport } from './form-input';
/** Presentation only: adjacency never changes message identity or delivery state. */
export function syncChatBubbleStyle(list: HTMLElement): void {
  for (const row of list.children) {
    if (!(row instanceof HTMLElement) || !row.classList.contains('message')) continue;
    const side = row.classList.contains('outgoing') ? 'outgoing' : 'incoming';
    const joins = (other: Element | null) => Boolean(other?.classList.contains('message') && other.classList.contains(side));
    const before = joins(row.previousElementSibling);
    const after = joins(row.nextElementSibling);
    const group = before ? (after ? 'middle' : 'end') : (after ? 'start' : 'single');
    if (row.dataset.messageGroup !== group) row.dataset.messageGroup = group;
  }
}

/** One field over the currently visible conversation, independent of how much
 * history is mounted. Layout offsets keep message-arrival transforms separate. */
export function syncChatBubbleGradient(list: HTMLElement): void {
  const bubbles = [...list.querySelectorAll<HTMLElement>('.outgoing > .message-bubble:not(.expression-bubble)')];
  if (!bubbles.length) return;
  const top = (bubble: HTMLElement) => bubble.parentElement!.offsetTop + bubble.offsetTop;
  const shell = list.closest('.chat-shell');
  const viewport = layoutViewport();
  const bounds = list.getBoundingClientRect();
  const visibleTop = Math.max(bounds.top, viewport?.offsetTop ?? 0,
    shell?.querySelector('.chat-header')?.getBoundingClientRect().bottom ?? 0);
  const visibleBottom = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
    shell?.querySelector('.composer')?.getBoundingClientRect().top ?? Infinity);
  const start = visibleTop - bounds.top + list.scrollTop;
  const span = `${Math.max(1, visibleBottom - visibleTop)}px`;
  for (const bubble of bubbles) {
    const offset = `${start - top(bubble)}px`;
    if (bubble.style.getPropertyValue('--bubble-gradient-span') !== span) bubble.style.setProperty('--bubble-gradient-span', span);
    if (bubble.style.getPropertyValue('--bubble-gradient-offset') !== offset) bubble.style.setProperty('--bubble-gradient-offset', offset);
  }
}

type Box = { left: number; top: number; width: number; height: number };

/** Keep the selected preview between reactions and a scrollable action list.
 * On short keyboard viewports, clip only the inert preview, never the source. */
export function messageActionLayout(viewport: Box, bubble: Box, pickerHeight: number, menuHeight: number) {
  const edge = 8;
  const gap = 8;
  const pickerSpace = pickerHeight ? pickerHeight + gap : 0;
  const available = Math.max(1, viewport.height - edge * 2 - pickerSpace - gap);
  const minimumMenu = Math.min(44, available / 2);
  const full = bubble.height + menuHeight <= available;
  const previewHeight = Math.min(bubble.height, full ? bubble.height : Math.max(1, Math.min(available - minimumMenu, viewport.height * .4)));
  const listHeight = Math.max(1, Math.min(menuHeight, available - previewHeight));
  const firstTop = viewport.top + edge + pickerSpace;
  const lastTop = viewport.top + viewport.height - edge - gap - listHeight - previewHeight;
  const previewTop = Math.max(firstTop, Math.min(bubble.top, lastTop));
  return { previewTop, previewHeight, pickerTop: previewTop - pickerSpace, listTop: previewTop + previewHeight + gap, listHeight };
}
