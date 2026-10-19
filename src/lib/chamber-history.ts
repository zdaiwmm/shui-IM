import { sha256 } from '@noble/hashes/sha2.js';
import {canonicalStringify} from './canonical';
import {galleryCurationKey,normalizeGalleryCurationRecords,type GalleryCurationRecord} from './gallery-curation';
import { authorizedFetch, fetchBlobChunk, ApiError } from './api';
import { randomBase64Url, toBase64Url } from './base64';
import { attachmentVerifier } from './local-history-backup';
import { loadCachedMediaChunk, loadChamberHistoryPageAfter, loadUiPreferences, saveVault, withVaultMutation, type VaultSession } from './vault';
import { sealChamberHistoryRecord, createChamberHistoryHead, type ChamberHistoryRecord, type ChamberHistoryHead, type ChamberHistoryHeadReference } from './chamber-history-record';
import type { DecryptedMessage, ImageManifest } from './types';

type Chunk = { blobId: string; index: number; size: number; digest: string };
type Reference = { blobId: string; index: number; unitId: string };
export type ChamberBackupState = { v: 1; cursor: number; revision: number; syncedAt?: string; paused?: string;
  metadataHash?:string;
  head?: ChamberHistoryHeadReference;
  batch?: { afterSeq: number; upperSeq: number; messages: DecryptedMessage[]; omittedSafe?:number[]; chunks: Chunk[]; references: Reference[];
    metadata:{hash:string;hiddenChatMessageIds:string[];galleryHidden:GalleryCurationRecord[];units:string[]} };
  pending?: { record: ChamberHistoryRecord; chunk?: Chunk; head?: ChamberHistoryHead; preference?:boolean };
};
const manifests = (message: DecryptedMessage): ImageManifest[] => {
  const payload = message.payload;
  return 'images' in payload ? payload.images : 'image' in payload ? [payload.image] :
    'file' in payload ? [payload.file] : 'audio' in payload ? [payload.audio] : [];
};
async function sourceChunk(session:VaultSession,blobId:string,index:number,size:number,signal:AbortSignal):Promise<ArrayBuffer> {
  signal.throwIfAborted();
  const cached=await loadCachedMediaChunk(session,blobId,index,size);
  if(cached)return cached;
  try {
    // Originals uploaded by this authorized device need not already be in the
    // optional display cache. Stream one ciphertext chunk, never a full file.
    const raw=await fetchBlobChunk(session.vault.roomId,session.vault.accessToken,blobId,index,AbortSignal.any([signal,AbortSignal.timeout(30_000)]));
    if(raw.byteLength!==size)throw new Error('历史备份暂停：原文件分块长度不正确');
    return raw;
  }catch(cause){
    if(cause instanceof ApiError&&[403,404,410].includes(cause.status))throw new Error('历史备份暂停：部分原文件缺失或不可读取，请先补齐原文件');
    throw cause;
  }
}
async function update(session: VaultSession, signal: AbortSignal, operation: (state: ChamberBackupState) => void): Promise<void> {
  await withVaultMutation(session, async mutation => {
    signal.throwIfAborted();
    const before = session.vault.chamberBackup;
    const state: ChamberBackupState = structuredClone(before ?? { v: 1, cursor: session.vault.historyUnavailableBeforeSeq ?? 0, revision: 0 });
    operation(state); session.vault.chamberBackup = state;
    try { await saveVault(session, mutation); } catch (cause) { session.vault.chamberBackup = before; throw cause; }
  });
}
async function snapshot(session: VaultSession, signal: AbortSignal): Promise<ChamberBackupState['batch']> {
  const after = session.vault.chamberBackup?.cursor ?? session.vault.historyUnavailableBeforeSeq ?? 0;
  const preferences=await loadUiPreferences(session),hiddenChatMessageIds=preferences.hiddenChatMessageIds??[];
  const hidden=session.vault.role==='creator'?new Map([...(session.vault.recoverySource?.galleryHidden??[]),...(session.vault.backup?.galleryHidden??[]),...(preferences.galleryCuration??[])].filter(record=>record.hidden).map(record=>[galleryCurationKey(record),{...record,pinnedAt:null}])):new Map<string,GalleryCurationRecord>();
  if(hidden.size>20_000)throw new Error('历史备份暂停：保险箱删除标记超过上限，已保留先前备份');
  const galleryHidden=normalizeGalleryCurationRecords([...hidden.values()]);
  const metadataHash=toBase64Url(sha256(new TextEncoder().encode(canonicalStringify({hiddenChatMessageIds,galleryHidden}))));
  const messages = await loadChamberHistoryPageAfter(session,after,signal);
  if (!messages.length) {
    if (after < session.vault.lastSeq) throw new Error('历史备份暂停：部分聊天内容缺失，请先补齐或恢复');
    if(session.vault.chamberBackup?.head&&session.vault.chamberBackup.metadataHash===metadataHash)return undefined;
  }
  let expected = after + 1;
  for (const message of messages) {
    if (message.seq !== expected++) throw new Error('历史备份暂停：部分聊天内容缺失，请先补齐或恢复');
  }
  const unique = new Map<string, ImageManifest>();
  // A joiner's old MLS cache can include creator-only Safe rows. Preserve only
  // their sequence coverage; never put Safe manifests or data into its backup.
  const safe=(message:DecryptedMessage)=>['gallery-image','gallery-file'].includes(message.payload.kind);
  const visible=session.vault.role==='creator'?messages:messages.filter(message=>!safe(message));
  const omittedSafe=session.vault.role==='creator'?[]:messages.filter(safe).map(message=>message.seq);
  visible.forEach(message => manifests(message).forEach(manifest => unique.set(manifest.blobId, manifest)));
  const chunks: Chunk[] = [];
  for (const manifest of unique.values()) {
    const verifier = await attachmentVerifier(manifest);
    for (let index = 0; index < manifest.chunkCount; index++) {
      signal.throwIfAborted();
      const size = Math.min(manifest.chunkSize, manifest.originalSize - index * manifest.chunkSize) + 16;
      const chunk = await sourceChunk(session, manifest.blobId, index, size, signal);
      try { await verifier.chunk(index, chunk); }
      catch { throw new Error('历史备份暂停：原文件完整性校验失败'); }
      chunks.push({ blobId: manifest.blobId, index, size, digest: toBase64Url(sha256(new Uint8Array(chunk))) });
    }
    try { verifier.finish(); } catch { throw new Error('历史备份暂停：原文件完整性校验失败'); }
  }
  // Only chat rows and data-key-bearing attachment manifests are serialized; never a Vault.
  const rows = visible.map(({ seq, clientMsgId, senderId, payload, acceptedAt, status }) => ({ seq, clientMsgId, senderId, payload, acceptedAt, status }));
  return { afterSeq: after, upperSeq: messages.at(-1)?.seq??after, messages: rows,...(omittedSafe.length?{omittedSafe}:{}), chunks, references: [],metadata:{hash:metadataHash,hiddenChatMessageIds,galleryHidden,units:[]} };
}

