import { describe, expect, it } from 'vitest';
import { latestPaint } from '../src/lib/latest-paint';

describe('task capsule state delivery', () => {
  it('paints only the latest state and discards intermediate progress', () => {
    const frames: (() => void)[] = [], seen: string[] = [];
    const view = latestPaint<string>(s => seen.push(s), fn => { frames.push(fn); return frames.length; }, () => {});
    view.update('download'); view.update('encrypt'); view.update('upload');
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(seen).toEqual(['upload']);
  });
  it('immediately shows terminal failure and cannot repaint stale progress afterwards', () => {
    const frames: (() => void)[] = [], seen: string[] = [];
    const view = latestPaint<string>(s => seen.push(s), fn => { frames.push(fn); return 1; }, () => {});
    view.update('download'); view.update('failed', true); frames.shift()!();
    expect(seen).toEqual(['failed']);
    view.update('retry'); view.dispose(); frames.shift()!();
    expect(seen).toEqual(['failed']);
  });
});
