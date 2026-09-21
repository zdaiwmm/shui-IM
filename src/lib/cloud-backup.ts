import { recoverableSpaces, spaceCodeId } from './spaces';
import { isMessagePayload } from './message-payload';
import { isGalleryMediaPayload } from './video-media';
import { galleryCurationKey, normalizeGalleryCurationRecords } from './gallery-curation';
import { archiveAad, backupDigest, newRecoveryCode, openJson, openRecovery, parseCloudRecoveryCode, randomBackupSecret, recoveryFetchToken, sealJson, sealRecovery } from './backup-crypto';
import { toBase64Url } from './base64';
import type { ArchivePart, CloudRecoveryBundle, HistoryArchive, LocalBackupState, SealedBackup } from './backup-types';
import { canonicalStringify } from './canonical';
import { loadUiPreferences, restoreGalleryHidden, findMissingArchivedMessages, importArchivedMessages, installCloudRecovery, readStoredVault, loadHistoryPageAfter, saveVault, withVaultMutation, type VaultSession } from './vault';
import type { DecryptedMessage, Vault } from './types';
import { auditRestoredHistory, historyRecordDigest, type RestoreAudit, type RestoreAuditRecord } from './history-restore-audit';

export const BACKUP_REQUEST_TIMEOUT_MS = 30_000;
export const AUTOMATIC_HISTORY_BATCH_WAIT_MS = 45_000;
const encoder = new TextEncoder();
const AUTOMATIC_BACKUP_REVALIDATION_MS = 5 * 60_000;
const MAX_RATE_LIMIT_RETRIES = 12;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
type BackupFingerprint = { value: string; material: string };
type BackupObservation = { fingerprint: string; observedAt: number };
const automaticBackupObservations = new WeakMap<VaultSession, BackupObservation>();

function backupInventory(messages: readonly DecryptedMessage[]): { chatCount: number; galleryCount: number } {
  let chatCount = 0;
  let galleryCount = 0;
  for (const message of messages) {
    const payload = message.payload;
    const galleryOnly = payload.kind === 'gallery-image' || payload.kind === 'gallery-file';
    const projection = payload.kind === 'reaction' || payload.kind === 'message-delete' || payload.kind === 'media-read' || payload.kind === 'message-read';
    if (!galleryOnly && !projection) chatCount += 1;
    if (isGalleryMediaPayload(payload)) {
      galleryCount += payload.kind === 'image-album' ? payload.images.length : 1;
    }
  }
  return { chatCount, galleryCount };
}

function archiveInventory(archive: HistoryArchive): { chatCount: number; galleryCount: number } {
  return archive.parts.reduce((totals, part) => ({
    chatCount: totals.chatCount + (part.chatCount ?? 0),
    galleryCount: totals.galleryCount + (part.galleryCount ?? 0),
  }), { chatCount: 0, galleryCount: 0 });
}

function retryAfterMs(response: Response): number {
  const value = response.headers.get('Retry-After')?.trim() ?? '';
  if (!value) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now())) : DEFAULT_RETRY_AFTER_MS;
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('操作已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function request<T>(url: string, token: string, signal: AbortSignal, body?: unknown, onWait?: (waiting: boolean) => void): Promise<T> {
  const options = { method: body === undefined ? 'GET' : 'PUT', signal, cache: 'no-store' as RequestCache, credentials: 'omit' as RequestCredentials,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  for (let retry = 0;; retry += 1) {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('备份请求超时，请检查网络后重试')), BACKUP_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.any([signal, timeout.signal]) });
      if (response.ok) return await response.json() as T;
    } catch (cause) {
      signal.throwIfAborted();
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (cause instanceof TypeError) throw new Error('网络连接中断，请检查网络后重试');
      throw cause;
    } finally { clearTimeout(timer); }
    if (response.status === 429) {
      if (retry >= MAX_RATE_LIMIT_RETRIES) throw new Error('备份请求过于频繁，请稍后再试；已恢复的记录会保留，可继续重试');
      onWait?.(true);
      try { await waitForRetry(retryAfterMs(response), signal); }
      finally { if (!signal.aborted) onWait?.(false); }
      continue;
    }
    if (response.status === 401) throw new Error(url.startsWith('/api/history-archives/')
      ? '恢复包已读取，但历史片段无法取回。恢复码可能刚被轮换、所属设备已撤销，或片段已被清理；请使用当前恢复码重试'
      : '找不到可用备份。设备恢复并换码后，旧码会停用，请使用新生成的恢复码；也请确认码输入完整、对应设备未撤销且备份未清理');
    if (response.status === 409) throw new Error('备份版本冲突，请锁定后重新解锁再试');
    if (response.status === 413) throw new Error('备份空间已满，请联系管理员处理');
    throw new Error('备份服务暂时不可用，请稍后重试');
  }
}