/** Upload at most ten immutable units per foreground pass; pending ciphertext is durable before network I/O. */
export async function syncChamberHistory(session: VaultSession, signal: AbortSignal, force: boolean): Promise<void> {
  const binding = session.vault.personalBinding;
  const peer = session.vault.personalPeers?.find(item => item.identity.id !== binding?.identity.id)?.identity;
  if (!binding || !peer || session.vault.pairingState !== 'ready' || session.vault.mls?.phase !== 'active') return;
  if (session.vault.chamberBackup?.paused && !force) throw new Error(session.vault.chamberBackup.paused);
  try {
    if (force && session.vault.chamberBackup?.paused) await update(session, signal, state => { delete state.paused; });
    for (let units = 0; units < 10; units++) {
      signal.throwIfAborted();
      if (!session.vault.chamberBackup?.batch && !session.vault.chamberBackup?.pending) {
        const batch = await snapshot(session, signal);
        if (!batch) return;
        await update(session, signal, state => { state.batch = batch; });
      }
      const state = session.vault.chamberBackup!, batch = state.batch!;
      if (!state.pending) {
        const chunk = batch.chunks[batch.references.length];
        const index=batch.metadata.units.length,preference=!chunk&&index<Math.ceil(Math.max(batch.metadata.hiddenChatMessageIds.length,batch.metadata.galleryHidden.length)/1000);
        let payload: Parameters<typeof sealChamberHistoryRecord>[0];
        if (chunk) {
          const raw = await sourceChunk(session, chunk.blobId, chunk.index, chunk.size, signal);
          if (toBase64Url(sha256(new Uint8Array(raw))) !== chunk.digest) throw new Error('历史备份暂停：原文件缺失或完整性校验失败');
          payload = { v: 1, kind: 'attachment', roomId: session.vault.roomId, ownerId: binding.identity.id,
            blobId: chunk.blobId, index: chunk.index, bytes: toBase64Url(raw) };
        } else if(preference)payload={v:1,kind:'preferences',roomId:session.vault.roomId,ownerId:binding.identity.id,
          hiddenChatMessageIds:batch.metadata.hiddenChatMessageIds.slice(index*1000,(index+1)*1000),galleryHidden:batch.metadata.galleryHidden.slice(index*1000,(index+1)*1000)};
        else payload = { v: 1, kind: 'messages', roomId: session.vault.roomId, ownerId: binding.identity.id,
          afterSeq: batch.afterSeq, upperSeq: batch.upperSeq, previous: state.head ? { id: state.head.id, digest: state.head.digest } : null,
          messages: batch.messages, attachments: batch.references,preferences:batch.metadata.units,...(batch.omittedSafe?{omittedSafe:batch.omittedSafe}:{}) };
        const record = await sealChamberHistoryRecord(payload, randomBase64Url(32), state.revision + 1, peer, session.vault.identity, binding);
        const head = chunk||preference ? undefined : await createChamberHistoryHead(record, batch.afterSeq, batch.upperSeq, session.vault.identity, binding);
        await update(session, signal, next => { next.revision = record.revision; next.pending = { record, ...(chunk ? { chunk } : {}), ...(head ? { head } : {}),...(preference?{preference:true}:{}) }; });
      }
      const pending = session.vault.chamberBackup!.pending!;
      await authorizedFetch(`/api/rooms/${session.vault.roomId}/chamber-history/${pending.record.id}`, session.vault.accessToken, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.record),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (pending.head) await authorizedFetch(`/api/rooms/${session.vault.roomId}/chamber-history-heads`, session.vault.accessToken, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending.head), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      await update(session, signal, next => {
        if (next.pending?.record.id !== pending.record.id || !next.batch) throw new Error('历史备份状态已改变');
        if (pending.chunk) next.batch.references.push({ blobId: pending.chunk.blobId, index: pending.chunk.index, unitId: pending.record.id });
        else if(pending.preference)next.batch.metadata.units.push(pending.record.id);
        else { next.cursor = next.batch.upperSeq; next.metadataHash=next.batch.metadata.hash; next.head = pending.head!.head; next.syncedAt = new Date().toISOString(); delete next.batch; }
        delete next.pending;
      });
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : '';
    if (!signal.aborted && (message.startsWith('历史备份暂停：') || code === 'BACKUP_QUOTA' || code === 'STORAGE_QUOTA')) {
      const reason = message.startsWith('历史备份暂停：') ? message : '历史备份暂停：容量不足，已保留先前的有效备份';
      await update(session, signal, state => { state.paused = reason; });
      throw new Error(reason);
    }
    throw cause;
  }
}
