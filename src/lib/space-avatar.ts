import legacyCatalog from './space-avatar-catalog.json';
import fluentCatalog from './fluent-avatar-catalog.json';
const catalog = [...legacyCatalog, ...fluentCatalog];

export const avatarEmoji = fluentCatalog;
export const avatarBackgrounds = [
  ['海蓝', '#59c6c4', '#538fd3'], ['青绿', '#62d4af', '#43a5b8'], ['草绿', '#bacb53', '#4eb76b'],
  ['紫罗兰', '#cc75be', '#8d63d6'], ['玫瑰', '#f39b6f', '#df5e9d'], ['落日', '#efa555', '#e87366'],
  ['暖金', '#efc454', '#ef9445'], ['雾灰', '#a8b7be', '#6f818e'],
] as const;
/** Private participant metadata only. Never a room identity or a remote URL. */
export type SpaceAvatar = { v: 1; kind: 'emoji'; emoji: string; background: number }
  | { v: 1; kind: 'image'; data: string };
export type SpaceProfile = { name: string; avatar: SpaceAvatar };
export const MAX_AVATAR_IMAGE_BYTES = 2048;
const ids = new Set(catalog.map(item => item.id));
export function validSpaceAvatar(value: unknown): value is SpaceAvatar {
  if (!value || typeof value !== 'object') return false;
  const avatar = value as SpaceAvatar;
  if (avatar.v !== 1) return false;
  if (avatar.kind === 'emoji') return Object.keys(avatar).sort().join(',') === 'background,emoji,kind,v'
    && ids.has(avatar.emoji) && Number.isInteger(avatar.background) && avatar.background >= 0 && avatar.background < avatarBackgrounds.length;
  return avatar.kind === 'image' && Object.keys(avatar).sort().join(',') === 'data,kind,v' && typeof avatar.data === 'string'
    && avatar.data.length <= 23 + 4 * Math.ceil(MAX_AVATAR_IMAGE_BYTES / 3)
    && (avatar.data.length - 23) * 3 / 4 - (avatar.data.match(/=+$/)?.[0].length ?? 0) <= MAX_AVATAR_IMAGE_BYTES
    && /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(avatar.data);
}
export const defaultSpaceAvatar = (): SpaceAvatar => ({ v: 1, kind: 'emoji', emoji: 'fluent-slightly_smiling_face', background: 0 });
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function spaceAvatarMarkup(avatar?: SpaceAvatar, name = '密室'): string {
  if (avatar?.kind === 'image' && validSpaceAvatar(avatar)) return `<span class="space-avatar is-image" aria-hidden="true"><img src="${avatar.data}" alt="" draggable="false"></span>`;
  if (avatar?.kind === 'emoji' && validSpaceAvatar(avatar)) {
    const item = catalog.find(item => item.id === avatar.emoji)!;
    const colors = avatarBackgrounds[avatar.background]!;
    return `<span class="space-avatar" style="--avatar-start:${colors[1]};--avatar-end:${colors[2]}" aria-hidden="true"><img data-avatar-emoji="${item.id}" src="/space-avatars/${item.id}-still.webp" alt="" draggable="false"></span>`;
  }
  return `<span class="space-avatar space-avatar-initial" aria-hidden="true">${escape(Array.from(name.trim())[0] ?? '空')}</span>`;
}
/** One observer for a surface. All visible grid cells play, including unselected ones. */
export function bindSpaceAvatarPlayback(host: HTMLElement, signal: AbortSignal): () => void {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const visible = new Set<HTMLElement>();
  const nodes = new Map<HTMLElement, HTMLImageElement>();
  const paint = () => {
    for (const [node, image] of nodes) {
      const id = image.dataset.avatarEmoji!;
      const playing = !signal.aborted && host.isConnected && !document.hidden && !preference.matches && visible.has(node) && !node.closest('[inert],[hidden],.is-closing');
      const path = `/space-avatars/${id}${playing ? '' : '-still'}.webp`;
      if (image.getAttribute('src') !== path) image.src = path;
      image.dataset.playing = String(playing);
    }
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) visible.add(entry.target as HTMLElement); else visible.delete(entry.target as HTMLElement);
    paint();
  });
  // Modal ownership changes inert on an ancestor without changing geometry.
  const surfaces = new MutationObserver(paint);
  for (let node: HTMLElement | null = host; node; node = node.parentElement) surfaces.observe(node, { attributes: true, attributeFilter: ['inert','hidden'] });
  const refresh = () => {
    for (const [node] of nodes) if (!host.contains(node)) { observer.unobserve(node); visible.delete(node); nodes.delete(node); }
    host.querySelectorAll<HTMLImageElement>('img[data-avatar-emoji]').forEach(image => {
      const node = image.parentElement!;
      if (!nodes.has(node)) { nodes.set(node, image); observer.observe(node); }
    });
    paint();
  };
  document.addEventListener('visibilitychange', paint, { signal });
  preference.addEventListener('change', paint, { signal });
  signal.addEventListener('abort', () => { observer.disconnect(); surfaces.disconnect(); paint(); nodes.clear(); visible.clear(); }, { once: true });
  refresh();
  return refresh;
}
