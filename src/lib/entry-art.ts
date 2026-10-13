/** Local, theme-aware illustration; contains no remote resources or user data. */
export function entryArt(kind: 'pair' | 'lock' | 'card' = 'pair'): string {
  return `<div class="entry-art entry-art-${kind}" aria-hidden="true"><span class="entry-orbit"></span><span class="entry-ground"></span><div class="entry-fold entry-fold-one"><span class="entry-message"><i></i><i></i></span></div><div class="entry-fold entry-fold-two"><span class="entry-message"><i></i><i></i></span></div><span class="entry-spark"></span></div>`;
}
