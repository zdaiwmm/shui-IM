import { describe, expect, it, vi } from 'vitest';
import { collectReleaseNotes, prepareReleaseVisit } from '../src/lib/release-update';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

describe('release visit tracking', () => {
  it('does not call a fresh install an update', () => {
    const storage = memoryStorage();
    expect(prepareReleaseVisit(storage, '2')).toBe(false);
    expect(storage.values.get('quiet-room.current-release')).toBe('2');
  });

  it('shows notes once after moving from an older release', () => {
    const storage = memoryStorage({ 'quiet-room.current-release': '1' });
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
    storage.setItem('quiet-room.seen-release-notes', '2');
    expect(prepareReleaseVisit(storage, '2')).toBe(false);
  });

  it('keeps notes pending across reloads until chat has shown them', () => {
    const storage = memoryStorage({ 'quiet-room.current-release': '1' });
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
    expect(storage.values.get('quiet-room.pending-release-notes')).toBe('2');
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
  });

  it('fails quietly when durable storage is unavailable', () => {
    const storage = { getItem: vi.fn(() => { throw new Error('blocked'); }), setItem: vi.fn() };
    expect(prepareReleaseVisit(storage, '2')).toBe(false);
  });

  it('retains the last seen baseline through multiple cover-only upgrades', () => {
    const storage = memoryStorage({ 'quiet-room.current-release': '1' });
    expect(prepareReleaseVisit(storage, '2')).toBe(true);
    expect(prepareReleaseVisit(storage, '3')).toBe(true);
    expect(storage.getItem('quiet-room.release-notes-base')).toBe('1');
    const releases = [
      { id: '1', title: 'Update', notes: ['already read'] },
      { id: '2', title: 'Update', notes: ['keyboard', 'media'] },
      { id: '3', title: 'Update', notes: ['media', 'stickers'] },
    ];
    expect(collectReleaseNotes(storage.getItem('quiet-room.release-notes-base'), releases)).toEqual(['keyboard', 'media', 'stickers']);
    expect(collectReleaseNotes('2', releases)).toEqual(['media', 'stickers']);
    expect(collectReleaseNotes('3', releases)).toEqual([]);
    expect(collectReleaseNotes('older-unknown', releases)).toEqual(['already read', 'keyboard', 'media', 'stickers']);
  });
});
