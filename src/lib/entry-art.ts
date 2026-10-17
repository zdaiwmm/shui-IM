/** Local, theme-aware illustration; contains no remote resources or user data. */
export function entryArt(kind: 'pair' | 'lock' | 'card' | 'gallery' = 'pair'): string {
  if (kind === 'pair') return chamberBrand();
  return `<div class="entry-art entry-art-${kind}" aria-hidden="true"><span class="entry-orbit"></span><span class="entry-ground"></span><div class="entry-fold entry-fold-one"><span class="entry-message"><i></i><i></i></span></div><div class="entry-fold entry-fold-two"><span class="entry-message"><i></i><i></i></span></div><span class="entry-spark"></span></div>`;
}

/** Original architectural doorway and two people. Geometry stays centered in every theme. */
export function chamberBrand(): string {
  return `<div class="chamber-brand entry-art" aria-label="Chamber"><svg viewBox="0 0 128 128" role="img" aria-label="Chamber，留给两个人的隐蔽入口"><path class="chamber-door" d="M51 105V45l30-10v70Z"/><path class="chamber-room" d="M29 106V49a35 35 0 0 1 70 0v57M22 106h84"/><path class="chamber-threshold" d="M42 106V50a22 22 0 0 1 44 0v56"/><circle class="chamber-person chamber-person-one" cx="56" cy="76" r="4.5"/><circle class="chamber-person chamber-person-two" cx="73" cy="76" r="4.5"/></svg><span>Chamber</span></div>`;
}
