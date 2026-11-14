import { setLinkVideoPendingSend, type VaultSession } from './vault';

/** Keep the user's send authorization durable throughout local preparation. */
export async function withSavedLinkVideoSend(session: VaultSession, id: string, signal: AbortSignal,
  send: () => Promise<boolean>): Promise<boolean> {
  signal.throwIfAborted();
  await setLinkVideoPendingSend(session, id, true);
  signal.throwIfAborted();
  const accepted = await send();
  signal.throwIfAborted();
  if (accepted) await setLinkVideoPendingSend(session, id, false);
  return accepted;
}
