import { describe, expect, it } from 'vitest';
import { REPLY_SWIPE_THRESHOLD_PX, replySwipeMaxOffset, replySwipeOffset } from '../src/lib/reply-swipe';

describe('reply swipe resistance', () => {
  it('is monotonic, bounded and has visible resistance at the activation distance', () => {
    const maximum = replySwipeMaxOffset(390);
    const samples = [0, 8, 24, 48, REPLY_SWIPE_THRESHOLD_PX, 360, 1000]
      .map(distance => replySwipeOffset(distance, maximum));
    expect(samples[0]).toBe(0);
    expect(samples.every((sample, index) => index === 0 || sample >= samples[index - 1]!)).toBe(true);
    expect(samples.at(-1)).toBeLessThanOrEqual(maximum);
    expect(samples[4]).toBeLessThanOrEqual(REPLY_SWIPE_THRESHOLD_PX);
    expect(samples[4]).toBeLessThan(maximum);
    expect(samples[5]).toBeGreaterThan(samples[4]!);
    expect(replySwipeMaxOffset(390)).toBe(65);
    expect(replySwipeMaxOffset(430)).toBeCloseTo(71.667, 3);
    expect(samples[2]).toBeCloseTo(65 * Math.tanh(24 / 65), 5);
    expect(samples.at(-1)).toBeGreaterThan(64.9);
  });

  it('fails closed for rightward and non-finite input', () => {
    expect(replySwipeOffset(-100, 130)).toBe(0);
    expect(replySwipeOffset(Number.NaN, 130)).toBe(0);
    expect(replySwipeMaxOffset(Number.NaN)).toBe(0);
    expect(replySwipeOffset(100, 0)).toBe(0);
  });
});
