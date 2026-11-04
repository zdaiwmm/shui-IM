import { layoutViewport } from './form-input';

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
  const height = Math.max(1, visibleBottom - visibleTop);
  const span = `${height}px`;
  // Rows are ordered. Include the preceding bubble (which may be tall)
  // and a viewport of overscan for arrival and keyboard animations.
  let low = 0;
  let high = bubbles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (top(bubbles[middle]!) < start - height) low = middle + 1;
    else high = middle;
  }
  // Read all geometry before changing inherited styles in the message list.
  const visible: { bubble: HTMLElement; offset: string }[] = [];
  for (let index = Math.max(0, low - 1); index < bubbles.length; index += 1) {
    const bubble = bubbles[index]!;
    const position = top(bubble);
    if (position > start + height * 2) break;
    visible.push({ bubble, offset: `${start - position}px` });
  }
  for (const { bubble, offset } of visible) {
    if (bubble.style.getPropertyValue('--bubble-gradient-span') !== span) bubble.style.setProperty('--bubble-gradient-span', span);
    if (bubble.style.getPropertyValue('--bubble-gradient-offset') !== offset) bubble.style.setProperty('--bubble-gradient-offset', offset);
  }
}
