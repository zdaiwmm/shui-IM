/** New-room links expire at a fixed deadline, including after reload/retry. */
export const ROOM_LINK_TTL_MS = 24 * 60 * 60_000;
export function formatRoomLinkRemaining(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}
