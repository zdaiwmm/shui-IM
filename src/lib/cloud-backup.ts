import { archiveAad, backupDigest, newRecoveryCode, openJson, openRecovery, parseCloudRecoveryCode, randomBackupSecret, recoveryFetchToken, sealJson, sealRecovery } from './backup-crypto';
import { toBase64Url } from './base64';
import type { CloudRecoveryBundle, LocalBackupState, SealedBackup } from './backup-types';
import { canonicalStringify } from './canonical';
import { importArchivedMessages, installCloudRecovery, readStoredVault, loadHistoryPageAfter, saveVault, withVaultMutation, type VaultSession } from './vault';
import type { DecryptedMessage, Vault } from './types';

const encoder = new TextEncoder();
const AUTOMATIC_BACKUP_REVALIDATION_MS = 5 * 60_000;
type BackupFingerprint = { value: string; material: string };
type BackupObservation = { fingerprint: string; observedAt: number };
const automaticBackupObservations = new WeakMap<VaultSession, BackupObservation>();

async function request<T>(url: string, token: string, signal: AbortSignal, body?: unknown): Promise<T> {
  signal.throwIfAborted();
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'PUT', signal, cache: 'no-store', credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    if (response.status === 401) throw new Error('找不到可用备份，请检查恢复码；备份也可能已被停用或清理');
    if (response.status === 409) throw new Error('备份版本冲突，请锁定后重新解锁再试');
    if (response.status === 413) throw new Error('备份空间已满，请联系管理员处理');
    throw new Error('备份服务暂时不可用，请稍后重试');
  }
  return response.json() as Promise<T>;
}

/** Save changes atomically without leaking a failed in-memory mutation into later writes. */
async function update<T>(session: VaultSession, signal: AbortSignal, change: (state: LocalBackupState) => Promise<T> | T): Promise<T> {
  return withVaultMutation(session, async mutation => {
    signal.throwIfAborted();
    const previous = session.vault.backup;
    const source = session.vault.recoverySource;
    const state: LocalBackupState = previous ? structuredClone(previous) : {
      v: 1, ...newRecoveryCode(), revision: 0, cursor: session.vault.historyUnavailableBeforeSeq ?? 0,
      archives: [...(source?.archives ?? []).map(a => ({ ...structuredClone(a), token: randomBackupSecret() })),
        { id: randomBackupSecret(), key: randomBackupSecret(), token: randomBackupSecret(), parts: [] }],
      ...(source ? { replaces: source.backupId, newCodePending: true } : {}),
    };
    const result = await change(state);
    signal.throwIfAborted();
    session.vault.backup = state;
    try { await saveVault(session, mutation); }
    catch (error) { session.vault.backup = previous; throw error; }
    return result;
  });
}

function checkpoint(vault: Vault): Vault {
  const value = structuredClone(vault);
  delete value.backup;
  delete value.recoverySource;
  delete value.pendingRecovery;
  delete value.pendingDeviceLinks;
  delete value.inviteToken;
  delete value.identity.mlsPrivatePackage;
  // Recovery proves the old identity, but never restores its sending ratchet.
  value.mls = { protocol: 'mls-rfc9420', phase: 'awaiting-welcome', lastEventSeq: vault.mls?.lastEventSeq ?? 0 };
  return value;
}

function backupFingerprintMaterial(session: VaultSession, state: LocalBackupState): string {
  return canonicalStringify({
    checkpoint: checkpoint(session.vault),
    backup: {
      id: state.id,
      cursor: state.cursor,
      archives: state.archives.map(archive => ({
        id: archive.id,
        key: archive.key,
        token: archive.token,
        partCount: archive.parts.length,
        lastPart: archive.parts.at(-1) ?? null,
      })),
    },
  });
}

async function backupFingerprint(session: VaultSession, state: LocalBackupState): Promise<BackupFingerprint> {
  const material = backupFingerprintMaterial(session, state);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(material));
  return { value: toBase64Url(new Uint8Array(digest)), material };
}

function isCleanlySynced(session: VaultSession): boolean {
  const state = session.vault.backup;
  return Boolean(state?.syncedAt && !state.pending && !state.pendingPart && !state.replaces
    && !state.newCodePending && !session.vault.recoverySource && state.cursor >= session.vault.lastSeq);
}

