import type { ArchiveSink } from './local-archive';

/** OPFS contains only encrypted temporary output, never a completed external backup. */
export async function createLocalBackupFile(signal: AbortSignal): Promise<{
  sink: ArchiveSink; finish: () => Promise<File>; handoff: () => void; dispose: () => Promise<void>;
}> {
  if (!navigator.storage?.getDirectory) throw new Error('此浏览器不支持大文件本机备份，请使用支持本机文件存储的新版浏览器');
  const root = await navigator.storage.getDirectory();
  const name = `quiet-room-export-${crypto.randomUUID()}.qrlocal`;
  const handle = await root.getFileHandle(name, { create: true });
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
  } catch (cause) { await dispose(); throw cause; }
}
