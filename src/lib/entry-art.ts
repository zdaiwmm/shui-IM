/** Local, theme-aware illustration; contains no remote resources or user data. */
export function entryArt(kind: 'pair' | 'lock' | 'card' | 'gallery' = 'pair'): string {
  if (kind === 'pair') return chamberBrand();
  return `<div class="entry-art entry-art-${kind}" aria-hidden="true"><span class="entry-orbit"></span><span class="entry-ground"></span><div class="entry-fold entry-fold-one"><span class="entry-message"><i></i><i></i></span></div><div class="entry-fold entry-fold-two"><span class="entry-message"><i></i><i></i></span></div><span class="entry-spark"></span></div>`;
}

/** A room drawn as C, with two independent points inside; no icon font or external asset. */
export function chamberBrand(): string {
  return `<div class="chamber-brand entry-art" aria-label="Chamber"><svg viewBox="0 0 128 128" role="img" aria-label="Chamber 标志"><path class="chamber-room" d="M96 27H46C31 27 23 38 23 53v30c0 15 8 25 23 25h50V85H50V50h46Z"/><path class="chamber-threshold" d="M96 27v23M96 85v23"/><circle class="chamber-person chamber-person-one" cx="61" cy="67" r="6"/><circle class="chamber-person chamber-person-two" cx="84" cy="67" r="6"/></svg><span>Chamber</span></div>`;
}
