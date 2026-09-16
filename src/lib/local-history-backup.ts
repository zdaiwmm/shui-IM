import { createSHA256 } from 'hash-wasm';
import { fromBase64Url } from './base64';
import { canonicalStringify } from './canonical';
import { normalizeGalleryCurationRecords } from './gallery-curation';
import { isMessagePayload } from './message-payload';
import { readLocalArchive, writeLocalArchive, type ArchiveRecord, type ArchiveSink } from './local-archive';
import { findMissingArchivedMessages, importArchivedMessages, loadCachedMediaChunk, loadHistoryPageAfter,
  loadUiPreferences, restoreGalleryHidden, saveUiPreferences, saveCachedMediaChunk, type VaultSession } from './vault';
import type { DecryptedMessage, ImageManifest, MessagePayload } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const PREFIX_SIZE = 48;
const MAX_MESSAGES = 100_000;
export type LocalHistorySummary = { messages: number; attachments: number; missingAttachments: number; imported: number };
const emptySummary = (): LocalHistorySummary => ({ messages: 0, attachments: 0, missingAttachments: 0, imported: 0 });
const jsonRecord = (type: number, value: unknown): ArchiveRecord => ({ type, bytes: encoder.encode(JSON.stringify(value)) });

function attachments(payload: MessagePayload): ImageManifest[] {
  if ('images' in payload) return payload.images;
  if ('image' in payload) return [payload.image];
  if ('file' in payload) return [payload.file];
  if ('audio' in payload) return [payload.audio];
  return [];
}

/** Only a device's own retained archive lineage supplies these keys. Ordinary device linking does not. */
function ownArchives(session: VaultSession) {
  if (!session.vault.backup?.syncedAt || session.vault.backup.replaces || session.vault.recoverySource) {
    throw new Error('请先完成恢复码准备，再备份或导入聊天记录');
  }
  return session.vault.backup.archives;
}

async function attachmentVerifier(manifest: ImageManifest) {
  const key = await crypto.subtle.importKey('raw', fromBase64Url(manifest.key), 'AES-GCM', false, ['decrypt']);
  const hash = await createSHA256(); hash.init();
  return {
    async chunk(index: number, ciphertext: ArrayBuffer) {
      const size = Math.min(manifest.chunkSize, manifest.originalSize - index * manifest.chunkSize);
      if (ciphertext.byteLength !== size + 16) throw new Error('聊天备份附件分块长度不正确');
      const iv = new Uint8Array(12); iv.set(fromBase64Url(manifest.ivPrefix));
      new DataView(iv.buffer).setUint32(8, index);
      const aad = encoder.encode(canonicalStringify({ v: 1, blobId: manifest.blobId, index,
        chunkCount: manifest.chunkCount, originalSize: manifest.originalSize }));
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext));
      try { hash.update(plaintext); } finally { plaintext.fill(0); }
    },
    finish() { if (hash.digest('hex') !== manifest.sha256) throw new Error('聊天备份附件完整性校验失败'); },
  };
}

/** No fetch: an export includes complete locally cached originals, and counts missing originals explicitly. */
export async function exportLocalHistory(session: VaultSession, sink: ArchiveSink, signal: AbortSignal,
  progress: (summary: LocalHistorySummary) => void = () => undefined): Promise<LocalHistorySummary> {
  const archive = ownArchives(session)[0];
  if (!archive) throw new Error('恢复码尚未准备完成');
  const summary = emptySummary();
  const upperSeq = session.vault.lastSeq;
  const preferences = await loadUiPreferences(session);
  const hiddenChatMessageIds = preferences.hiddenChatMessageIds ?? [];
  const galleryHidden = session.vault.role === 'creator'
    ? (preferences.galleryCuration ?? []).filter(record => record.hidden).map(record => ({ ...record, pinnedAt: null })) : [];
  const metadata = { v: 1, roomId: session.vault.roomId, role: session.vault.role, archiveId: archive.id,
    sourceDeviceId: session.vault.identity.publicBundle.deviceId, createdAt: new Date().toISOString(), upperSeq, hiddenChatMessageIds, galleryHidden };
  async function* records(): AsyncGenerator<ArchiveRecord> {
    yield jsonRecord(1, metadata);
    let afterSeq = 0;
    while (afterSeq < upperSeq) {
      signal.throwIfAborted();
      const page = await loadHistoryPageAfter(session, { afterSeq, limit: 50, strict: true, signal });
      if (!page.length) break;
      for (const message of page) {
        afterSeq = message.seq;
        if (message.seq > upperSeq) break;
        if (message.payload.kind === 'gallery-image' || message.payload.kind === 'gallery-file') continue;
        if (++summary.messages > MAX_MESSAGES) throw new Error('聊天记录超过本版备份上限');
        yield jsonRecord(2, message);
        for (const manifest of attachments(message.payload)) {
          let available = true;
          for (let index = 0; index < manifest.chunkCount; index++) {
            signal.throwIfAborted();
            const size = Math.min(manifest.chunkSize, manifest.originalSize - index * manifest.chunkSize) + 16;
            if (!await loadCachedMediaChunk(session, manifest.blobId, index, size)) { available = false; break; }
          }
          yield { type: 3, bytes: new Uint8Array([available ? 1 : 0]) };
          if (!available) { summary.missingAttachments++; continue; }
          const verify = await attachmentVerifier(manifest);
          for (let index = 0; index < manifest.chunkCount; index++) {
            signal.throwIfAborted();
            const size = Math.min(manifest.chunkSize, manifest.originalSize - index * manifest.chunkSize) + 16;
            const chunk = await loadCachedMediaChunk(session, manifest.blobId, index, size);
            if (!chunk) throw new Error('附件缓存已变化，请重新导出');
            await verify.chunk(index, chunk);
            yield { type: 4, bytes: new Uint8Array(chunk) };
          }
          verify.finish(); summary.attachments++;
        }
        progress({ ...summary });
      }
    }
  }
  await sink.write(encoder.encode(`QRL1${archive.id}\n`));
  await writeLocalArchive(archive.key, records(), sink, signal);
  return summary;
}

