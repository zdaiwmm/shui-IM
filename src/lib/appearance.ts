export const THEMES = [
  { id: 'blue', name: '默认蓝', color: 'oklch(48% .2 254)' },
  { id: 'green', name: '松绿', color: 'oklch(44% .12 155)' },
  { id: 'purple', name: '雾紫', color: 'oklch(50% .16 300)' },
  { id: 'apricot', name: '暖杏', color: 'oklch(49% .12 58)' },
] as const;
export type Theme = typeof THEMES[number]['id'];
export const THEME_KEY = 'quiet-room:appearance';
export function readTheme(storage: Pick<Storage, 'getItem'>): Theme {
  try { const value = storage.getItem(THEME_KEY); return THEMES.find(theme => theme.id === value)?.id ?? 'blue'; }
  catch { return 'blue'; }
}
export function saveTheme(storage: Pick<Storage, 'setItem'>, value: Theme): void {
  if (!THEMES.some(theme => theme.id === value)) throw new Error('请选择有效的主题');
  storage.setItem(THEME_KEY, value);
}
let mounted = false;
export function mountAppearance(): void {
  if (mounted) return;
  mounted = true;
  const sync = () => { document.documentElement.dataset.theme = readTheme(localStorage); };
  sync();
  window.addEventListener('storage', event => { if (event.key === THEME_KEY || event.key === null) sync(); });
}
