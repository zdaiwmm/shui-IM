import { uiLiteral } from './language';
/** Local, theme-aware illustration; contains no remote resources or user data. */
export function entryArt(kind: 'pair' | 'lock' | 'card' | 'gallery' = 'pair'): string {
  if (kind === 'pair') return chamberBrand();
  return `<div class="entry-art entry-art-${kind}" aria-hidden="true"><span class="entry-orbit"></span><span class="entry-ground"></span><div class="entry-fold entry-fold-one"><span class="entry-message"><i></i><i></i></span></div><div class="entry-fold entry-fold-two"><span class="entry-message"><i></i><i></i></span></div><span class="entry-spark"></span></div>`;
}

/** User-selected private-dialogue-v9: enclosed frame and inward-facing dialogue. */
export function chamberMark(): string {
  return uiLiteral(`<svg viewBox="0 0 100 100" role="img" aria-label="Chamber，双向对话的密室"><rect class="chamber-frame" x="21" y="24" width="58" height="52" rx="13" fill="none" stroke="currentColor" stroke-width="3.4"/><g class="chamber-dialogue chamber-dialogue-left"><path d="M37.2 38.5h7.6a3.2 3.2 0 0 1 3.2 3.2v22.4l-5.4-5.4h-5.4a3.2 3.2 0 0 1-3.2-3.2V41.7a3.2 3.2 0 0 1 3.2-3.2Z" fill="currentColor"/></g><g class="chamber-dialogue chamber-dialogue-right"><path d="M62.8 38.5h-7.6a3.2 3.2 0 0 0-3.2 3.2v22.4l5.4-5.4h5.4a3.2 3.2 0 0 0 3.2-3.2V41.7a3.2 3.2 0 0 0-3.2-3.2Z" fill="currentColor"/></g></svg>`);
}
export function chamberBrand(): string {
  return `<div class="chamber-brand entry-art" aria-label="Chamber">${chamberMark()}<span>Chamber</span></div>`;
}
