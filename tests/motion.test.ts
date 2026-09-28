import { describe, expect, it } from 'vitest';
import { dampedStep, dismissDraggedPanel, layoutMotionDuration, travelFrames } from '../src/lib/motion';

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

describe('motion completion policies', () => {
  it('distinguishes flick, deliberate pull, pause and reversal', () => {
    expect(dismissDraggedPanel(20, 600, 500)).toBe(true);
    expect(dismissDraggedPanel(4, 900, 500)).toBe(false);
    expect(dismissDraggedPanel(55, 0, 500)).toBe(false);
    expect(dismissDraggedPanel(110, 0, 500)).toBe(true);
    expect(dismissDraggedPanel(110, -200, 500)).toBe(false);
  });
  it('settles shorter and repeated layout travel sooner while bounding long content', () => {
    expect(layoutMotionDuration(20)).toBeLessThan(layoutMotionDuration(200));
    expect(layoutMotionDuration(80, true)).toBeLessThan(layoutMotionDuration(80));
    expect(layoutMotionDuration(4000)).toBeLessThanOrEqual(320);
  });
  it('starts a reversal with the current direction, then arrives exactly at rest', () => {
    const frames = travelFrames(100, 0, 300, 240);
    expect(frames[0]).toBe(100);
    expect(frames[1]).toBeGreaterThan(100);
    expect(frames.at(-1)).toBe(0);
    expect(Math.abs(frames.at(-1)! - frames.at(-2)!)).toBeLessThan(1);
  });
});
