import catalog from './emoji-catalog.json';

// Unicode 17.0 RGI (fully-qualified + component), CLDR 48 Chinese annotations.
// https://unicode.org/Public/17.0.0/emoji/emoji-test.txt
// https://github.com/unicode-org/cldr/tree/release-48/common/annotations
export const emojiGroups = catalog.groups;
export const emojiVersion = catalog.version;
export function searchEmoji(query: string, group: number) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = terms.length ? emojiGroups.flatMap(entry => entry.items) : emojiGroups[group]!.items;
  return items.filter(item => terms.every(term => item.join(' ').toLocaleLowerCase().includes(term)));
}
