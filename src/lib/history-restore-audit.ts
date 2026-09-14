import { canonicalStringify } from './canonical';
import { toBase64Url } from './base64';
import { galleryCurationKey } from './gallery-curation';
import { reduceMessageDeletions } from './message-deletions';
import { isVideoFile } from './video-media';
import { loadHistoryPageAfter, loadMessageEventHistory, loadUiPreferences, withVaultMutation, type VaultSession } from './vault';
import type { DecryptedMessage } from './types';

export type RestoreAuditRecord = { digest: string; chat: boolean; gallery: boolean; missing: boolean };
export type RestoreAuditCount = {
  backup: number; existing: number; imported: number; visible: number; hidden: number; available: number;
  from?: string; to?: string;
};
export type RestoreAudit = { chat: RestoreAuditCount; gallery?: RestoreAuditCount };
export async function historyRecordDigest(message: DecryptedMessage): Promise<string> {
  return toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalStringify({
    seq: message.seq, clientMsgId: message.clientMsgId, senderId: message.senderId, acceptedAt: message.acceptedAt, payload: message.payload,
  }))));
}

/** Read back through the same local readers and deletion reducer as chat/Safe.
 * Hold the vault mutation lock so writes cannot invalidate the verification snapshot.
 * Only counts and date ranges escape; record comparisons use bounded pages.
 */
export async function auditRestoredHistory(session: VaultSession, expected: ReadonlyMap<number, RestoreAuditRecord>,
  imported: ReadonlySet<number>, signal: AbortSignal): Promise<RestoreAudit> {
  return withVaultMutation(session, async () => {
    signal.throwIfAborted();
    const count = (): RestoreAuditCount => ({ backup: 0, existing: 0, imported: 0, visible: 0, hidden: 0, available: 0 });
    const result: RestoreAudit = { chat: count(), ...(session.vault.role === 'creator' ? { gallery: count() } : {}) };
    const events = await loadMessageEventHistory(session, { signal });
    const preferences = await loadUiPreferences(session);
    const hiddenChat = new Set(preferences.hiddenChatMessageIds ?? []);
    const hiddenSafe = new Set((preferences.galleryCuration ?? []).filter(item => item.hidden).map(galleryCurationKey));
    const roles = new Map(session.vault.members.map(member => [member.deviceId, member.role]));
    let first = Number.MAX_SAFE_INTEGER, last = 0;
    const verified = new Set<number>();
    for (const seq of expected.keys()) { first = Math.min(first, seq); last = Math.max(last, seq); }
    let afterSeq = first - 1;
    while (afterSeq < last) {
      const page = await loadHistoryPageAfter(session, { afterSeq, limit: 200, signal, strict: true });
      if (!page.length) break;
      const deleted = reduceMessageDeletions([...events, ...page], roles);
      for (const message of page) {
        const plan = expected.get(message.seq);
        if (!plan) continue;
        if (verified.has(message.seq) || await historyRecordDigest(message) !== plan.digest) throw new Error('恢复后的本机记录与备份不一致，请重试核验');
        verified.add(message.seq);
        for (const kind of ['chat', 'gallery'] as const) {
          if (!plan[kind] || !result[kind]) continue;
          const row = result[kind]!;
          row.backup++; if (!plan.missing) row.existing++;
          let visible = !deleted.has(message.clientMsgId);
          if (kind === 'chat') visible &&= !hiddenChat.has(message.clientMsgId.toLowerCase());
          else {
            const payload = message.payload;
            const category = (payload.kind === 'file' || payload.kind === 'gallery-file') && !isVideoFile(payload.file) ? 'files' : 'images';
            const assets = payload.kind === 'image-album' ? payload.images.length : 1;
            visible &&= Array.from({ length: assets }, (_, assetIndex) => galleryCurationKey({ category, clientMsgId: message.clientMsgId, assetIndex }))
              .some(key => !hiddenSafe.has(key));
          }
          if (visible) row.available++;
          if (!imported.has(message.seq)) continue;
          row.imported++;
          if (!visible) { row.hidden++; continue; }
          row.visible++;
          const date = message.payload.sentAt;
          if (!row.from || Date.parse(date) < Date.parse(row.from)) row.from = date;
          if (!row.to || Date.parse(date) > Date.parse(row.to)) row.to = date;
        }
      }
      afterSeq = page.at(-1)!.seq;
    }
    signal.throwIfAborted();
    if (verified.size !== expected.size) throw new Error('恢复后的记录未能全部从本机读回，请重试；已写入内容会保留');
    return result;
  });
}
