import { describe, expect, it } from 'vitest';
import { readBlankDoubleLock, saveBlankDoubleLock } from '../src/lib/blank-double-lock';

describe('device-local blank double-lock preference', () => {
  it('keeps the existing gesture for missing, invalid and unreadable preferences', () => {
    for (const value of [null, '', 'invalid', '1']) expect(readBlankDoubleLock({ getItem: () => value })).toBe(true);
    expect(readBlankDoubleLock({ getItem() { throw Error('denied'); } })).toBe(true);
  });
  it('only disables an explicitly saved zero, independently of other lock preferences', () => {
    const values = new Map<string, string>([['quiet-room:auto-lock-seconds', '0'], ['quiet-room:lock-on-hidden', '0']]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(readBlankDoubleLock(storage)).toBe(true);
    saveBlankDoubleLock(storage, false); expect(readBlankDoubleLock(storage)).toBe(false);
    saveBlankDoubleLock(storage, true); expect(readBlankDoubleLock(storage)).toBe(true);
    expect(values.get('quiet-room:lock-on-hidden')).toBe('0'); expect(values.get('quiet-room:auto-lock-seconds')).toBe('0');
  });
  it('reports a failed save without replacing the previous preference', () => {
    let value = '0';
    const storage = { getItem: () => value, setItem() { throw Error('quota'); } };
    expect(() => saveBlankDoubleLock(storage, true)).toThrow('quota');
    expect(readBlankDoubleLock(storage)).toBe(false);
  });
});
