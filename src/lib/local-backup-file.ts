import type { ArchiveSink } from './local-archive';

export const MEMORY_BACKUP_LIMIT = 64 * 1024 * 1024;
type BackupFile = { sink: ArchiveSink; finish: () => Promise<File>; handoff: () => void; dispose: () => Promise<void> };

/** Bounded ciphertext only. Never buffer an unbounded archive when OPFS is unavailable. */
function memoryBackup(signal: AbortSignal): BackupFile {
  let parts: Blob[] = [], size = 0, closed = false, disposed = false;
  const dispose = async () => {
    disposed = true;
    signal.removeEventListener('abort', abort);
    parts = [];
  };
  const abort = () => { void dispose(); };
  signal.addEventListener('abort', abort, { once: true });
  return {
    sink: { write: async bytes => {
      signal.throwIfAborted();
      if (closed || disposed) throw new Error('备份文件已关闭');
      if (size + bytes.byteLength > MEMORY_BACKUP_LIMIT) {
        await dispose();
        throw new Error('此浏览器的临时文件存储不可用，当前备份超过 64 MiB 备用上限。请恢复浏览器存储后重试。');
      }
      parts.push(new Blob([bytes])); size += bytes.byteLength;
    } },
    finish: async () => {
      signal.throwIfAborted();
      if (closed || disposed) throw new Error('备份文件已关闭');
      closed = true;
      const file = new File(parts, 'backup.qrlocal', { type: 'application/octet-stream' });
      parts = [];
      return file;
    },
    handoff: () => {
      if (!closed || disposed) throw new Error('备份文件尚未完成');
      signal.removeEventListener('abort', abort);
    },
    dispose,
  };
}

/** OPFS contains only encrypted temporary output, never a completed external backup. */
export async function createLocalBackupFile(signal: AbortSignal): Promise<BackupFile> {
  signal.throwIfAborted();
  if (!navigator.storage?.getDirectory) return memoryBackup(signal);
  let root: FileSystemDirectoryHandle;
  try { root = await navigator.storage.getDirectory(); }
  catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof Error && ['UnknownError', 'NotSupportedError', 'SecurityError'].includes(cause.name)) return memoryBackup(signal);
    throw cause;
  }
  const name = `quiet-room-export-${crypto.randomUUID()}.qrlocal`;
  let writer: FileSystemWritableFileStream | null = null;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', abort);
    if (writer) await writer.abort().catch(() => undefined);
    writer = null;
    await root.removeEntry(name).catch(() => undefined);
  };
  const abort = () => { void dispose(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const handle = await root.getFileHandle(name, { create: true });
    writer = await handle.createWritable();
    if (disposed || signal.aborted) { await writer.abort(); writer = null; signal.throwIfAborted(); }
    return {
      sink: { write: async bytes => {
        signal.throwIfAborted();
        if (!writer || disposed) throw new Error('备份文件已关闭');
        await writer.write(bytes);
      } },
      finish: async () => {
        signal.throwIfAborted();
        if (!writer || disposed) throw new Error('备份文件已关闭');
        await writer.close(); writer = null;
        signal.throwIfAborted();
        return handle.getFile();
      },
      handoff: () => {
        if (writer || disposed) throw new Error('备份文件尚未完成');
        // Native saving may blur/lock the app. Keep this ciphertext file valid
        // briefly while the OS reads it; no plaintext or key is retained here.
        signal.removeEventListener('abort', abort);
        window.setTimeout(() => { void dispose(); }, 120_000);
      },
      dispose,
    };
  } catch (cause) {
    await dispose();
    signal.throwIfAborted();
    if (cause instanceof Error && ['UnknownError', 'NotSupportedError', 'TypeError'].includes(cause.name)) return memoryBackup(signal);
    throw cause;
  }
}
