import { createElement, File, FileText, BookOpen, FileType, FileSpreadsheet, Presentation, FileArchive, FileCode, FileImage, FileAudio, FileVideo } from 'lucide';

const formats = {
  pdf: { icon: FileText, family: 'pdf', label: 'PDF' },
  epub: { icon: BookOpen, family: 'book', label: 'EPUB' },
  doc: { icon: FileType, family: 'document', label: 'DOC' },
  docx: { icon: FileType, family: 'document', label: 'DOCX' },
  odt: { icon: FileType, family: 'document', label: 'ODT' },
  rtf: { icon: FileType, family: 'document', label: 'RTF' },
  xls: { icon: FileSpreadsheet, family: 'sheet', label: 'XLS' },
  xlsx: { icon: FileSpreadsheet, family: 'sheet', label: 'XLSX' },
  ods: { icon: FileSpreadsheet, family: 'sheet', label: 'ODS' },
  csv: { icon: FileSpreadsheet, family: 'sheet', label: 'CSV' },
  ppt: { icon: Presentation, family: 'slides', label: 'PPT' },
  pptx: { icon: Presentation, family: 'slides', label: 'PPTX' },
  txt: { icon: FileText, family: 'text', label: 'TXT' },
  md: { icon: FileCode, family: 'code', label: 'MD' },
  json: { icon: FileCode, family: 'code', label: 'JSON' },
  html: { icon: FileCode, family: 'code', label: 'HTML' },
  zip: { icon: FileArchive, family: 'archive', label: 'ZIP' },
  rar: { icon: FileArchive, family: 'archive', label: 'RAR' },
  '7z': { icon: FileArchive, family: 'archive', label: '7Z' },
} as const;
const mimeFormats: Record<string, keyof typeof formats> = {
  'application/pdf': 'pdf', 'application/epub+zip': 'epub', 'text/plain': 'txt', 'text/markdown': 'md',
  'application/json': 'json', 'text/csv': 'csv', 'text/html': 'html', 'application/zip': 'zip',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** Presentation only: reader eligibility remains a separate MIME allowlist. */
export function fileFormat(mimeType: string, filename: string) {
  const mime = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const extension = filename.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? '';
  const format = formats[extension as keyof typeof formats] ?? formats[mimeFormats[mime]!];
  if (format) return format;
  const label = extension.toUpperCase().slice(0, 4) || 'FILE';
  if (mime.startsWith('image/') || /^(png|jpg|jpeg|gif|webp|heic|svg)$/.test(extension)) return { icon: FileImage, family: 'image', label };
  if (mime.startsWith('audio/') || /^(mp3|m4a|aac|wav|flac|ogg)$/.test(extension)) return { icon: FileAudio, family: 'audio', label };
  if (mime.startsWith('video/') || /^(mp4|mov|webm|mkv)$/.test(extension)) return { icon: FileVideo, family: 'video', label };
  return { icon: File, family: 'other', label };
}

export function createFileFormatIcon(mimeType: string, filename: string): HTMLElement {
  const format = fileFormat(mimeType, filename);
  const icon = document.createElement('span');
  icon.className = 'file-format-icon'; icon.dataset.fileFormat = format.family;
  icon.setAttribute('aria-hidden', 'true');
  const glyph = createElement(format.icon);
  const label = document.createElement('small'); label.textContent = format.label;
  icon.append(glyph, label);
  return icon;
}
