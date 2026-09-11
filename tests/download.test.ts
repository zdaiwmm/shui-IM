import { describe, expect, it } from 'vitest';
import { systemReadableMimeType } from '../src/lib/download';

describe('system document reader allowlist', () => {
  it('opens only inert document types with a trustworthy MIME or fallback extension', () => {
    expect(systemReadableMimeType('application/pdf', 'report.pdf')).toBe('application/pdf');
    expect(systemReadableMimeType('text/plain; charset=utf-8', 'notes.txt')).toBe('text/plain');
    expect(systemReadableMimeType('application/octet-stream', 'table.csv')).toBe('text/csv');
    expect(systemReadableMimeType('', 'readme.md')).toBe('text/markdown');
    expect(systemReadableMimeType('application/epub+zip', 'book.epub')).toBe('application/epub+zip');
    expect(systemReadableMimeType('application/octet-stream', 'BOOK.EPUB')).toBe('application/epub+zip');
    expect(systemReadableMimeType('application/zip', 'book.epub')).toBe('application/epub+zip');
  });

  it('keeps active and ambiguous content on the inert download path', () => {
    expect(systemReadableMimeType('text/html', 'page.html')).toBeNull();
    expect(systemReadableMimeType('image/svg+xml', 'image.svg')).toBeNull();
    expect(systemReadableMimeType('application/javascript', 'script.txt')).toBeNull();
    expect(systemReadableMimeType('application/octet-stream', 'unknown.bin')).toBeNull();
    expect(systemReadableMimeType('text/html', 'spoofed.epub')).toBeNull();
    expect(systemReadableMimeType('application/zip', 'archive.zip')).toBeNull();
  });
});
