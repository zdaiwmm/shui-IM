import { describe, expect, it } from 'vitest';
import { systemReadableMimeType } from '../src/lib/download';

describe('system document reader allowlist', () => {
  it('opens only inert document types with a trustworthy MIME or fallback extension', () => {
    expect(systemReadableMimeType('application/pdf', 'report.pdf')).toBe('application/pdf');
    expect(systemReadableMimeType('text/plain; charset=utf-8', 'notes.txt')).toBe('text/plain');
    expect(systemReadableMimeType('application/octet-stream', 'table.csv')).toBe('text/csv');
    expect(systemReadableMimeType('', 'readme.md')).toBe('text/markdown');
  });

  it('keeps active and ambiguous content on the inert download path', () => {
    expect(systemReadableMimeType('text/html', 'page.html')).toBeNull();
    expect(systemReadableMimeType('image/svg+xml', 'image.svg')).toBeNull();
    expect(systemReadableMimeType('application/javascript', 'script.txt')).toBeNull();
    expect(systemReadableMimeType('application/octet-stream', 'unknown.bin')).toBeNull();
  });
});
