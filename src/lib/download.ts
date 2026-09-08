type FileShareNavigator = Navigator & {
  canShare?: (data?: ShareData) => boolean;
  share?: (data: ShareData) => Promise<void>;
  userActivation?: { isActive: boolean };
};

function isAppleTouchDevice(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Saves a generated file without allowing its blob URL to replace the app.
 * iOS standalone/browser sessions prefer the native share sheet because
 * WebKit may otherwise render a blob in the current tab when it ignores the
 * download attribute. "Save to Files" remains available from that sheet.
 */
export async function downloadBlob(
  blob: Blob,
  filename: string,
  options: { preferShare?: boolean } = {},
): Promise<void> {
  const safeFilename = filename.trim() || 'download';
  const file = new File([blob], safeFilename, {
    type: blob.type || 'application/octet-stream',
    lastModified: Date.now(),
  });
  const shareNavigator = navigator as FileShareNavigator;
  const canShareFile = options.preferShare !== false && isAppleTouchDevice()
    && shareNavigator.userActivation?.isActive !== false
    && typeof shareNavigator.share === 'function'
    && shareNavigator.canShare?.({ files: [file] }) === true;

  if (canShareFile) {
    try {
      await shareNavigator.share?.({ files: [file] });
      return;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      // Fall through to the download attribute if the system share surface
      // is temporarily unavailable.
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename;
  anchor.rel = 'noopener';
  // Keep the original page (and the separately displayed recovery code) intact
  // if Safari previews a file instead of honoring the download attribute.
  anchor.target = '_blank';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const SYSTEM_READABLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

/** Only allowlisted documents enter the local reader; MIME conflicts fail closed. */
export function systemReadableMimeType(mimeType: string, filename: string): string | null {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (SYSTEM_READABLE_MIME_TYPES.has(normalized)) return normalized;
  if (normalized && normalized !== 'application/octet-stream') return null;
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension === 'pdf' ? 'application/pdf'
    : extension === 'txt' ? 'text/plain'
      : extension === 'csv' ? 'text/csv'
        : extension === 'md' ? 'text/markdown'
          : extension === 'json' ? 'application/json'
            : null;
}
