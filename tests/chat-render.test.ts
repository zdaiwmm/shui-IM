import { afterEach, describe, expect, it, vi } from 'vitest';
import { resizeComposerOnInput, shouldClearSentReply } from '../src/lib/chat-composer-render';
import { syncChatBubbleGradient } from '../src/lib/chat-bubble-gradient';
import { messageLocalDay } from '../src/lib/chat-timeline-days';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('chat rendering on input and send', () => {
  it.each([
    // Minimum-height ordinary input, wrap, shrink, app IME, native IME, animation.
    [44, 44, false, false, false, false],
    [44, 52, false, false, false, true],
    [64, 44, false, false, false, true],
    [44, 44, true, false, false, true],
    [44, 44, false, true, false, true],
    [44, 44, false, false, true, true],
  ] as const)('measures height=%i scroll=%i appIME=%s nativeIME=%s animation=%s', (height, scroll, active, composing, animating, expected) => {
    class NativeInput extends Event { isComposing = composing; }
    vi.stubGlobal('InputEvent', NativeInput);
    vi.stubGlobal('getComputedStyle', () => ({ minHeight: '44px' }));
    const textarea = { offsetHeight: height, clientHeight: 44, scrollHeight: scroll } as HTMLTextAreaElement;
    const resize = vi.fn();
    resizeComposerOnInput(textarea, composing ? new NativeInput('input') : new Event('input'), active, animating, resize);
    expect(resize.mock.calls).toEqual(expected ? [[true, true, composing]] : []);
  });

  it('refreshes only the reply that was actually sent and is still selected', () => {
    const sent = { id: 'target' };
    expect(shouldClearSentReply(null, null)).toBe(false);
    expect(shouldClearSentReply(null, sent)).toBe(false);
    expect(shouldClearSentReply(sent, sent)).toBe(true);
    expect(shouldClearSentReply(sent, { ...sent })).toBe(false);
    expect(shouldClearSentReply(sent, null)).toBe(false);
  });

  it('measures the visible gradient band on a long list before writing bubble styles', () => {
    vi.stubGlobal('window', { visualViewport: null });
    vi.stubGlobal('innerHeight', 200);
    const updated = new Map<number, string>();
    let reads = 0;
    const bubbles = Array.from({ length: 1000 }, (_, index) => ({
      parentElement: { get offsetTop() {
        expect(updated.size).toBe(0);
        reads++;
        return index * 40;
      } },
      offsetTop: 0,
      style: {
        getPropertyValue: () => '',
        setProperty: (key: string, value: string) => { if (key === '--bubble-gradient-offset') updated.set(index, value); },
      },
    }));
    const list = { scrollTop: 20000, getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
      querySelectorAll: () => bubbles, closest: () => null } as unknown as HTMLElement;
    syncChatBubbleGradient(list);
    expect(updated.get(500)).toBe('0px');
    expect(updated.get(501)).toBe('-40px');
    expect(updated.has(0)).toBe(false);
    expect(updated.has(999)).toBe(false);
    expect(reads).toBeLessThan(50);
  });

  it('skips internationalized formatting for an already rendered day', () => {
    const first = messageLocalDay('2026-11-04T00:01:00', 2026)!;
    const format = vi.spyOn(Intl, 'DateTimeFormat');
    expect(messageLocalDay('2026-11-04T23:59:00', 2026, new Set([first.key]))).toBeNull();
    expect(messageLocalDay('invalid', 2026)).toBeNull();
    expect(format).not.toHaveBeenCalled();
    expect(messageLocalDay('2026-11-05T00:01:00', 2026, new Set([first.key]))?.key).toBe('2026-11-05');
  });
});
