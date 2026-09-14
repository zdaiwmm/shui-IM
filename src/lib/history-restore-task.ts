import { normalizeRecoveryCodes } from './cloud-backup';
import { saveVault, withVaultMutation, type VaultSession } from './vault';

/** Persist only in this device's encrypted vault, before starting network work. */
export async function saveHistoryRestoreTask(session: VaultSession, input: string, signal: AbortSignal): Promise<void> {
  const codes = normalizeRecoveryCodes(input);
  await withVaultMutation(session, async mutation => {
    signal.throwIfAborted();
    const previous = session.vault.historyRestoreTask;
    if (previous && JSON.stringify(previous.codes) === JSON.stringify(codes)) return;
    session.vault.historyRestoreTask = { v: 1, id: crypto.randomUUID(), codes, createdAt: new Date().toISOString() };
    try { await saveVault(session, mutation); }
    catch (error) { session.vault.historyRestoreTask = previous; throw error; }
  });
  signal.throwIfAborted();
}

/** Called only on completion, explicit cancellation, or explicit code replacement. */
export async function clearHistoryRestoreTask(session: VaultSession, signal: AbortSignal): Promise<void> {
  await withVaultMutation(session, async mutation => {
    signal.throwIfAborted();
    const previous = session.vault.historyRestoreTask;
    if (!previous) return;
    delete session.vault.historyRestoreTask;
    try { await saveVault(session, mutation); }
    catch (error) { session.vault.historyRestoreTask = previous; throw error; }
  });
}
