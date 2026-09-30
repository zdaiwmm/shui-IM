import { describe, expect, it } from 'vitest';
import { PrivacySurface, type PrivacyHold } from '../src/lib/privacy-surface';

const clock = (monotonic: number, wall = monotonic) => ({ monotonic, wall });
const owner: PrivacyHold = { owner: 'picker', epoch: 1, deadline: 100, wallDeadline: 100 };
describe('privacy surface return gate', () => {
  it('keeps an owned operation covered until completion and actual foreground', () => {
    const surface = new PrivacySurface();
    surface.conceal(owner, clock(0));
    expect(surface.resume(1, false, true, false, clock(1))).toBe(false);
    expect(surface.resume(1, true, false, false, clock(2))).toBe(false);
    expect(surface.hold?.owner).toBe('picker');
    expect(surface.resume(1, true, true, false, clock(3))).toBe(true);
  });
  it('never extends ownership on repeated blur or accepts results from another runtime', () => {
    const surface = new PrivacySurface();
    surface.conceal(owner, clock(0));
    surface.conceal({ ...owner, deadline: 1000, wallDeadline: 1000 }, clock(50));
    expect(surface.hold?.deadline).toBe(100);
    expect(surface.resume(2, true, true, false, clock(51))).toBe(false);
    expect(surface.resume(1, true, true, false, clock(100))).toBe(false);
  });
  it('checks both absolute clocks when timeout tasks have not run', () => {
    for (const now of [clock(101, 1), clock(1, 101)]) {
      const surface = new PrivacySurface();
      surface.conceal(owner, clock(0));
      expect(surface.resume(1, true, true, false, now)).toBe(false);
    }
  });
  it('requires the existing user continuation gesture for an unowned return', () => {
    const surface = new PrivacySurface();
    surface.conceal({ ...owner, owner: 'unknown' }, clock(0));
    expect(surface.resume(1, true, true, false, clock(1))).toBe(false);
    expect(surface.resume(1, true, false, true, clock(2))).toBe(true);
  });
  it('locks without retaining a pending owner and bounds redacted diagnostics', () => {
    const surface = new PrivacySurface();
    for (let i = 0; i < 100; i++) surface.conceal(owner, clock(i));
    surface.lock(clock(101));
    expect(surface.hold).toBeNull();
    expect(surface.diagnostics()).toHaveLength(64);
    expect(Object.keys(surface.diagnostics()[0]!)).toEqual(['event', 'owner', 'at']);
  });
});