async function shouldSkipAutomaticBackup(session: VaultSession): Promise<boolean> {
  if (!isCleanlySynced(session)) return false;
  const observation = automaticBackupObservations.get(session);
  if (!observation) return false;
  const age = Date.now() - observation.observedAt;
  if (age < 0 || age >= AUTOMATIC_BACKUP_REVALIDATION_MS) return false;
  const state = session.vault.backup!;
  const fingerprint = await backupFingerprint(session, state);
  // A message or membership update can arrive while the digest is pending.
  // Never skip if the state changed during that asynchronous check.
  if (session.vault.backup !== state || !isCleanlySynced(session)
    || backupFingerprintMaterial(session, state) !== fingerprint.material) return false;
  return observation.fingerprint === fingerprint.value;
}

async function rememberAutomaticBackup(session: VaultSession): Promise<void> {
  if (!isCleanlySynced(session)) {
    automaticBackupObservations.delete(session);
    return;
  }
  const state = session.vault.backup!;
  const fingerprint = await backupFingerprint(session, state);
  if (session.vault.backup !== state || !isCleanlySynced(session)
    || backupFingerprintMaterial(session, state) !== fingerprint.material) {
    automaticBackupObservations.delete(session);
    return;
  }
  automaticBackupObservations.set(session, { fingerprint: fingerprint.value, observedAt: Date.now() });
}

async function stageEnvelope(session: VaultSession, signal: AbortSignal): Promise<void> {
  await update(session, signal, async state => {
    if (state.pending) return;
    const bundle: CloudRecoveryBundle = { v: 1, backupId: state.id, roomId: session.vault.roomId,
      deviceId: session.vault.identity.publicBundle.deviceId, checkpoint: checkpoint(session.vault), archives: state.archives };
    const sealed = await sealRecovery(bundle, state.code);
    // Validate the exact new envelope before it can replace any online recovery route.
    const verified = await openRecovery(sealed, state.code);
    if (JSON.stringify(verified) !== JSON.stringify(bundle)) throw new Error('恢复备份自检失败');
    state.pending = { id: state.id, revision: state.revision + 1, fetchToken: await recoveryFetchToken(state.code), sealed,
      archives: state.archives.map((archive, index) => ({ id: archive.id, token: archive.token, writable: index === state.archives.length - 1 })),
      ...(state.replaces ? { replaces: state.replaces } : {}) };
  });
}

async function sendEnvelope(session: VaultSession, signal: AbortSignal): Promise<void> {
  const pending = session.vault.backup?.pending;
  if (!pending) return;
  const result = await request<{ revision: number; updatedAt: string }>(`/api/rooms/${session.vault.roomId}/backup`, session.vault.accessToken, signal, pending);
  if (result.revision !== pending.revision || !Number.isFinite(Date.parse(result.updatedAt))) throw new Error('备份确认不正确');
  await update(session, signal, state => {
    if (JSON.stringify(state.pending) !== JSON.stringify(pending)) throw new Error('备份状态已经变化');
    state.revision = result.revision;
    state.syncedAt = result.updatedAt;
    delete state.pending;
    delete state.replaces;
  });
  // Do not keep the old archive access tokens once the new envelope is durable.
  if (session.vault.recoverySource) await withVaultMutation(session, async mutation => {
    signal.throwIfAborted();
    const previous = session.vault.recoverySource;
    delete session.vault.recoverySource;
    try { await saveVault(session, mutation); } catch (error) { session.vault.recoverySource = previous; throw error; }
  });
}

/** Foreground only. Pending ciphertext is durable before any network upload. */
export type CloudBackupSyncOptions = { force?: boolean };

