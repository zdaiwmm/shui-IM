import { uiLiteral } from './language';
import { spaceCodeId } from './spaces';
import { parseCloudRecoveryCode } from './backup-crypto';

export const MAX_RECOVERY_CARD_BYTES = 16_384;
export type RecoveryCard = { format: 'quiet-room-recovery-card'; version: 1; recoveryCode: string };
/** A portable envelope, not a new credential or cryptographic scheme. */
export function readRecoveryCard(text: string): string {
  if (new TextEncoder().encode(text).byteLength > MAX_RECOVERY_CARD_BYTES) throw new Error(uiLiteral('文件过大，请选择恢复卡文件'));
  let code = text.trim();
  if (code.startsWith('{')) {
    let card: RecoveryCard;
    try { card = JSON.parse(code); } catch { throw new Error(uiLiteral('恢复卡文件不完整，请重新选择')); }
    if (card?.format !== 'quiet-room-recovery-card' || card.version !== 1 || typeof card.recoveryCode !== 'string') throw new Error(uiLiteral('无法识别这张恢复卡，请选择 Chamber 恢复卡'));
    code = card.recoveryCode;
  }
  if (code.startsWith('QR4-')) spaceCodeId(code);
  else if (code.startsWith('QR3-')) parseCloudRecoveryCode(code).secret.fill(0);
  else throw new Error(uiLiteral('请导入恢复卡，或粘贴完整的 QR4／QR3 恢复内容'));
  return code;
}
export function writeRecoveryCard(code: string): string {
  return JSON.stringify({ format: 'quiet-room-recovery-card', version: 1, recoveryCode: readRecoveryCard(code) } satisfies RecoveryCard, null, 2);
}
/** Native chooser invoked synchronously by a trusted click; never uploads. */
export function pickRecoveryCard(signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.qrcard,.json,.txt'; input.hidden = true;
    document.body.append(input);
    let settled = false;
    const finish = (value: string | null, cause?: unknown) => {
      if (settled) return; settled = true; input.remove(); clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (cause) reject(cause); else resolve(value);
    };
    const cancel = () => finish(null);
    const timer = window.setTimeout(cancel, 60_000);
    signal.addEventListener('abort', cancel, { once: true });
    input.addEventListener('cancel', cancel, { once: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0]; if (!file) { finish(null); return; }
      try {
        if (!file.size || file.size > MAX_RECOVERY_CARD_BYTES) throw new Error(uiLiteral('请选择 16 KB 以内的恢复卡文件'));
        const content = await file.text();
        if (!signal.aborted) finish(readRecoveryCard(content));
      } catch (cause) { finish(null, cause); }
    }, { once: true });
    input.click();
  });
}