/** Save changes atomically without leaking a failed in-memory mutation into later writes. */
async function update<T>(session: VaultSession, signal: AbortSignal, change: (state: LocalBackupState) => Promise<T> | T): Promise<T> {
  return withVaultMutation(session, async mutation => {
    signal.throwIfAborted();
    const previous = session.vault.backup;
    const source = session.vault.recoverySource;
    const state: LocalBackupState = previous ? structuredClone(previous) : {
      v: 1, ...newRecoveryCode(), revision: 0, cursor: source?.resumeCursor ?? session.vault.historyUnavailableBeforeSeq ?? 0,
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
  delete value.spaceRecoveryCode;
  delete value.historyRestoreTask;
  delete value.recoverySource;
  delete value.pendingRecovery;
  delete value.pendingJointRecovery;
  delete value.recoveryExperience;
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

async function galleryHiddenSnapshot(session: VaultSession) {
  if (session.vault.role !== 'creator') return [];
  const hidden = new Map([...(session.vault.recoverySource?.galleryHidden ?? []), ...(session.vault.backup?.galleryHidden ?? []),
    ...((await loadUiPreferences(session)).galleryCuration ?? [])].filter(record => record.hidden).map(record => [galleryCurationKey(record), record]));
  return normalizeGalleryCurationRecords([...hidden.values()]);
}

async function hiddenSnapshotCurrent(session: VaultSession) {
  return JSON.stringify(session.vault.backup?.galleryHidden ?? []) === JSON.stringify(await galleryHiddenSnapshot(session));
}

async function shouldSkipAutomaticBackup(session: VaultSession): Promise<boolean> {
  if (session.vault.backup?.archives.some(archive => archive.parts.some(part => part.chatCount === undefined || part.galleryCount === undefined))) return false;
  if (!isCleanlySynced(session) || !await hiddenSnapshotCurrent(session)) return false;
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
  if (!isCleanlySynced(session) || !await hiddenSnapshotCurrent(session)) {
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
    state.galleryHidden = await galleryHiddenSnapshot(session);
    const bundle: CloudRecoveryBundle = { v: 1, backupId: state.id, roomId: session.vault.roomId,
      deviceId: session.vault.identity.publicBundle.deviceId, checkpoint: checkpoint(session.vault), archives: state.archives,
      ...(session.vault.role === 'creator' ? { galleryHidden: state.galleryHidden } : {}) };
    const sealed = await sealRecovery(bundle, state.code);
    // Validate the exact new envelope before it can replace any online recovery route.
    const verified = await openRecovery(sealed, state.code);
    if (JSON.stringify(verified) !== JSON.stringify(bundle)) throw new Error('恢复备份自检失败');
    state.pending = { id: state.id, revision: state.revision + 1, fetchToken: await recoveryFetchToken(state.code), sealed,
      archives: state.archives.map((archive, index) => ({
        id: archive.id,
        token: archive.token,
        writable: index === state.archives.length - 1,
        ...archiveInventory(archive),
      })),
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

/** Upgrade older encrypted indexes once; never infer a content count from ciphertext size. */
async function backfillArchiveInventory(session: VaultSession, signal: AbortSignal): Promise<boolean> {
  const missing = session.vault.backup?.archives.flatMap(archive => archive.parts
    .filter(part => part.chatCount === undefined || part.galleryCount === undefined)
    .map(part => ({ archive, part }))).slice(0, 20) ?? [];
  for (const { archive, part } of missing) {
    const sealed = await request<SealedBackup>(`/api/history-archives/${archive.id}/${part.id}`, archive.token, signal);
    if (await backupDigest(sealed) !== part.digest) throw new Error('历史备份完整性验证失败');
    const messages = validateArchivePart(await openJson(sealed, archive.key,
      archiveAad(session.vault.roomId, archive.id, part.id)), session.vault.roomId, part);
    const inventory = backupInventory(messages);
    await update(session, signal, state => {
      const current = state.archives.find(item => item.id === archive.id)?.parts.find(item => item.id === part.id);
      if (!current || current.digest !== part.digest) throw new Error('历史备份状态已经变化');
      Object.assign(current, inventory);
    });
  }
  return missing.length > 0;
}

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
      if (!messages.length) { delete state.historyBatchStartedAt; return; }
      // Durable local history is already encrypted. Coalesce small automatic
      // batches without resetting the deadline on each 15-second foreground pass.
      const now = Date.now();
      if (!force && messages.length < 100) {
        state.historyBatchStartedAt ??= now;
        if (now >= state.historyBatchStartedAt && now - state.historyBatchStartedAt < AUTOMATIC_HISTORY_BATCH_WAIT_MS) return;
      }
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
      const inventory = backupInventory(messages);
      state.pendingPart = { archiveId: archive.id, sealed, part: { id, digest: await backupDigest(sealed),
        firstSeq: messages[0]!.seq, lastSeq: messages.at(-1)!.seq, count: messages.length, ...inventory } };
      delete state.historyBatchStartedAt;
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
  if (await backfillArchiveInventory(session, signal)) {
    await stageEnvelope(session, signal);
    await sendEnvelope(session, signal);
  }
  await rememberAutomaticBackup(session);
}

export async function fetchRecoveryBundle(code: string, signal: AbortSignal, onWait?: (waiting: boolean) => void, targetRoom?: string): Promise<CloudRecoveryBundle> {
  if (code.startsWith('QR4-')) {
    const spaces = await recoverableSpaces(code, signal);
    const entry = targetRoom ? spaces.find(space => space.roomId === targetRoom) : spaces.length === 1 ? spaces[0] : undefined;
    if (!entry?.code) throw new Error('请先选择此恢复码对应的空间');
    code = entry.code;
  }
  const { id, secret } = parseCloudRecoveryCode(code);
  secret.fill(0);
  const result = await request<{ revision: number; sealed: SealedBackup }>(`/api/recovery-backups/${id}`, await recoveryFetchToken(code), signal, undefined, onWait);
  try { return await openRecovery(result.sealed, code); }
  catch { throw new Error('恢复码不正确，或备份未通过完整性验证'); }
}

export async function recoverFromCloud(code: string, signal: AbortSignal): Promise<VaultSession> {
  const expected = await readStoredVault();
  const bundle = await fetchRecoveryBundle(code, signal);
  signal.throwIfAborted();
  return installCloudRecovery(bundle, parseCloudRecoveryCode(code).secret, expected, signal);
}

export function normalizeRecoveryCodes(input: string | readonly string[]): string[] {
  const values: readonly string[] = typeof input === 'string' ? input.split(/\r?\n/) : input;
  const codes = [...new Set(values.map((value: string) => value.trim()).filter(Boolean))];
  if (!codes.length) throw new Error('请输入至少一个恢复码');
  if (codes.length > 6) throw new Error('本会话最多支持 6 个设备恢复码');
  for (const code of codes) {
    try { if (code.startsWith('QR4-')) spaceCodeId(code); else parseCloudRecoveryCode(code); }
    catch { throw new Error('恢复码格式不正确，请输入完整的空间或设备恢复码'); }
  }
  return codes;
}

/** Keep authenticated index failures separate from unsupported record formats. */
function validateArchivePart(value: unknown, roomId: string, part: ArchivePart): DecryptedMessage[] {
  const archive = value as { v?: unknown; roomId?: unknown; messages?: unknown } | null;
  if (archive?.v !== 1 || archive.roomId !== roomId || !Array.isArray(archive.messages)) throw new Error('历史备份片段格式或会话归属不正确');
  const messages = archive.messages as DecryptedMessage[];
  if (messages.length !== part.count) throw new Error('历史备份条数与索引不一致');
  if (messages.some((message, index) => !message || !Number.isSafeInteger(message.seq) || message.seq < 1 ||
    index > 0 && message.seq <= messages[index - 1]!.seq) || messages[0]?.seq !== part.firstSeq || messages.at(-1)?.seq !== part.lastSeq) {
    throw new Error('历史备份序号与索引不一致');
  }
  if (messages.some(message => typeof message.clientMsgId !== 'string' || typeof message.senderId !== 'string' || typeof message.acceptedAt !== 'string')) {
    throw new Error('历史备份记录元数据不正确');
  }
  if (messages.some(message => !isMessagePayload(message.payload))) throw new Error('历史备份包含当前版本不支持或格式不正确的记录，请更新应用后重试');
  return messages;
}

/** Restore one or more device archives belonging to the current room. */
export async function restoreCloudHistory(session: VaultSession, input: string | readonly string[], scope: 'chat' | 'gallery', signal: AbortSignal,
  progress: (count: number, changed: boolean) => void = () => undefined): Promise<number> {
  if (!session.vault.backup?.syncedAt || session.vault.backup.replaces || session.vault.recoverySource) throw new Error('请先完成新恢复码的备份更新');
  if (scope === 'gallery' && session.vault.role !== 'creator') throw new Error('此参与方没有相册入口');
  const codes = normalizeRecoveryCodes(input);
  const bundles: CloudRecoveryBundle[] = [];
  const backupIds = new Set<string>();
  for (const code of codes) {
    const bundle = await fetchRecoveryBundle(code, signal, undefined, session.vault.roomId);
    if (bundle.roomId !== session.vault.roomId) throw new Error('恢复码不属于当前会话');
    if (backupIds.has(bundle.backupId)) continue;
    backupIds.add(bundle.backupId);
    bundles.push(bundle);
  }
  let restored = 0;
  let changed = false;
  for (const bundle of bundles) for (const archive of bundle.archives) {
    for (const part of archive.parts) {
      signal.throwIfAborted();
      const sealed = await request<SealedBackup>(`/api/history-archives/${archive.id}/${part.id}`, archive.token, signal);
      if (await backupDigest(sealed) !== part.digest) throw new Error('历史备份完整性验证失败');
      const messages = validateArchivePart(await openJson(sealed, archive.key, archiveAad(bundle.roomId, archive.id, part.id)), bundle.roomId, part);
      restored += await importArchivedMessages(session, messages, scope, signal, partChanged => { changed ||= partChanged; });
      progress(restored, changed);
    }
  }
  return restored;
}

export type HistoryRestoreProgress = {
  phase: 'reading' | 'restoring' | 'verifying' | 'complete';
  scannedParts: number;
  totalParts: number;
  chat: { restored: number; total: number };
  gallery?: { restored: number; total: number };
  percent: number | null;
  waitingForService?: boolean;
  changed: boolean;
  inventory?: { chat: { backup: number; existing: number }; gallery?: { backup: number; existing: number } };
  audit?: RestoreAudit;
};

/** Discover exact content totals before importing, retaining at most 16 MiB of ciphertext.
 * Larger archives are re-read with the same authenticated digest; content plaintext
 * lives for only one part. Deletion projections are retained and commit before content.
 */
export async function restoreUnifiedHistory(session: VaultSession, input: string, signal: AbortSignal,
  onProgress: (value: HistoryRestoreProgress) => void): Promise<HistoryRestoreProgress> {
  if (!session.vault.backup?.syncedAt || session.vault.backup.replaces || session.vault.recoverySource) throw new Error('请先完成新恢复码的备份更新');
  const creator = session.vault.role === 'creator';
  const status: HistoryRestoreProgress = { phase: 'reading', scannedParts: 0, totalParts: 0,
    chat: { restored: 0, total: 0 }, ...(creator ? { gallery: { restored: 0, total: 0 } } : {}), percent: null, changed: false };
  status.inventory = { chat: { backup: 0, existing: 0 }, ...(creator ? { gallery: { backup: 0, existing: 0 } } : {}) };
  const emit = () => { signal.throwIfAborted(); onProgress(structuredClone(status)); };
  const onWait = (waiting: boolean) => { status.waitingForService = waiting; emit(); };
  emit();
  const bundles: CloudRecoveryBundle[] = [];
  for (const code of normalizeRecoveryCodes(input)) {
    const bundle = await fetchRecoveryBundle(code, signal, onWait, session.vault.roomId);
    signal.throwIfAborted();
    if (bundle.roomId !== session.vault.roomId) throw new Error('恢复码不属于当前会话');
    if (!bundles.some(previous => previous.backupId === bundle.backupId)) bundles.push(bundle);
  }
  const hidden = new Map((await galleryHiddenSnapshot(session)).map(record => [galleryCurationKey(record), record]));
  if (creator) for (const bundle of bundles) for (const record of bundle.galleryHidden ?? []) hidden.set(galleryCurationKey(record), record);
  const parts = bundles.flatMap(bundle => bundle.archives.flatMap(archive => archive.parts.map(part => ({ bundle, archive, part }))));
  status.totalParts = parts.length;
  const cache = new Map<number, SealedBackup>();
  // At most 8 MiB retained across passes plus an 8 MiB UTF-16 batch window.
  const batchCache = new Map<number, SealedBackup>();
  let cacheSize = 0;
  const read = async (index: number) => {
    const { bundle, archive, part } = parts[index]!;
    if (!cache.has(index) && !batchCache.has(index)) {
      batchCache.clear();
      const wanted: number[] = [];
      const ids = new Set<string>();
      for (let next = index; next < parts.length && wanted.length < 20; next++) {
        const candidate = parts[next]!;
        if (candidate.archive.id !== archive.id || candidate.archive.token !== archive.token) break;
        if (cache.has(next) || ids.has(candidate.part.id)) continue;
        wanted.push(next); ids.add(candidate.part.id);
      }
      const result = await request<{ parts: { id: string; sealed: SealedBackup }[] }>(
        `/api/history-archives/${archive.id}/batch?parts=${[...ids].join(',')}`, archive.token, signal, undefined, onWait);
      if (!result || !Array.isArray(result.parts) || !result.parts.length || result.parts.length > wanted.length ||
        JSON.stringify(result).length > 4 * 1024 * 1024 || result.parts.some((item, offset) => !item ||
          item.id !== parts[wanted[offset]!]!.part.id || typeof item.sealed?.iv !== 'string' || typeof item.sealed.ciphertext !== 'string')) {
        throw new Error('历史备份批量响应不正确');
      }
      result.parts.forEach((item, offset) => batchCache.set(wanted[offset]!, item.sealed));
    }
    const sealed = cache.get(index) ?? batchCache.get(index)!;
    batchCache.delete(index);
    signal.throwIfAborted();
    if (await backupDigest(sealed) !== part.digest) throw new Error('历史备份完整性验证失败');
    const messages = validateArchivePart(await openJson(sealed, archive.key, archiveAad(bundle.roomId, archive.id, part.id)), bundle.roomId, part);
    if (!cache.has(index) && cacheSize + sealed.ciphertext.length * 2 <= 8 * 1024 * 1024) {
      cache.set(index, sealed); cacheSize += sealed.ciphertext.length * 2;
    }
    return messages;
  };
  // Keep only identities and hashes, not plaintext history, across the discovery pass.
  const seen = new Map<number, { digest: string; chat: boolean; gallery: boolean }>();
  const messageIds = new Map<string, number>();
  const deletes: DecryptedMessage[] = [];
  const missingParts = new Set<number>();
  const expected = new Map<number, RestoreAuditRecord>();
  const imported = new Set<number>();
  const committed = (changed: boolean, messages: readonly DecryptedMessage[]) => {
    status.changed ||= changed;
    for (const message of messages) imported.add(message.seq);
  };
  const scope = creator ? 'all' : 'chat';
  try {
    for (let index = 0; index < parts.length; index++) {
      const messages = await read(index);
      const missing = new Set((await findMissingArchivedMessages(session, messages, scope, signal)).map(message => message.seq));
      if (missing.size) missingParts.add(index);
      for (const message of messages) {
        const digest = await historyRecordDigest(message);
        const existing = seen.get(message.seq);
        if (existing && existing.digest !== digest || messageIds.has(message.clientMsgId) && messageIds.get(message.clientMsgId) !== message.seq) throw new Error('多个备份中的历史记录冲突');
        if (existing) continue;
        messageIds.set(message.clientMsgId, message.seq);
        const chat = missing.has(message.seq) && ['text', 'image', 'image-album', 'audio', 'file'].includes(message.payload.kind);
        const gallery = missing.has(message.seq) && creator && isGalleryMediaPayload(message.payload);
        seen.set(message.seq, { digest, chat, gallery });
        if (creator || !['gallery-image', 'gallery-file'].includes(message.payload.kind)) {
          const record = { digest, missing: missing.has(message.seq),
            chat: ['text', 'image', 'image-album', 'audio', 'file'].includes(message.payload.kind),
            gallery: creator && isGalleryMediaPayload(message.payload) };
          expected.set(message.seq, record);
          for (const kind of ['chat', 'gallery'] as const) if (record[kind] && status.inventory![kind]) {
            status.inventory![kind]!.backup++;
            if (!record.missing) status.inventory![kind]!.existing++;
          }
        }
        if (chat) status.chat.total++;
        if (gallery) status.gallery!.total++;
        if (message.payload.kind === 'message-delete') deletes.push(message);
      }
      status.scannedParts = index + 1; emit();
    }
    signal.throwIfAborted();
    status.phase = 'restoring'; status.percent = 0; emit();
    if (creator) status.changed = await restoreGalleryHidden(session, [...hidden.values()], signal);
    for (let index = 0; index < deletes.length; index += 100) await importArchivedMessages(session, deletes.slice(index, index + 100), scope, signal, committed);
    const processed = new Set<number>();
    for (let index = 0; index < parts.length; index++) {
      if (!missingParts.has(index)) { cache.delete(index); continue; }
      const messages = await read(index);
      await importArchivedMessages(session, messages, scope, signal, committed);
      for (const message of messages) {
        if (processed.has(message.seq)) continue;
        processed.add(message.seq);
        const item = seen.get(message.seq)!;
        if (item.chat) status.chat.restored++;
        if (item.gallery) status.gallery!.restored++;
      }
      // Internal events still need to finish even if the content counts are full.
      const total = status.chat.total + (status.gallery?.total ?? 0);
      const restored = status.chat.restored + (status.gallery?.restored ?? 0);
      status.percent = total ? Math.min(99, Math.floor(restored / total * 100)) : 0; emit();
      cache.delete(index);
    }
    status.phase = 'verifying'; status.percent = 99; emit();
    status.audit = await auditRestoredHistory(session, expected, imported, signal);
    status.phase = 'complete'; status.percent = 100; emit();
    return status;
  } finally { cache.clear(); batchCache.clear(); seen.clear(); messageIds.clear(); missingParts.clear(); expected.clear(); imported.clear(); deletes.length = 0; }
}
