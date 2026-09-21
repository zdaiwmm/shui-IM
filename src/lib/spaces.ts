import type { MessagePayload } from './types';
import { isExpressionPayload } from './expression-media';
import { isVideoFile } from './video-media';
import type { UnreadObserver } from './unread-counter';
import { fromBase64Url, toBase64Url } from './base64';
import { newRecoveryCode, openJson, sealJson } from './backup-crypto';
import type { SealedBackup } from './backup-types';
import { localSpaceExists, readLocalSpaceDirectory, saveVault, vaultSpaceId, withVaultMutation, writeLocalSpaceDirectory, type VaultSession } from './vault';

export type PrivateSpace = {
  roomId: string; name: string; localId?: string; code?: string; waiting?: boolean;
  /** Local encrypted directory only. Never part of a recoverable directory. */
  preview?: string; previewDeviceId?: string; observer?: UnreadObserver;
  /** Ephemeral server-confirmed count used by the open drawer. */
  unread?: number;
};
export function spaceMessagePreview(payload: MessagePayload): string | undefined {
  switch (payload.kind) {
    case 'text': return payload.text.replace(/\s+/g, ' ').trim().slice(0, 160);
    case 'image': return isExpressionPayload(payload) ? '[表情]' : '[图片]';
    case 'image-album': return '[图片]';
    case 'file': return isVideoFile(payload.file) ? '[视频]' : '[文件]';
    case 'audio': return '[语音]';
    default: return undefined;
  }
}
/** Explicit allowlist: no endpoint IDs, previews or observer capabilities leave this browser. */
export function recoveryDirectoryEntries(spaces: PrivateSpace[]): PrivateSpace[] {
  return spaces.map(s => ({ roomId: s.roomId, name: s.name, ...(s.code ? { code: s.code } : {}) }));
}
export async function refreshSpaceUnread(spaces: PrivateSpace[], signal: AbortSignal): Promise<void> {
  // Bound concurrency for large local collections; this endpoint only returns a number.
  const pending = [...spaces];
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pending.length && !signal.aborted) {
      const space = pending.shift()!, observer = space.observer;
      if (!observer) continue;
      try {
        const response = await fetch(`/api/rooms/${space.roomId}/unread/${observer.deviceId}`, {
          cache: 'no-store', credentials: 'omit', headers: { Authorization: `Bearer ${observer.token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        if (signal.aborted) return;
        if (response.status === 401) { delete space.observer; delete space.unread; continue; }
        if (!response.ok) continue;
        const value = await response.json();
        if (!signal.aborted && Number.isSafeInteger(value.count) && value.count >= 0) space.unread = value.count;
      } catch { /* Offline: retain the last confirmed number. */ }
    }
  }));
}
type Directory = { v: 1; spaces: PrivateSpace[] };
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
export function newSpaceRecoveryCode(): string { return newRecoveryCode().code.replace('QR3-', 'QR4-'); }
export function spaceCodeId(code: string): string {
  if (!/^QR4-[A-Za-z0-9_-]{64}$/.test(code)) throw new Error('请输入完整的空间恢复码');
  const bytes = fromBase64Url(code.slice(4));
  if (toBase64Url(bytes) !== code.slice(4)) throw new Error('恢复码格式不正确');
  return toBase64Url(bytes.slice(0, 16));
}
export async function spaceCapability(code: string, purpose: 'fetch' | 'write' | 'encryption'): Promise<string> {
  const id = spaceCodeId(code), secret = fromBase64Url(code.slice(4)).slice(16);
  try {
    const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    return toBase64Url(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: fromBase64Url(id), info: new TextEncoder().encode(`quiet-room-spaces-${purpose}-v1`) }, key, 256));
  } finally { secret.fill(0); }
}
function validate(value: unknown): Directory {
  const data = value as Directory;
  if (data?.v !== 1 || !Array.isArray(data.spaces) || data.spaces.length > 256 || data.spaces.some(s => !uuid.test(s.roomId) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 40 || s.code !== undefined && !/^QR3-[A-Za-z0-9_-]{64}$/.test(s.code) || s.localId !== undefined && !/^[\w-]{1,80}$/.test(s.localId)) || new Set(data.spaces.map(s => s.roomId)).size !== data.spaces.length) throw new Error('空间目录不完整，已停止读取');
  if (data.spaces.some(s => s.preview !== undefined && (typeof s.preview !== 'string' || s.preview.length > 160)
    || s.previewDeviceId !== undefined && !uuid.test(s.previewDeviceId)
    || s.observer !== undefined && (!s.observer || !uuid.test(s.observer.deviceId) || !/^[A-Za-z0-9_-]{43,128}$/.test(s.observer.token)
      || !Number.isSafeInteger(s.observer.count) || s.observer.count < 0))) throw new Error('空间摘要不完整，已停止读取');
  return data;
}
export async function sealSpaceDirectory(code: string, spaces: PrivateSpace[]): Promise<SealedBackup> {
  const value = validate({ v: 1, spaces });
  return sealJson(value, await spaceCapability(code, 'encryption'), `quiet-room-spaces-v1:${spaceCodeId(code)}`);
}
export async function openSpaceDirectory(code: string, sealed: SealedBackup): Promise<PrivateSpace[]> {
  return validate(await openJson(sealed, await spaceCapability(code, 'encryption'), `quiet-room-spaces-v1:${spaceCodeId(code)}`)).spaces;
}
async function read(code: string): Promise<PrivateSpace[]> {
  const sealed = await readLocalSpaceDirectory(spaceCodeId(code));
  return sealed ? openSpaceDirectory(code, sealed as SealedBackup) : [];
}
/** Directory read/merge/write uses the vault's cross-tab lease; only ciphertext is durable. */
export async function rememberLocalSpace(session: VaultSession, inheritedCode?: string, rename?: { roomId: string; name: string }, summary?: { preview: string; observer?: UnreadObserver }): Promise<PrivateSpace[]> {
  return withVaultMutation(session, async mutation => {
    if (!session.vault.spaceRecoveryCode) {
      session.vault.spaceRecoveryCode = inheritedCode ?? newSpaceRecoveryCode();
      await saveVault(session, mutation);
    }
    const code = session.vault.spaceRecoveryCode, spaces = await read(code), vault = session.vault;
    let entry = spaces.find(s => s.roomId === vault.roomId);
    if (!entry) { entry = { roomId: vault.roomId, name: `私密空间 ${spaces.length + 1}` }; spaces.push(entry); }
    const localId = vaultSpaceId(session.stored);
    // A replaced endpoint must not inherit this browser's older endpoint preview.
    if (entry.localId && entry.localId !== localId || entry.previewDeviceId && entry.previewDeviceId !== vault.identity.publicBundle.deviceId) { delete entry.preview; delete entry.observer; }
    entry.localId = localId;
    if (summary) { entry.preview = summary.preview; entry.previewDeviceId = vault.identity.publicBundle.deviceId; entry.observer = summary.observer; }

    entry.waiting = !vault.members.some(m => m.role !== vault.role && (m.status === undefined || m.status === 'active'));
    if (vault.backup?.syncedAt && !vault.backup.replaces && !vault.recoverySource) entry.code = vault.backup.code;
    if (rename) {
      const target = spaces.find(s => s.roomId === rename.roomId);
      if (!target || !rename.name.trim() || rename.name.trim().length > 40) throw new Error('空间名称需为 1–40 个字符');
      target.name = rename.name.trim();
    }
    await writeLocalSpaceDirectory(session, spaceCodeId(code), await sealSpaceDirectory(code, spaces), mutation);
    return spaces;
  });
}
export async function localSpaces(session: VaultSession): Promise<PrivateSpace[]> {
  const spaces = await rememberLocalSpace(session);
  const present = await Promise.all(spaces.map(s => s.localId ? localSpaceExists(s.localId) : false));
  return spaces.filter((_, i) => present[i]).map(s => ({ ...s, unread: s.observer?.count }));
}
async function request(code: string, signal: AbortSignal, session?: VaultSession, value?: unknown): Promise<Response> {
  const response = await fetch(`/api/space-directories/${spaceCodeId(code)}`, { method: session ? 'PUT' : 'GET', cache: 'no-store', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: {
    Authorization: `Bearer ${session ? session.vault.accessToken : await spaceCapability(code, 'fetch')}`, ...(session ? { 'Content-Type': 'application/json' } : {}),
  }, ...(session ? { body: JSON.stringify(value) } : {}) });
  if (!response.ok && response.status !== 404 && response.status !== 409) throw new Error('空间目录备份暂不可用，请联网后重试');
  return response;
}
export async function recoverableSpaces(code: string, signal: AbortSignal): Promise<PrivateSpace[]> {
  const response = await request(code, signal);
  if (!response.ok) throw new Error('找不到此恢复码的空间，请检查恢复码是否完整');
  const data = await response.json();
  return recoveryDirectoryEntries(await openSpaceDirectory(code, data.sealed)).filter(s => s.code);
}
export async function syncSpaceDirectory(session: VaultSession, signal: AbortSignal): Promise<void> {
  await rememberLocalSpace(session);
  const code = session.vault.spaceRecoveryCode!;
  if (!session.vault.backup?.syncedAt || session.vault.backup.replaces || session.vault.recoverySource) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(code, signal);
    const remote = response.ok ? await response.json() : { revision: 0 };
    const previous = remote.sealed ? recoveryDirectoryEntries(await openSpaceDirectory(code, remote.sealed)) : [];
    // Update only this authenticated room's code. Other rooms may have rotated on another device.
    const local = await rememberLocalSpace(session);
    const current = local.find(s => s.roomId === session.vault.roomId)!;
    const spaces = previous.filter(s => s.roomId !== current.roomId);
    spaces.push({ roomId: current.roomId, name: current.name, code: current.code });
    if (JSON.stringify(previous.find(s => s.roomId === current.roomId)) === JSON.stringify(spaces.at(-1))) return;
    const result = await request(code, signal, session, { roomId: session.vault.roomId, revision: remote.revision + 1, fetchToken: await spaceCapability(code, 'fetch'), writeToken: await spaceCapability(code, 'write'), sealed: await sealSpaceDirectory(code, spaces) });
    if (result.ok) return;
  }
  throw new Error('空间目录正在其他设备更新，请稍后重试');
}
