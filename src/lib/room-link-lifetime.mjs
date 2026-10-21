/** New-room links expire at a fixed deadline, including after reload/retry. */
export const ROOM_LINK_TTL_MS = 24 * 60 * 60_000;
export function formatRoomLinkRemaining(milliseconds) {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