export async function syncCloudBackup(session: VaultSession, signal: AbortSignal, { force = true }: CloudBackupSyncOptions = {}): Promise<void> {
  if (session.vault.protocol !== 'mls-rfc9420' || session.stored.unlockMethod !== 'platform' || session.vault.pairingState === 'recovering') return;
  signal.throwIfAborted();
  if (!force && await shouldSkipAutomaticBackup(session)) {
    signal.throwIfAborted();
    return;
  }
  await stageEnvelope(session, signal);
  await sendEnvelope(session, signal);
  // Bound each foreground pass; the next pass continues from the durable cursor.
  for (let batch = 0; batch < 20; batch += 1) {
    await update(session, signal, async state => {
      if (state.pendingPart) return;
      let messages = await loadHistoryPageAfter(session, { afterSeq: state.cursor, limit: 100, signal });
      if (!messages.length) return;
      const archive = state.archives.at(-1)!;
      const id = randomBackupSecret();
      let sealed: SealedBackup;
      for (;;) {
        sealed = await sealJson({ v: 1, roomId: session.vault.roomId, messages }, archive.key, archiveAad(session.vault.roomId, archive.id, id));
        if (sealed.ciphertext.length <= 1_800_000) break;
        if (messages.length === 1) throw new Error('一条历史记录超过备份大小限制，请联系维护者');
        messages = messages.slice(0, Math.ceil(messages.length / 2));
        signal.throwIfAborted();
      }
      state.pendingPart = { archiveId: archive.id, sealed, part: { id, digest: await backupDigest(sealed),
        firstSeq: messages[0]!.seq, lastSeq: messages.at(-1)!.seq, count: messages.length } };
    });
    const pending = session.vault.backup!.pendingPart;
    if (!pending) break;
    await request(`/api/rooms/${session.vault.roomId}/archives/${pending.archiveId}/${pending.part.id}`, session.vault.accessToken, signal, pending.sealed);
    await update(session, signal, state => {
      if (state.pendingPart?.part.id !== pending.part.id) throw new Error('历史备份状态已经变化');
      state.archives.at(-1)!.parts.push(pending.part);
      state.cursor = pending.part.lastSeq;
      delete state.pendingPart;
    });
    await stageEnvelope(session, signal);
    await sendEnvelope(session, signal);
  }
  await rememberAutomaticBackup(session);
}

export async function fetchRecoveryBundle(code: string, signal: AbortSignal): Promise<CloudRecoveryBundle> {
  const { id, secret } = parseCloudRecoveryCode(code);
  secret.fill(0);
  const result = await request<{ revision: number; sealed: SealedBackup }>(`/api/recovery-backups/${id}`, await recoveryFetchToken(code), signal);
  try { return await openRecovery(result.sealed, code); }
  catch { throw new Error('恢复码不正确，或备份未通过完整性验证'); }
}

export async function recoverFromCloud(code: string, signal: AbortSignal): Promise<VaultSession> {
  const expected = await readStoredVault();
  const bundle = await fetchRecoveryBundle(code, signal);
  signal.throwIfAborted();
  return installCloudRecovery(bundle, parseCloudRecoveryCode(code).secret, expected, signal);
}

export async function restoreCloudHistory(session: VaultSession, code: string, scope: 'chat' | 'gallery', signal: AbortSignal,
  progress: (count: number, changed: boolean) => void = () => undefined): Promise<number> {
  if (!session.vault.backup?.syncedAt || session.vault.backup.replaces || session.vault.recoverySource) throw new Error('请先完成新恢复码的备份更新');
  if (scope === 'gallery' && session.vault.role !== 'creator') throw new Error('此参与方没有相册入口');
  if (parseCloudRecoveryCode(code).id !== session.vault.backup.id) throw new Error('请使用本设备当前的恢复码');
  const bundle = await fetchRecoveryBundle(code, signal);
  if (bundle.roomId !== session.vault.roomId || bundle.deviceId !== session.vault.identity.publicBundle.deviceId) throw new Error('恢复码不属于本设备');
  let restored = 0;
  let changed = false;
  for (const archive of bundle.archives) {
    for (const part of archive.parts) {
      signal.throwIfAborted();
      const sealed = await request<SealedBackup>(`/api/history-archives/${archive.id}/${part.id}`, archive.token, signal);
      if (await backupDigest(sealed) !== part.digest) throw new Error('历史备份完整性验证失败');
      const value = await openJson(sealed, archive.key, archiveAad(bundle.roomId, archive.id, part.id)) as { v: number; roomId: string; messages: DecryptedMessage[] };
      if (value?.v !== 1 || value.roomId !== bundle.roomId || !Array.isArray(value.messages) || value.messages.length !== part.count ||
          value.messages[0]?.seq !== part.firstSeq || value.messages.at(-1)?.seq !== part.lastSeq ||
          value.messages.some((message, index) => index > 0 && message.seq <= value.messages[index - 1]!.seq)) throw new Error('历史备份索引不正确');
      restored += await importArchivedMessages(session, value.messages, scope, signal, partChanged => { changed ||= partChanged; });
      progress(restored, changed);
    }
  }
  return restored;
}
