export { syncChatBubbleGradient } from './chat-bubble-gradient';

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
