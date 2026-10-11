import { describe, expect, it } from 'vitest';
import { readTheme, saveTheme, THEME_KEY, COLOR_SCHEME_KEY, readColorScheme, saveColorScheme, resolveColorScheme } from '../src/lib/appearance';
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
  it('defaults old, malformed and inaccessible brightness preferences to system', () => {
    for (const value of [null, 'automatic', '', 'DARK']) expect(readColorScheme({ getItem: () => value })).toBe('system');
    expect(readColorScheme({ getItem() { throw Error('unavailable'); } })).toBe('system');
    expect(resolveColorScheme('system', false)).toBe('light');
    expect(resolveColorScheme('system', true)).toBe('dark');
    expect(resolveColorScheme('dark', false)).toBe('dark');
    expect(resolveColorScheme('light', true)).toBe('light');
  });
  it('persists brightness independently from palette and preserves it after failed writes', () => {
    const values = new Map<string, string>([[THEME_KEY, 'green']]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    saveColorScheme(storage, 'dark');
    expect(values.get(COLOR_SCHEME_KEY)).toBe('dark'); expect(readTheme(storage)).toBe('green');
    expect(() => saveColorScheme({ setItem() { throw Error('denied'); } }, 'light')).toThrow('denied');
    expect(readColorScheme(storage)).toBe('dark');
  });
});
