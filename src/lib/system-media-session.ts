/** Release browser-owned playback state after the application's media is torn down.
 * This is a browser hint; physical iOS lock-screen UI needs separate acceptance. */
export function releaseSystemMediaSession(): void {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
  const session = navigator.mediaSession;
  try { session.metadata = null; } catch { /* Some browser implementations are partial. */ }
  try { session.playbackState = 'none'; } catch { /* Source teardown remains authoritative. */ }
  try { session.setPositionState?.(); } catch { /* Unsupported position state. */ }
  for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'] as const) {
    try { session.setActionHandler(action, null); } catch { /* Unsupported action. */ }
  }
}
