export const THEMES = [
  { id: 'blue', name: '经典', color: '#89be87' },
  { id: 'green', name: '松绿', color: 'oklch(43% .085 175)' },
  { id: 'purple', name: '雾紫', color: 'oklch(46% .085 305)' },
  { id: 'apricot', name: '暖杏', color: 'oklch(49% .12 58)' },
  { id: 'sea', name: '海盐', color: 'oklch(46% .13 245)' },
  { id: 'rose', name: '玫瑰', color: 'oklch(45% .13 355)' },
  { id: 'terracotta', name: '赤陶', color: 'oklch(46% .13 35)' },
  { id: 'lemon', name: '柠黄', color: 'oklch(85% .17 100)' },
  { id: 'graphite', name: '石墨', color: 'oklch(42% .006 255)' },
] as const;
export type Theme = typeof THEMES[number]['id'];
export const THEME_KEY = 'quiet-room:appearance';
export const COLOR_SCHEME_KEY = 'quiet-room:color-scheme';
export const COLOR_SCHEMES = ['system', 'light', 'dark'] as const;
export type ColorSchemePreference = typeof COLOR_SCHEMES[number];
export function readColorScheme(storage: Pick<Storage, 'getItem'>): ColorSchemePreference {
  try { const value = storage.getItem(COLOR_SCHEME_KEY); return COLOR_SCHEMES.find(item => item === value) ?? 'system'; }
  catch { return 'system'; }
}
export function saveColorScheme(storage: Pick<Storage, 'setItem'>, value: ColorSchemePreference): void {
  if (!COLOR_SCHEMES.includes(value)) throw new Error('请选择有效的明暗模式');
  storage.setItem(COLOR_SCHEME_KEY, value);
}
export function resolveColorScheme(value: ColorSchemePreference, systemDark: boolean): 'light' | 'dark' {
  return value === 'system' ? systemDark ? 'dark' : 'light' : value;
}
export function readTheme(storage: Pick<Storage, 'getItem'>): Theme {
  try { const value = storage.getItem(THEME_KEY); return THEMES.find(theme => theme.id === value)?.id ?? 'blue'; }
  catch { return 'blue'; }
}
export function saveTheme(storage: Pick<Storage, 'setItem'>, value: Theme): void {
  if (!THEMES.some(theme => theme.id === value)) throw new Error('请选择有效的主题');
  storage.setItem(THEME_KEY, value);
}
let mounted = false;
let systemScheme: MediaQueryList | undefined;
const systemQuery = () => systemScheme ??= matchMedia('(prefers-color-scheme: dark)');
/** One effective scheme owns CSS and native form controls, without rerendering private content. */
export function applyAppearance(): void {
  let theme: Theme = 'blue', preference: ColorSchemePreference = 'system';
  try { theme = readTheme(localStorage); preference = readColorScheme(localStorage); } catch { /* Storage can be unavailable before getItem. */ }
  const root = document.documentElement;
  // Read the same query we observe. A fresh query can see an intermediate OS
  // value while the observed query coalesces changes back to its previous value.
  const scheme = resolveColorScheme(preference, systemQuery().matches);
  const changed = root.dataset.theme !== theme || root.dataset.colorScheme !== scheme || root.dataset.colorSchemePreference !== preference;
  root.dataset.theme = theme;
  root.dataset.colorSchemePreference = preference;
  root.dataset.colorScheme = scheme;
  root.style.colorScheme = scheme;
  if (changed) window.dispatchEvent(new Event('appearancechange'));
}
export function mountAppearance(): void {
  if (mounted) return;
  mounted = true;
  applyAppearance();
  systemQuery().addEventListener('change', applyAppearance);
  window.addEventListener('storage', event => { if (event.key === THEME_KEY || event.key === COLOR_SCHEME_KEY || event.key === null) applyAppearance(); });
}
