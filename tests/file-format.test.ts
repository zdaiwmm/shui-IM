import { describe, it, expect } from 'vitest';
import { fileFormat } from '../src/lib/file-format';

describe('file format presentation', () => {
  it('distinguishes common documents by glyph, color family and exact format label', () => {
    const documents = ['pdf', 'epub', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'zip'].map(extension => fileFormat('', `sample.${extension}`));
    expect(new Set(documents.map(item => item.label)).size).toBe(8);
    expect(new Set(documents.map(item => item.family)).size).toBe(8);
    expect(new Set(documents.map(item => item.icon)).size).toBe(7);
  });
  it('handles uppercase extensions, missing names and unfamiliar files', () => {
    expect(fileFormat('application/octet-stream', 'REPORT.PDF').label).toBe('PDF');
    expect(fileFormat('application/epub+zip', 'book').family).toBe('book');
    expect(fileFormat('image/heic', 'photo.HEIC').family).toBe('image');
    expect(fileFormat('audio/mpeg', 'voice.mp3').family).toBe('audio');
    expect(fileFormat('video/mp4', 'film.mp4').family).toBe('video');
    expect(fileFormat('', 'file.unknown').family).toBe('other');
    expect(fileFormat('', '<script>').label).toBe('FILE');
  });
});
