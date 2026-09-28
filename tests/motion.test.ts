import { describe, expect, it } from 'vitest';
import { dampedStep } from '../src/lib/motion';

describe('gesture damping', () => {
  it('converges monotonically from rest without crossing the target', () => {
    let state = { position: 80, velocity: 0 };
    for (let frame = 0; frame < 60; frame++) {
      const next = dampedStep(state.position, state.velocity, 0, 1 / 60);
      expect(next.position).toBeGreaterThanOrEqual(0);
      expect(next.position).toBeLessThanOrEqual(state.position);
      state = next;
    }
    expect(state.position).toBeLessThan(.001);
  });
  it('preserves velocity when reversing the target and is frame-rate independent', () => {
    const first = dampedStep(0, 0, 100, .12);
    const reversed = dampedStep(first.position, first.velocity, 0, .001);
    expect(reversed.position).toBeGreaterThan(first.position);
    const whole = dampedStep(80, -20, 0, .3);
    let split = { position: 80, velocity: -20 };
    for (let index = 0; index < 36; index++) split = dampedStep(split.position, split.velocity, 0, 1 / 120);
    expect(split.position).toBeCloseTo(whole.position, 8);
    expect(split.velocity).toBeCloseTo(whole.velocity, 8);
  });
});
