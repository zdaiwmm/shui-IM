import { describe, expect, it } from 'vitest';
import { emojiGroups, emojiVersion, searchEmoji } from '../src/lib/emoji-catalog';
describe('offline Unicode emoji catalog', () => {
  it('contains the complete Unicode 17 RGI set without qualification duplicates', () => {
    const emoji = emojiGroups.flatMap(group => group.items.map(item => item[0]));
    expect(emojiVersion).toBe('17.0'); expect(emoji).toHaveLength(3953);
    expect(new Set(emoji).size).toBe(3953);
    for (const entry of ['😀', '👍🏽', '🇨🇳', '👨‍👩‍👧‍👦']) expect(emoji).toContain(entry);
  });
  it('searches Chinese names and English keywords across categories', () => {
    expect(searchEmoji('中国', 0).some(item => item[0] === '🇨🇳')).toBe(true);
    expect(searchEmoji('grinning face', 0).some(item => item[0] === '😀')).toBe(true);
    expect(searchEmoji('no-such-emoji-1234', 0)).toHaveLength(0);
  });
});
