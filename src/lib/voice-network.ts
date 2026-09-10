import { boundedOperation, networkDelay, NetworkOperationError } from './network-operation';
export type VoiceFailureCode = 'VOICE_CONNECT_FAILED' | 'VOICE_UPLOAD_INTERRUPTED' | 'VOICE_ACK_UNKNOWN' | 'VOICE_DOWNLOAD_INTERRUPTED' | 'VOICE_DECRYPT_FAILED' | 'VOICE_DECODE_FAILED';
export const VOICE_FAILURE_TEXT: Record<VoiceFailureCode, string> = {
  VOICE_CONNECT_FAILED: '无法连接语音服务，请检查网络后重试',
  VOICE_UPLOAD_INTERRUPTED: '语音上传中断，点按继续上传',
  VOICE_ACK_UNKNOWN: '尚未确认语音已保存，重试将复用原消息',
  VOICE_DOWNLOAD_INTERRUPTED: '语音下载中断，点按重试',
  VOICE_DECRYPT_FAILED: '语音完整性校验或解密失败',
  VOICE_DECODE_FAILED: '此设备无法解码这条语音',
};
export class VoiceNetworkError extends NetworkOperationError {
  constructor(readonly code: VoiceFailureCode) { super(code, VOICE_FAILURE_TEXT[code]); }
}
/** Fetch cannot distinguish DNS/TCP/TLS failures: the connection code intentionally covers all three. */
export async function voiceRequest<T>(code: VoiceFailureCode, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try { return await boundedOperation(operation, 20_000, code, signal); }
    catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      const status = (error as { status?: number })?.status;
      const retryable = error instanceof TypeError || error instanceof NetworkOperationError || status === 429 || (typeof status === 'number' && status >= 500);
      if (!retryable) throw error;
      if (attempt >= 3) throw new VoiceNetworkError(code);
      await networkDelay([250, 500, 1000][attempt]!, signal);
    }
  }
}

/** Losing the completion response must reconcile the original blob, never allocate a replacement. */
export async function confirmVoiceUpload(complete: (signal: AbortSignal) => Promise<void>, status: (signal: AbortSignal) => Promise<{ completed: boolean }>, signal?: AbortSignal) {
  return voiceRequest('VOICE_ACK_UNKNOWN', async attemptSignal => {
    try { await complete(attemptSignal); }
    catch (error) {
      attemptSignal.throwIfAborted();
      const httpStatus = (error as { status?: number })?.status;
      if (typeof httpStatus === 'number' && httpStatus !== 429 && httpStatus < 500) throw error;
      if ((await status(attemptSignal)).completed) return;
      throw error;
    }
  }, signal);
}
