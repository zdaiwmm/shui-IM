import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopAccess, DESKTOP_RETURN_MS } from '../src/lib/desktop-access';
afterEach(() => vi.useRealTimers());
describe('page-memory desktop return authority', () => {
  function fixture() {
    vi.useFakeTimers();
    const now = { wall: 1000, monotonic: 1000 }, dispose = vi.fn((proof: Uint8Array) => proof.fill(0));
    const access = new DesktopAccess(() => now, dispose), proof = new Uint8Array([42]);
    access.hold(proof); return { now, access, proof, dispose };
  }
  it.each(['wall', 'monotonic'] as const)('rejects at 30 minutes with either %s clock, including suspension', clock => {
    const { now, access, proof, dispose } = fixture();
    now[clock] += DESKTOP_RETURN_MS - 1; expect(access.peek()).toBe(proof);
    now[clock]++; expect(access.peek()).toBeNull(); expect(proof[0]).toBe(0); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('clears secret bytes on expiry even without a user entry', () => {
    const { access, proof } = fixture(); vi.advanceTimersByTime(DESKTOP_RETURN_MS);
    expect(proof[0]).toBe(0); expect(access.peek()).toBeNull();
  });
  it('reading or rolling back wall time cannot extend the monotonic bound', () => {
    const { now, access } = fixture(); now.wall -= 100_000;
    for (let i = 0; i < 30; i++) { access.peek(); now.monotonic += 60_000; }
    expect(access.peek()).toBeNull();
  });
  it('hard invalidation wipes the proof and prevents any later entry', () => {
    const { access, proof, dispose } = fixture(); access.clear(); access.clear();
    expect(access.peek()).toBeNull(); expect(proof[0]).toBe(0); expect(dispose).toHaveBeenCalledTimes(1);
  });
});