/** Pass 1 validates the entire file and local conflicts; pass 2 applies deletion events; pass 3 imports. */
export async function importLocalHistory(session: VaultSession, file: Blob, signal: AbortSignal,
  progress: (stage: 'verifying' | 'importing', summary: LocalHistorySummary) => void = () => undefined): Promise<LocalHistorySummary> {
  const prefix = decoder.decode(await file.slice(0, PREFIX_SIZE).arrayBuffer());
  if (!/^QRL1[A-Za-z0-9_-]{43}\n$/.test(prefix)) throw new Error('请选择有效的聊天备份文件');
  const archive = ownArchives(session).find(item => item.id === prefix.slice(4, 47));
  if (!archive) throw new Error('此备份不属于本设备的恢复身份，请先恢复导出备份的本人身份');
  const body = file.slice(PREFIX_SIZE);
  let final = emptySummary();
  for (const pass of [0, 1, 2, 3]) {
    const summary = emptySummary();
    const iterator = readLocalArchive(body, archive.key, signal)[Symbol.asyncIterator]();
    async function next(type: number) {
      const item = await iterator.next();
      if (item.done || item.value.type !== type) throw new Error('聊天备份记录顺序不正确');
      return item.value.bytes;
    }
    try {
      const metadata = JSON.parse(decoder.decode(await next(1)));
      if (metadata?.v !== 1 || metadata.roomId !== session.vault.roomId || metadata.role !== session.vault.role ||
          metadata.archiveId !== archive.id || !Number.isSafeInteger(metadata.upperSeq) || metadata.upperSeq < 0 ||
          !Array.isArray(metadata.hiddenChatMessageIds) || metadata.hiddenChatMessageIds.length > 20_000 ||
          metadata.hiddenChatMessageIds.some((id: unknown) => typeof id !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
        throw new Error('聊天备份的空间或本人身份不匹配');
      }
      const hiddenGallery = normalizeGalleryCurationRecords(metadata.galleryHidden);
      if (hiddenGallery.some(record => !record.hidden || record.pinnedAt !== null) ||
          session.vault.role !== 'creator' && hiddenGallery.length) throw new Error('保险箱删除记录不正确');
      if (pass === 1) {
        signal.throwIfAborted();
        const preferences = await loadUiPreferences(session);
        const hiddenChatMessageIds = [...new Set<string>([...(preferences.hiddenChatMessageIds ?? []), ...metadata.hiddenChatMessageIds])];
        if (hiddenChatMessageIds.length > 20_000) throw new Error('本机删除记录超过上限');
        await saveUiPreferences(session, { ...preferences, hiddenChatMessageIds });
        await restoreGalleryHidden(session, hiddenGallery, signal);
      }
      let previousSeq = 0;
      while (true) {
        const record = await iterator.next();
        if (record.done) break;
        if (record.value.type !== 2) throw new Error('聊天备份记录顺序不正确');
        const message = JSON.parse(decoder.decode(record.value.bytes)) as DecryptedMessage;
        if (!message || !isMessagePayload(message.payload) || !Number.isSafeInteger(message.seq) ||
            message.seq <= previousSeq || message.seq > metadata.upperSeq ||
            typeof message.clientMsgId !== 'string' || typeof message.senderId !== 'string' || typeof message.acceptedAt !== 'string' ||
            message.payload.kind === 'gallery-image' || message.payload.kind === 'gallery-file') throw new Error('聊天备份记录不正确');
        previousSeq = message.seq;
        if (++summary.messages > MAX_MESSAGES) throw new Error('聊天记录超过本版导入上限');
        if (pass === 0) await findMissingArchivedMessages(session, [message], 'chat', signal);
        if (pass === 3 && (await findMissingArchivedMessages(session, [message], 'chat', signal)).length) {
          throw new Error('导入后的本机记录未通过回读核验，请重试');
        }
        for (const manifest of attachments(message.payload)) {
          const status = await next(3);
          if (status.length !== 1 || status[0]! > 1) throw new Error('附件状态不正确');
          if (!status[0]) { summary.missingAttachments++; continue; }
          const verify = await attachmentVerifier(manifest);
          for (let index = 0; index < manifest.chunkCount; index++) {
            const bytes = await next(4);
            if (pass === 3) {
              const stored = await loadCachedMediaChunk(session, manifest.blobId, index, bytes.length);
              if (!stored) throw new Error('导入后的附件未通过回读核验，请重试');
              await verify.chunk(index, stored);
            } else await verify.chunk(index, bytes.buffer);
            if (pass === 2) {
              signal.throwIfAborted();
              await saveCachedMediaChunk(session, manifest.blobId, index, bytes.buffer);
            }
          }
          verify.finish(); summary.attachments++;
        }
        if (pass === 1 && message.payload.kind === 'message-delete' || pass === 2) {
          summary.imported += await importArchivedMessages(session, [message], 'chat', signal);
        }
        progress(pass === 0 || pass === 3 ? 'verifying' : 'importing', { ...summary });
      }
      if (pass === 2) final = summary;
    } finally { await iterator.return(undefined); }
  }
  signal.throwIfAborted();
  return final;
}
