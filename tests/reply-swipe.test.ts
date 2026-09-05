import { describe, expect, it } from 'vitest';
import { REPLY_SWIPE_MAX_OFFSET_PX, REPLY_SWIPE_THRESHOLD_PX, replySwipeOffset } from '../src/lib/reply-swipe';

describe('reply swipe resistance', () => {
  it('is monotonic, bounded and has visible resistance at the activation distance', () => {
    const samples = [0, 8, 24, 48, REPLY_SWIPE_THRESHOLD_PX, 160, 1000].map(replySwipeOffset);
    expect(samples[0]).toBe(0);
    expect(samples.every((sample, index) => index === 0 || sample >= samples[index - 1]!)).toBe(true);
    expect(samples.at(-1)).toBeLessThanOrEqual(REPLY_SWIPE_MAX_OFFSET_PX);
    expect(samples[4]).toBeGreaterThan(48);
    expect(samples[4]).toBeLessThan(REPLY_SWIPE_MAX_OFFSET_PX);
  });

  it('fails closed for rightward and non-finite input', () => {
    expect(replySwipeOffset(-100)).toBe(0);
    expect(replySwipeOffset(Number.NaN)).toBe(0);
  });
});
