/** Consent threshold, independent of the persistent media cache budget. */
export const VIDEO_AUTO_DOWNLOAD_BYTES = 30 * 1024 * 1024;

export function shouldAutoDownloadVideo(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes < VIDEO_AUTO_DOWNLOAD_BYTES;
}

export function videoDurationLabel(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return '—:—';
  const seconds = Math.max(1, Math.floor(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = `${seconds % 60}`.padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${`${minutes % 60}`.padStart(2, '0')}:${rest}`
    : `${minutes}`.padStart(2, '0') + ':' + rest;
}
