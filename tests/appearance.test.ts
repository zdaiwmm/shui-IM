import { describe, expect, it } from 'vitest';
import { readTheme, saveTheme, THEME_KEY } from '../src/lib/appearance';
describe('local appearance preference', () => {
  it('keeps the original palette for unavailable or malformed storage', () => {
    expect(readTheme({ getItem: () => 'untrusted-value' })).toBe('blue');
    expect(readTheme({ getItem() { throw Error('unavailable'); } })).toBe('blue');
  });
  it('persists an explicit choice without changing it after a failed write', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveTheme(storage, 'green'); expect(values.get(THEME_KEY)).toBe('green');
    expect(() => saveTheme({ setItem() { throw Error('denied'); } }, 'purple')).toThrow('denied');
    expect(readTheme(storage)).toBe('green');
  });
});
