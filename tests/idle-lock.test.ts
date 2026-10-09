import { describe, it, expect } from 'vitest';
import { IdleLease, IDLE_DURATIONS, IDLE_WARNING_MS, idleSeconds, readIdleSeconds, saveIdleSeconds } from '../src/lib/idle-lock';
function fixture() {
  const now = { wall: 100_000, monotonic: 1000 };
  const lease = new IdleLease(() => ({ ...now }));
  const advance = (ms: number) => { now.wall += ms; now.monotonic += ms; };
  return { lease, now, advance };
}
describe('global idle authority', () => {
  it.each(IDLE_DURATIONS)('starts / renews %s seconds without accumulation', seconds => {
    const { lease, advance } = fixture(); lease.start(seconds);
    expect(lease.remaining).toBe(seconds * 1000); advance(1000);
    expect(lease.renew(seconds)).toBe(true); expect(lease.remaining).toBe(seconds * 1000);
    expect(IDLE_WARNING_MS).toBe(10_000);
  });
  it.each(['wall', 'monotonic'] as const)('expires with either %s clock and rejects late extension / media', clock => {
    const { lease, now } = fixture(); lease.start(60); now[clock] += 60_000;
    expect(lease.expired).toBe(true); expect(lease.renew(300)).toBe(false);
    expect(lease.setPersistentUse(true, 300)).toBe(false);
  });
  it('wall clock rollback cannot extend a lease', () => {
    const { lease, now } = fixture(); lease.start(60); now.wall -= 100_000; now.monotonic += 60_000;
    expect(lease.expired).toBe(true);
  });
  it('pauses actual persistent use, then starts the configured duration on stop', () => {
    const { lease, advance } = fixture(); lease.start(30); advance(20_000);
    lease.setPersistentUse(true, 30); advance(300_000); expect(lease.expired).toBe(false);
    lease.setPersistentUse(false, 120); expect(lease.remaining).toBe(120_000);
    advance(120_000); expect(lease.expired).toBe(true);
  });
  it('fixed exposure cap wins over renewal and persistent media', () => {
    const { lease, advance } = fixture(); lease.start(300); lease.limitExposure(60_000);
    expect(lease.renewable).toBe(false); advance(51_000); lease.renew(300);
    expect(lease.remaining).toBe(9000); lease.setPersistentUse(true, 300);
    advance(9000); expect(lease.expired).toBe(true);
  });
  it('short idle limit is renewable while a later exposure cap is not extended', () => {
    const { lease, advance } = fixture(); lease.start(30); lease.limitExposure(60_000); advance(21_000);
    expect(lease.renewable).toBe(true); lease.renew(30); advance(21_000); lease.renew(30);
    expect(lease.remaining).toBe(18_000); expect(lease.renewable).toBe(false);
    lease.clearExposureLimit(); expect(lease.remaining).toBe(30_000);
  });
  it('clear revokes paused state and caps, and late operations cannot reactivate', () => {
    const { lease } = fixture(); lease.start(60); lease.setPersistentUse(true, 60); lease.limitExposure(60_000); lease.clear();
    expect(lease.renew(60)).toBe(false); expect(lease.setPersistentUse(true, 60)).toBe(false);
    lease.start(120); expect(lease.remaining).toBe(120_000); expect(lease.paused).toBe(false);
  });
  it('invalid / unavailable preference falls back to 60; failed saves do not change the caller value', () => {
    for (const value of [null, '', 'never', 0, 10, 31, 600, NaN]) expect(idleSeconds(value)).toBe(60);
    expect(readIdleSeconds({ getItem() { throw Error('denied'); } })).toBe(60);
    const values = new Map<string, string>(); const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k,v); } };
    saveIdleSeconds(storage, 120); expect(readIdleSeconds(storage)).toBe(120);
    expect(() => saveIdleSeconds({ setItem() { throw Error('quota'); } }, 300)).toThrow('quota');
    expect(readIdleSeconds(storage)).toBe(120);
  });
});
